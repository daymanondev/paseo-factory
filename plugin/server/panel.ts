/**
 * The Project panel's server-side view-model (v0.6.0, ADR 0056 §5): the one
 * projection the workspace panel renders — a summary line, the ordered
 * Needs-you list, seat rows (Supervisor, Lead with its context bar and
 * handoff state, live Peers), the Open Design status, and — when the
 * workspace is not yet a Project — the onboarding readiness. `foldPanel` is
 * pure over its inputs (the fold-purity law view.ts keeps); the two gather
 * helpers below are the filesystem/Git probes the snapshot handler owns.
 * The client only renders what comes out; it never re-derives a state.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentView, PanelNeedsYouItem, PanelOpenDesign, PanelPeerRow, PanelSeatRow, PanelSupervisorCandidateRow, PanelTone, PanelView, ProjectView, TaskView } from "../shared/view.ts";
import { MAX_ATTEMPTS } from "./core/events.ts";
import { openDesignBundleReady, readOpenDesignLink } from "./core/open-design/open-design-link-state.ts";
import { readProjectSettings } from "./core/project-settings.ts";
import { HANDOFF_EXTRACTION_MAX_SENDS, HANDOFF_EXTRACTION_TIMEOUT_MS, LEAD_ROTATE_TOKENS } from "./handoff-limits.ts";

/**
 * How long a `handing_over` handoff may run before the panel calls it stuck:
 * every extraction send's window, times the episode's send cap, plus a minute
 * of slack — past that the runtime's own fuses should have completed it. New in
 * v0.6.0 (the spec left the threshold open; recorded in ADR 0056's review notes).
 */
export const HANDOFF_STUCK_AFTER_MS = HANDOFF_EXTRACTION_TIMEOUT_MS * HANDOFF_EXTRACTION_MAX_SENDS + 60_000;

/** The Lead rotation state machine's three durable states (ADR 0013 §5). */
type RotationState = "normal" | "rotation_pending" | "handing_over";
/** The two standing seats the panel names. */
type SeatRole = "supervisor" | "lead";
type PanelAction = PanelNeedsYouItem["action"];

/** What the Open Design probe found on disk for the Project. */
export interface PanelOpenDesignProbe {
  /** The recorded link (staged `design/open-design-link.json`, else the settings record), or null. */
  link: { projectName: string; syncedAt: string } | null;
  /** Whether the staged design bundle is ready — the sync law's own test (`openDesignBundleReady`). */
  bundlePresent: boolean;
  /** Set when the link record itself could not be read. */
  unreadable: string | null;
}

export interface PanelInput {
  /** The enriched Project the workspace resolved to, or null when no Project owns the scope. */
  project: ProjectView | null;
  /** Whether the Project has a registration — a git folder alone is not a Project. */
  registered: boolean;
  /** The raw directory the panel is scoped to (the onboarding wizard's folder), or null on the unscoped view. */
  folder: string | null;
  git: { gitRepo: boolean; hasCommits: boolean };
  tasks: readonly TaskView[];
  agents: readonly AgentView[];
  supervisor: AgentView | null;
  lead: AgentView | null;
  /** Titles of the required companion tools that are missing or incomplete. */
  missingPrerequisites: readonly string[];
  openDesign: PanelOpenDesignProbe | null;
  /** The Lead rotation state the registration records (durable even when the Lead is gone), or null when unrecorded. */
  rotationState: RotationState | null;
  /** When the current Lead handoff began (ISO 8601), from the registration. */
  handoffRequestedAt: string | null;
  /**
   * Supervisor-addressed mail waiting in `mailbox.jsonl` with no live
   * Supervisor to receive it (v0.6.1, ADR 0057 §5) — the count the
   * `no-supervisor` Needs-you item carries. 0 when none is held.
   */
  heldSupervisorMailCount: number;
  /**
   * The Project's live Supervisor candidate chats (v0.6.1, ADR 0057 §5) —
   * gathered by the snapshot against `isSupervisorCandidate` and the Project's
   * workspace. Rendered as "Use this chat as Supervisor" rows only while a
   * live Supervisor holds the seat; when the seat is vacant the auto-bind
   * door owns recovery and the fold renders none.
   */
  supervisorCandidates: readonly AgentView[];
  now: number;
}

// ---- the gather helpers ---------------------------------------------------------------------

