/**
 * The Agents & Models screen's fold (T-08a, ADR 0051) — the snapshot's whole
 * answer for the selected Project's read-only roster: one row per role lane
 * (the SLP six of `view.lanes`, or the Scrum roster `execution.config.lanes`
 * carries — "any others the data carries" appended verbatim, never guessed),
 * each row's `provider/model[:thinking]` split for the table, its
 * default-vs-override source derived from the machine table the snapshot
 * also carries, the live seats the daemon's own rows bind to it, and the
 * saved Lane profile library with the active one marked. Everything folds
 * here from the snapshot alone — no new door, no mock roster; a null Project
 * answers null (the screen's own empty state). Presence reuses the
 * Workspace fold's own vocabulary (`flowSeatState`), so the roster and the
 * authority graph can never disagree about a seat.
 */
import type { AgentView, FactoryView, Lanes } from "../../plugin/shared/view.ts";
import { flowSeatState, SCRUM_ROLE_LABELS, type FlowMode, type FlowSeatState } from "./view-model.ts";

/** One live seat bound to a lane — the daemon's own agent row, never a guess. */
export interface ModelsSeatChip {
  agentId: string;
  title: string | null;
  state: FlowSeatState;
}

/** Where a lane's value comes from — the snapshot's own two tables decide. */
export type ModelsLaneSource = "default" | "override";

/** One roster row — a lane's configured model, its source, and its live seats. */
export interface ModelsLaneRow {
  /** The lane key itself — "supervisor", "pm", "freshEyes", … */
  lane: string;
  /** The row's display name. */
  label: string;
  /** The design's tier word — Authority, Coordinator, Coding workhorse, … */
  tier: string;
  /** The configured `provider/model[:thinking]` verbatim. */
  raw: string;
  provider: string;
  model: string;
  /** The `:thinking` suffix — null when the lane names none. */
  thinking: string | null;
  source: ModelsLaneSource;
  /** "Machine default" / "Project override" — the source column's own spelling. */
  sourceLabel: string;
  /** The live seats bound to this lane — empty is the honest "Vacant". */
  seats: readonly ModelsSeatChip[];
  /** The honest vacancy reason for lanes with no standing seat — "Spawned per Task". */
  vacantNote: string | null;
}

/** One saved profile chip — the library's own row, the active one marked. */
export interface ModelsProfileChip {
  id: string;
  name: string;
  updatedAt: string;
  active: boolean;
}

/** The Agents & Models screen's whole world — null without a selected Project. */
export interface ModelsScreenModel {
  mode: FlowMode;
  /** The selected Project's display name. */
  scope: string;
  /** The roster note — "Project lanes" or "Run roster r3 · frozen" (Scrum). */
  rosterNote: string;
  rows: readonly ModelsLaneRow[];
  profiles: readonly ModelsProfileChip[];
  /** The active profile's name, when one is known — the "Modified from X" state. */
  activeProfileName: string | null;
  activeProfileModified: boolean;
  /**
   * Whether the roster's table is the Project's own `lanes.json` — the ONE
   * table the T-08b writes (`lanes.set`, `lanes.reset`, `profiles.apply`)
   * target. True for the SLP roster and a Scrum Project's degraded SLP
   * table; false for the frozen Scrum run roster, which only the Scrum
   * config door can mutate — this wave renders it read-only, honestly.
   */
  writable: boolean;
  /** The Project's root — the scope every write carries. */
  projectRoot: string;
}

/** The SLP six — `view.lanes`' own vocabulary, the RN roster's own order and tiers. */
const SLP_LANE_DEFS: readonly { lane: keyof Lanes; label: string; tier: string }[] = [
  { lane: "supervisor", label: "Supervisor", tier: "Authority" },
  { lane: "lead", label: "Lead", tier: "Coordinator" },
  { lane: "worker", label: "Default Worker", tier: "Coding workhorse" },
  { lane: "watch", label: "Watch", tier: "Feedback" },
  { lane: "retro", label: "Retro", tier: "Feedback" },
  { lane: "freshEyes", label: "Fresh Eyes", tier: "Advisory" },
];