/** Is `folder` a Git repository, and does it hold a commit — answered by Git, never by writing. */
export function inspectGitReadiness(folder: string | null): { gitRepo: boolean; hasCommits: boolean } {
  if (folder === null || !existsSync(folder)) return { gitRepo: false, hasCommits: false };
  const git = (args: string[]): boolean => {
    try {
      execFileSync("git", args, { cwd: folder, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  };
  if (!git(["rev-parse", "--git-dir"])) return { gitRepo: false, hasCommits: false };
  return { gitRepo: true, hasCommits: git(["rev-parse", "--verify", "HEAD"]) };
}

/** Reads the Project's Open Design link record and whether its staged bundle is still on disk. */
export function probeOpenDesign(stateDir: string, slug: string, root: string): PanelOpenDesignProbe {
  let link: { projectName: string; syncedAt: string } | null = null;
  try {
    const staged = readOpenDesignLink(root);
    if (staged !== undefined) link = { projectName: staged.projectName, syncedAt: staged.syncedAt };
  } catch (error) {
    return { link: null, bundlePresent: false, unreadable: error instanceof Error ? error.message : String(error) };
  }
  if (link === null) {
    try {
      const recorded = readProjectSettings(stateDir, slug).openDesignLink;
      if (recorded !== undefined) link = { projectName: recorded.projectName, syncedAt: recorded.syncedAt };
    } catch {
      // a damaged settings record is not an Open Design verdict
    }
  }
  return { link, bundlePresent: openDesignBundleReady(root), unreadable: null };
}

// ---- the fold -------------------------------------------------------------------------------

function statusOf(agent: AgentView): { label: string; tone: PanelTone } {
  if (agent.status === "error") return { label: "error", tone: "error" };
  if (agent.attentionReason === "permission") return { label: "waiting for permission", tone: "waiting" };
  if (agent.status === "running") return { label: "working", tone: "normal" };
  if (agent.status === "idle") return { label: "idle", tone: "normal" };
  if (agent.status === "initializing") return { label: "starting", tone: "normal" };
  return { label: agent.status, tone: "normal" };
}

function modelOf(agent: AgentView): string | null {
  const base = agent.model ?? agent.provider;
  if (base === "") return null;
  return agent.thinking !== undefined && agent.thinking !== null && agent.thinking !== "" ? `${base} · ${agent.thinking}` : base;
}

function handoffLabel(state: RotationState, queued: number): string {
  const mail = queued > 0 ? ` · ${queued} queued mail` : "";
  if (state === "rotation_pending") return `will hand off at the next quiet point${mail}`;
  if (state === "handing_over") return `handing over to a new Lead${mail}`;
  return "normal";
}

const seatName = (role: SeatRole): string => (role === "supervisor" ? "Supervisor" : "Lead");

/** The one "Open <seat>" action every Needs-you item that points at a live seat carries. */
function openSeatAction(role: SeatRole, agent: AgentView): PanelAction {
  return { kind: "open-agent", agentId: agent.id, label: `Open ${seatName(role)}` };
}

/** With neither seat live there is no conversation to open — the only way forward is to start the Supervisor. */
const START_SUPERVISOR_ACTION: PanelAction = { kind: "start-supervisor", label: "Start Supervisor" };

function seatRow(role: SeatRole, agent: AgentView | null): PanelSeatRow {
  if (agent === null) {
    return {
      role,
      vacant: true,
      agentId: null,
      statusLabel: "vacant",
      tone: "normal",
      model: null,
      hint: role === "supervisor" ? "No Supervisor is running." : "No Lead is running — ask your Supervisor.",
      context: null,
      handoff: null,
    };
  }
  const status = statusOf(agent);
  const row: PanelSeatRow = {
    role,
    vacant: false,
    agentId: agent.id,
    statusLabel: status.label,
    tone: status.tone,
    model: modelOf(agent),
    hint: status.tone === "error" ? (agent.lastError ?? null) : null,
    context: null,
    handoff: null,
  };
  if (role !== "lead") return row;
  const used = agent.contextUsedTokens ?? null;
  const state = agent.rotationState ?? "normal";
  const queued = agent.queuedMailCount ?? 0;
  return {
    ...row,
    context: {
      usedTokens: used,
      markTokens: LEAD_ROTATE_TOKENS,
      label: `${used === null ? "—" : `${Math.round(used / 1000)}k`} / ${Math.round(LEAD_ROTATE_TOKENS / 1000)}k`,
      fraction: used === null ? null : Math.min(1, used / LEAD_ROTATE_TOKENS),
    },
    handoff: { state, label: handoffLabel(state, queued), queuedMailCount: queued },
  };
}

/**
 * The Supervisor candidate rows (v0.6.1, ADR 0057 §5): a candidate chat only
 * carries an adopt row while a live Supervisor holds the seat — the Owner
 * chooses between them ("Use this chat as Supervisor", `factory.supervisor.adopt`).
 * With the seat vacant the auto-bind door binds the first candidate session
 * itself, so there is nothing to choose and no row renders.
 */
function supervisorCandidateRows(input: PanelInput): PanelSupervisorCandidateRow[] {
  if (input.supervisor === null) return [];
  return input.supervisorCandidates.map((agent) => {
    const status = statusOf(agent);
    return {
      agentId: agent.id,
      title: agent.title,
      statusLabel: status.label,
      tone: status.tone,
      model: modelOf(agent),
    };
  });
}

/** Live Peers: task-bound agents that are neither seat, whose Task is still open. */
function peerRows(input: PanelInput): PanelPeerRow[] {
  const taskByName = new Map(input.tasks.map((task) => [task.task, task]));
  const rows: PanelPeerRow[] = [];
  for (const agent of input.agents) {
    if (agent.seat !== null || agent.id === input.supervisor?.id || agent.id === input.lead?.id || agent.task === null) continue;
    const task = taskByName.get(agent.task);
    if (task !== undefined && (task.status === "accepted" || task.status === "closed")) continue;
    const status = statusOf(agent);
    rows.push({
      agentId: agent.id,
      task: agent.task,
      title: `Peer · ${agent.task}`,
      disposition: task?.disposition ?? "engineer",
      statusLabel: status.label,
      tone: status.tone,
      model: modelOf(agent),
    });
  }
  return rows;
}

/**
 * A seat is stuck when the daemon reports it errored or parked on a permission
 * prompt. Known limitation (ADR 0056 consequences): there is no hung-or-idle
 * detection — the snapshot carries no per-agent last-activity time, and an idle
 * Lead is legitimately idle between dispatches, so no idle-too-long rule is guessed.
 */
function seatStuckItems(role: SeatRole, agent: AgentView | null): PanelNeedsYouItem[] {
  if (agent === null) return [];
  const name = seatName(role);
  const waiting = agent.attentionReason === "permission";
  if (agent.status !== "error" && !waiting) return [];
  return [
    {
      key: `seat-stuck:${role}`,
      kind: "seat-stuck",
      title: agent.status === "error" ? `${name} errored` : `${name} is waiting on a permission prompt`,
      detail: agent.status === "error" ? (agent.lastError ?? null) : null,
      action: openSeatAction(role, agent),
    },
  ];
}

/**
 * The Owner-readable gloss of each `needs_human` reason code; an unknown code
 * passes through verbatim. The prose is new in v0.6.0 (the spec left the wording
 * open); keep it one plain sentence per code.
 */
const NEEDS_HUMAN_GLOSS: Readonly<Record<string, string>> = {
  "denied-again": "The Peer was denied again after a re-poke.",
  "silent-after-repoke": "The Peer stayed silent after a re-poke.",
  "attempt-ceiling": "The Task reached its attempt ceiling.",
  "died-after-respawn": "The Peer died again after a respawn.",
};

function needsYou(input: PanelInput): PanelNeedsYouItem[] {
  // The Owner decides through the Supervisor; the Lead is the fallback while no Supervisor lives.
  const deciderAction: PanelAction = input.supervisor !== null ? openSeatAction("supervisor", input.supervisor) : input.lead !== null ? openSeatAction("lead", input.lead) : START_SUPERVISOR_ACTION;
  const items: PanelNeedsYouItem[] = [];
  for (const task of input.tasks) {
    if (task.status !== "needs-human") continue;
    items.push({ key: `needs-human:${task.task}`, kind: "needs-human", title: `${task.task} needs your decision`, detail: task.needsHumanReason === null ? null : (NEEDS_HUMAN_GLOSS[task.needsHumanReason] ?? task.needsHumanReason), action: deciderAction });
  }
  for (const task of input.tasks) {
    const attempts = task.attempts.length === 0 ? 0 : Math.max(...task.attempts.map((attempt) => attempt.n));
    if (task.status !== "red" || attempts < MAX_ATTEMPTS) continue;
    const last = task.attempts.find((attempt) => attempt.n === attempts);
    items.push({
      key: `attempt-ceiling:${task.task}`,
      kind: "attempt-ceiling",
      title: `${task.task} stayed red after ${attempts} attempts`,
      detail: last?.note ?? null,
      action: deciderAction,
    });
  }
  const supervisor = input.supervisor;
  const window = supervisor?.contextMaxTokens;
  const mark = typeof window === "number" && Number.isFinite(window) && window > 0 ? Math.min(128_000, Math.floor(window * 0.65)) : 128_000;
  if (supervisor && supervisor.contextUsedTokens != null && supervisor.contextUsedTokens >= mark && (!supervisor.handoffProgress || supervisor.handoffProgress.state === "done")) {
    items.push({ key: "supervisor-near-mark", kind: "supervisor-near-mark", title: "Supervisor is near its handoff mark", detail: "Hand off when you are ready to continue in a fresh chat.", action: { kind: "handoff-supervisor", label: "Hand off now" } });
  }
  items.push(...seatStuckItems("supervisor", input.supervisor), ...seatStuckItems("lead", input.lead));
  // v0.6.1 (ADR 0057 §5): Supervisor-addressed mail holds when no live
  // Supervisor exists — the plugin never creates one — so the Owner sees the
  // hold and how many reports wait. Start Supervisor is the one action (the
  // client renders the desktop-only hint for it on mobile).
  if (input.supervisor === null && input.heldSupervisorMailCount > 0) {
    const count = input.heldSupervisorMailCount;
    items.push({
      key: "no-supervisor",
      kind: "no-supervisor",
      title: `No Supervisor · ${count} ${count === 1 ? "report" : "reports"} waiting`,
      detail: null,
      action: START_SUPERVISOR_ACTION,
    });
  }
  if ((input.rotationState ?? input.lead?.rotationState) === "handing_over") {
    const since = input.handoffRequestedAt === null ? Number.NaN : Date.parse(input.handoffRequestedAt);
    const lost = input.lead === null || input.lead.status === "error";
    if (lost || (Number.isFinite(since) && input.now - since > HANDOFF_STUCK_AFTER_MS)) {
      items.push({
        key: "handoff-stuck",
        kind: "handoff-stuck",
        title: "Lead handoff is stuck",
        detail: lost ? "The outgoing Lead is gone before the handoff finished." : "The handoff has run past its extraction window.",
        // The Lead while it lives, else the Supervisor that will dispatch the next one, else start a Supervisor.
        action: input.lead !== null ? openSeatAction("lead", input.lead) : input.supervisor !== null ? openSeatAction("supervisor", input.supervisor) : START_SUPERVISOR_ACTION,
      });
    }
  }
  if (input.missingPrerequisites.length > 0) {
    items.push({
      key: "prerequisites",
      kind: "prerequisites",
      title: "Required skills & tools are missing",
      detail: input.missingPrerequisites.join(", "),
      action: { kind: "install-prerequisites", label: "Install" },
    });
  }
  const design = openDesignOf(input.openDesign);
  if (design?.state === "broken") {
    items.push({ key: "open-design-broken", kind: "open-design-broken", title: "Open Design link is broken", detail: design.detail, action: { kind: "sync-open-design", label: "Sync again" } });
  }
  return items;
}

function openDesignOf(probe: PanelOpenDesignProbe | null): PanelOpenDesign | null {
  if (probe === null) return null;
  if (probe.unreadable !== null) return { state: "broken", projectName: null, syncedAt: null, detail: `The link record could not be read: ${probe.unreadable}` };
  if (probe.link === null) return { state: "unlinked", projectName: null, syncedAt: null, detail: null };
  if (!probe.bundlePresent) return { state: "broken", projectName: probe.link.projectName, syncedAt: probe.link.syncedAt, detail: "The staged design files are missing — sync the design again." };
  return { state: "linked", projectName: probe.link.projectName, syncedAt: probe.link.syncedAt, detail: null };
}

function summaryOf(input: PanelInput, attention: number, peers: number): string {
  const parts: string[] = [];
  if (input.supervisor === null) parts.push("No Supervisor");
  const lead = input.lead;
  if (lead === null) parts.push("No Lead");
  else if (lead.rotationState === "handing_over") parts.push("Lead handing over");
  else if (lead.rotationState === "rotation_pending") parts.push("Lead handoff pending");
  else if (lead.status === "error") parts.push("Lead errored");
  else if (lead.status === "running") parts.push("Lead working");
  else parts.push("Lead idle");
  if (peers > 0) parts.push(`${peers} ${peers === 1 ? "Peer" : "Peers"}`);
  parts.push(attention > 0 ? `${attention} ${attention === 1 ? "needs" : "need"} you` : "nothing needs you");
  return parts.join(" · ");
}

/** Projects the whole panel — pure over `input`. */
export function foldPanel(input: PanelInput): PanelView {
  if (input.project === null || !input.registered) {
    return {
      isProject: false,
      name: null,
      summary: "Not a Factory Project yet",
      needsYou: [],
      seats: null,
      openDesign: null,
      onboarding: { folder: input.folder, gitRepo: input.git.gitRepo, hasCommits: input.git.hasCommits, existingLead: input.project !== null && input.lead !== null },
    };
  }
  const peers = peerRows(input);
  const items = needsYou(input);
  return {
    isProject: true,
    name: input.project.name ?? input.project.slug,
    summary: summaryOf(input, items.length, peers.length),
    needsYou: items,
    seats: {
      supervisor: seatRow("supervisor", input.supervisor),
      lead: seatRow("lead", input.lead),
      peers,
      supervisorCandidates: supervisorCandidateRows(input),
    },
    openDesign: openDesignOf(input.openDesign),
    onboarding: null,
  };
}