/** The Scrum roster — the nine lanes `scrum-lanes.json` owns (CONTEXT.md: SLP six minus freshEyes, plus the five role lanes). */
const SCRUM_LANE_DEFS: readonly { lane: string; label: string; tier: string }[] = [
  { lane: "supervisor", label: "Supervisor", tier: "Authority" },
  { lane: "lead", label: "Lead", tier: "Coordinator" },
  { lane: "pm", label: SCRUM_ROLE_LABELS.pm, tier: "Planning" },
  { lane: "ux", label: SCRUM_ROLE_LABELS.ux, tier: "Design" },
  { lane: "architect", label: SCRUM_ROLE_LABELS.architect, tier: "Design" },
  { lane: "dev", label: SCRUM_ROLE_LABELS.dev, tier: "Delivery" },
  { lane: "qa", label: SCRUM_ROLE_LABELS.qa, tier: "Verification" },
  { lane: "watch", label: "Watch", tier: "Feedback" },
  { lane: "retro", label: "Retro", tier: "Feedback" },
];

/** The lanes that never hold a standing seat — their passengers spawn per Task. */
const PASSENGER_LANES: ReadonlySet<string> = new Set(["watch", "retro", "freshEyes"]);

/**
 * Splits `provider/model[:thinking]` for display — the core `parseLane` law
 * (`src/lanes.ts`) as a local pure mirror: no slash or empty parts answers
 * the raw string as the provider and an empty model, never a throw. `eye.json`
 * (the freshEyes external-config lane) keeps its one-word spelling.
 */
export function splitLane(raw: string): { provider: string; model: string; thinking: string | null } {
  const slash = raw.indexOf("/");
  if (slash === -1) return { provider: raw, model: "", thinking: null };
  const provider = raw.slice(0, slash);
  const rest = raw.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon === -1) return { provider, model: rest, thinking: null };
  return { provider, model: rest.slice(0, colon), thinking: rest.slice(colon + 1) };
}

/** One daemon agent row → one seat chip, presence in the Workspace fold's own vocabulary. */
function seatChip(agent: AgentView, kind: "supervisor" | "lead" | "peer"): ModelsSeatChip {
  return { agentId: agent.id, title: agent.title, state: flowSeatState(agent, kind) };
}

/**
 * The Agents & Models fold (T-08a) — a PURE fold of the scoped snapshot:
 * the SLP roster reads `view.lanes` (source derived against `view.machineLanes`
 * — a lane the two tables disagree on can only come from the Project's own
 * `lanes.json` override), the Scrum roster reads `execution.config.lanes`
 * (source against `execution.machineConfig`, the same law) with the active
 * run's task bindings seating the role lanes. The standing seats bind their
 * own rows; the SLP worker row carries the live workers (the RN roster's own
 * law — every agent that is neither seat); the passenger lanes (watch, retro,
 * freshEyes) hold no standing seat and say so. Profiles follow the mode: the
 * Scrum roster's own library when `execution.profiles` is carried, the Lane
 * profile library otherwise, the active one marked where the data says.
 */
export function modelsScreenModel(view: FactoryView): ModelsScreenModel | null {
  if (view.project === null) return null;
  const mode: FlowMode = view.project.executionMode ?? view.execution?.selectedMode ?? "slp";
  const scope = view.project.name ?? view.project.slug;
  const workers = view.agents.filter((agent) => agent.id !== view.supervisor?.id && agent.id !== view.lead?.id);
  const tasksById = new Map(view.tasks.map((task) => [task.task, task]));

  /** The live agent a run task binds — the Workspace fold's own attribution law. */
  const agentForTask = (task: string): AgentView | undefined =>
    view.agents.find((agent) => agent.task === task) ?? view.agents.find((agent) => tasksById.get(task)?.agentId === agent.id);

  const rows: ModelsLaneRow[] = [];
  const pushRow = (
    def: { lane: string; label: string; tier: string },
    raw: string,
    /** The scope's base table — the machine table the effective lane is compared against. */
    base: Readonly<Record<string, string>> | undefined,
    seats: readonly ModelsSeatChip[],
  ): void => {
    const parts = splitLane(raw);
    const overridden = base !== undefined && base[def.lane] !== raw;
    rows.push({
      lane: def.lane,
      label: def.label,
      tier: def.tier,
      raw,
      provider: parts.provider,
      model: parts.model,
      thinking: parts.thinking,
      source: overridden ? "override" : "default",
      sourceLabel: overridden ? "Project override" : "Machine default",
      seats,
      vacantNote: PASSENGER_LANES.has(def.lane) ? "Spawned per Task" : null,
    });
  };

  let rosterNote = "Project lanes";
  const scrumLanes = mode === "scrum" ? view.execution?.config?.lanes : undefined;
  if (scrumLanes !== undefined) {
    const machine = view.execution?.machineConfig?.lanes;
    const revision = view.execution?.config?.configRevision;
    rosterNote = revision === undefined ? "Run roster · frozen" : `Run roster r${revision} · frozen`;
    const run = view.execution?.activeRun ?? view.execution?.run;
    for (const def of SCRUM_LANE_DEFS) {
      const raw = scrumLanes[def.lane as keyof typeof scrumLanes];
      if (raw === undefined) continue; // a lane this roster never named renders no invented row
      const seats =
        def.lane === "supervisor"
          ? view.supervisor === null
            ? []
            : [seatChip(view.supervisor, "supervisor")]
          : def.lane === "lead"
            ? view.lead === null
              ? []
              : [seatChip(view.lead, "lead")]
            : PASSENGER_LANES.has(def.lane)
              ? []
              : dedupeSeats(
                  (run?.tasks ?? [])
                    .filter((entry) => entry.role === def.lane)
                    .map((entry) => agentForTask(entry.task))
                    .filter((agent): agent is AgentView => agent !== undefined)
                    .map((agent) => seatChip(agent, "peer")),
                );
      pushRow(def, raw, machine, seats);
    }
    for (const lane of Object.keys(scrumLanes)) {
      if (!SCRUM_LANE_DEFS.some((def) => def.lane === lane)) {
        pushRow({ lane, label: lane, tier: "" }, scrumLanes[lane as keyof typeof scrumLanes]!, machine, []);
      }
    }
  } else {
    if (mode === "scrum") rosterNote = "Project lanes — no Scrum roster recorded";
    for (const def of SLP_LANE_DEFS) {
      const seats =
        def.lane === "supervisor"
          ? view.supervisor === null
            ? []
            : [seatChip(view.supervisor, "supervisor")]
          : def.lane === "lead"
            ? view.lead === null
              ? []
              : [seatChip(view.lead, "lead")]
            : def.lane === "worker"
              ? workers.map((agent) => seatChip(agent, "peer"))
              : [];
      pushRow(def, view.lanes[def.lane], view.machineLanes, seats);
    }
  }

  // The mode's own profile library: the Scrum roster's when the execution view
  // carries one, the Lane profile library otherwise — the active one marked
  // where the data says, "modified" carried for the strip's honest suffix.
  let profiles: ModelsProfileChip[];
  let activeProfileId: string | null;
  let activeProfileModified: boolean;
  const executionProfiles = mode === "scrum" ? view.execution?.profiles : undefined;
  if (executionProfiles !== undefined) {
    activeProfileId = view.execution?.activeProfileId ?? null;
    activeProfileModified = view.execution?.activeProfileModified ?? false;
    profiles = executionProfiles.map((profile) => ({ id: profile.id, name: profile.name, updatedAt: profile.updatedAt, active: profile.id === activeProfileId }));
  } else {
    activeProfileId = view.activeProfileId;
    activeProfileModified = view.activeProfileModified;
    profiles = view.profiles.map((profile) => ({ id: profile.id, name: profile.name, updatedAt: profile.updatedAt, active: profile.id === activeProfileId }));
  }
  return {
    mode,
    scope,
    rosterNote,
    rows,
    profiles,
    activeProfileName: profiles.find((profile) => profile.active)?.name ?? null,
    activeProfileModified,
    // The frozen Scrum roster reads `execution.config.lanes` — a table the
    // lane writes cannot reach (they target `lanes.json`), so it stays
    // read-only this wave; every other roster reads `view.lanes`.
    writable: scrumLanes === undefined,
    projectRoot: view.project.root,
  };
}

/** Keeps one chip per agent id — a Peer bound to two run tasks renders once. */
function dedupeSeats(seats: readonly ModelsSeatChip[]): ModelsSeatChip[] {
  const seen = new Set<string>();
  const kept: ModelsSeatChip[] = [];
  for (const seat of seats) {
    if (seen.has(seat.agentId)) continue;
    seen.add(seat.agentId);
    kept.push(seat);
  }
  return kept;
}
