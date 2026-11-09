import { linkedDesignSpecification } from "./linked-design.ts";
import { renderHelperMcpRoster } from "./helper-mcp-sync.ts";
import type { HelperMcpServerEntry } from "./helper-mcp-sync.ts";
import { projectMemoryPresence } from "./project-memory.ts";
/**
 * Seat kickoff packet builder (v0.0.26, ADR 0016 §4) — deterministic, <50ms
 * Node-side repository preflight prepended to Turn 1 of every newly created
 * or rotated `Supervisor` or `Lead` seat.
 *
 * Eliminates the 6-12 exploratory tool calls (`git status`, `ls`, `cat
 * package.json`, `factory status`) that otherwise burn turns and context
 * before `Supervisor` or `Lead` acts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEAD_WAVE_LAWS, SUPERVISOR_OUTCOME_BOUNDARY } from "./roles-contract.ts";
import { SCRUM_LEAD_MCP_TOOLS, SCRUM_SUPERVISOR_MCP_TOOLS } from "./scrum/prompts.ts";
import { projectNotebookPath, readProjectNotebook } from "./project.ts";
import type { LedgerEvent } from "./events.ts";

export interface SeatKickoffPacketInput {
  role: "supervisor" | "lead";
  projectSlug: string;
  projectRoot: string;
  ledgerEvents: readonly LedgerEvent[];
  lanes?: Record<string, string>;
  helperMcps?: Array<Pick<HelperMcpServerEntry, "name" | "transport" | "enabled" | "status">>;
  /**
   * The factory `stateDir` (v0.1.0, ADR 0048 §3). When present, the packet
   * carries the Project notebook's slug-dependent path (`- Project notebook
   * path: …`) plus its bounded content — or the clean empty-state placeholder
   * when the notebook has not been initialized yet — so `Lead` and
   * `Supervisor` never guess `<projectStateDir>/notebook.md`. Omitted: no
   * notebook lines (backward-compatible standalone callers).
   */
  stateDir?: string;
  /**
   * Omits the static blocks the seat's `config.systemPrompt` already carries
   * (the `linkedDesignSpecification` block, the helper-MCP roster, and the
   * `LEAD_WAVE_LAWS` / `SUPERVISOR_OUTCOME_BOUNDARY` law lines) when the
   * packet is prepended to a system-prompted seat on Turn 1 (v0.0.97, ADR
   * 0047 §1). The `Fire-and-End-Turn` law and every dynamic repository
   * preflight line stay. Default `false`: standalone callers keep the
   * complete self-contained packet.
   */
  omitSystemPromptDuplicates?: boolean;
  /**
   * Execution mode for the packet's role-scoped vocabulary (v0.2.0, ADR
   * 0049 §2). `"scrum"` renders the Scrum MCP tool table
   * (`SCRUM_SUPERVISOR_MCP_TOOLS` / `SCRUM_LEAD_MCP_TOOLS`) and appends the
   * `- Active Scrum run digest:` block from `scrumRunDigest`. Omitted or
   * `"slp"`: today's SLP packet, byte-for-byte.
   */
  mode?: "slp" | "scrum";
  /**
   * Pre-rendered `formatScrumRunDigest(run)` block appended under
   * `- Active Scrum run digest:` when `mode === "scrum"` (v0.2.0, ADR 0049
   * §2). Ignored in SLP mode.
   */
  scrumRunDigest?: string;
}

function runGitFast(cwd: string, args: readonly string[]): string {
  try {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1_500,
    });
    if (res.status === 0 && typeof res.stdout === "string") {
      return res.stdout.trim();
    }
  } catch {
    // ignore git failures on non-git or transient directories
  }
  return "";
}

function summarizePackageScripts(projectRoot: string): string {
  const pkgPath = join(projectRoot, "package.json");
  const markers = ["Makefile", "Cargo.toml", "go.mod", "pyproject.toml"].filter((m) =>
    existsSync(join(projectRoot, m)),
  );
  let scriptsLine = "";
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: unknown;
        scripts?: Record<string, unknown>;
      };
      if (parsed && typeof parsed.scripts === "object" && parsed.scripts !== null) {
        const entries = Object.entries(parsed.scripts)
          .filter(([, v]) => typeof v === "string")
          .slice(0, 12)
          .map(([k, v]) => `${k}: \`${String(v)}\``);
        if (entries.length > 0) {
          scriptsLine = entries.join(", ");
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }
  const parts: string[] = [];
  if (scriptsLine !== "") parts.push(`package.json scripts (${scriptsLine})`);
  if (markers.length > 0) parts.push(`markers (${markers.join(", ")})`);
  return parts.length > 0 ? parts.join(" · ") : "(no package.json scripts or build markers detected)";
}

function summarizeTopLevelEntries(projectRoot: string): { entries: string; memoryDocs: string } {
  let names: string[] = [];
  try {
    names = readdirSync(projectRoot)
      .filter((name) => name !== ".git" && name !== "node_modules")
      .sort()
      .slice(0, 40);
  } catch {
    // ignore unreadable directory
  }
  const memoryMarkers = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "GLOSSARY.md", ".scratch"].filter((m) =>
    existsSync(join(projectRoot, m)),
  );
  return {
    entries: names.length > 0 ? names.join(", ") : "(empty)",
    memoryDocs: memoryMarkers.length > 0 ? memoryMarkers.join(", ") : "(none present yet)",
  };
}

function summarizeLedgerTasks(projectRoot: string, events: readonly LedgerEvent[]): string {
  const tasks = new Map<
    string,
    { task: string; status: string; attempts: number; latestVerdict: string }
  >();
  for (const evt of events) {
    if (evt.event === "contract_set") {
      if (
        projectRoot !== "" &&
        evt.workspace !== projectRoot &&
        !evt.workspace.startsWith(`${projectRoot}/`)
      ) {
        continue;
      }
      tasks.set(evt.task, {
        task: evt.task,
        status: "contracted",
        attempts: 0,
        latestVerdict: "none",
      });
    } else if ("task" in evt && typeof evt.task === "string") {
      const row = tasks.get(evt.task);
      if (!row) continue;
      if (evt.event === "spawn_dispatched") {
        row.status = "running";
      } else if (evt.event === "gate_finished") {
        row.attempts = Math.max(row.attempts, evt.attempt);
        row.latestVerdict = evt.verdict;
        row.status = evt.verdict === "green" ? "green" : "red";
      } else if (evt.event === "attempt_accepted") {
        row.status = `accepted (by ${evt.accepted_by ?? "owner"})`;
      } else if (evt.event === "task_closed") {
        row.status = `closed (by ${evt.closed_by ?? "owner"})`;
      } else if (evt.event === "needs_human") {
        row.status = `needs_human (${evt.reason})`;
      }
    }
  }
  if (tasks.size === 0) return "none (clean slate)";
  const rows = [...tasks.values()];
  // v0.5.0 (ADR 0054 §5, ticket 05): a clean retirement is closed history like
  // an acceptance — it collapses, never occupies an open row.
  const settledClosed = (row: { status: string }): boolean => row.status.startsWith("accepted") || row.status.startsWith("closed");
  const acceptedRows = rows.filter(settledClosed);
  const activeRows = rows.filter((row) => !settledClosed(row));
  const renderRow = (t: { task: string; status: string; attempts: number; latestVerdict: string }): string =>
    `${t.task} [${t.status}, attempts=${t.attempts}, verdict=${t.latestVerdict}]`;
  // ADR 0047 §1.3: once accepted history grows past 3 tasks, closed tasks
  // collapse into one count + latest-tail prefix so the preflight summary
  // stays bounded regardless of total Project history length; unaccepted
  // tasks always keep their full [status, attempts, verdict] entry.
  if (acceptedRows.length > 3) {
    const acceptedSummary = `${acceptedRows.length} accepted/closed (latest: ${acceptedRows.slice(-3).map((r) => r.task).join(", ")})`;
    return activeRows.length > 0 ? `${acceptedSummary}; ${activeRows.map(renderRow).join("; ")}` : acceptedSummary;
  }
  return rows.map(renderRow).join("; ");
}

export function buildSeatKickoffPacket(input: SeatKickoffPacketInput): string {
  const omitDuplicates = input.omitSystemPromptDuplicates === true;
  const branch = runGitFast(input.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached/unborn)";
  const head = runGitFast(input.projectRoot, ["rev-parse", "--short", "HEAD"]) || "(no commits)";
  const statusRaw = runGitFast(input.projectRoot, ["status", "--porcelain"]);
  const statusLines = statusRaw === "" ? [] : statusRaw.split("\n").slice(0, 20);
  const statusSummary =
    statusLines.length === 0 ? "clean" : `${statusLines.length} modified/untracked: ${statusLines.join(" | ")}`;

  const scriptsSummary = summarizePackageScripts(input.projectRoot);
  const { entries, memoryDocs } = summarizeTopLevelEntries(input.projectRoot);
  const tasksSummary = summarizeLedgerTasks(input.projectRoot, input.ledgerEvents);
  const lanesSummary =
    input.lanes !== undefined && Object.keys(input.lanes).length > 0
      ? Object.entries(input.lanes)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "default";

  // v0.2.0 (ADR 0049 §2): Scrum seats get their own MCP tool vocabulary;
  // SLP seats keep today's table byte-for-byte.
  const isScrum = input.mode === "scrum";
  const roleTools = isScrum
    ? input.role === "supervisor"
      ? SCRUM_SUPERVISOR_MCP_TOOLS
      : SCRUM_LEAD_MCP_TOOLS
    : input.role === "supervisor"
      ? "`supervisor_dispatch_lead`, `supervisor_read_ledger`, `supervisor_end_cycle`"
      : "`lead_set_contract`, `lead_dispatch_agent`, `lead_verify`, `lead_merge`, `lead_report_to_supervisor`";

  const fireAndEndTurn =
    input.role === "supervisor"
      ? "Fire-and-End-Turn: call `supervisor_dispatch_lead` (or run `factory lead dispatch`) and IMMEDIATELY end your turn — never poll, never sleep, and never edit product source code."
      : "Fire-and-End-Turn: outline the serial-wave roadmap, call `lead_set_contract` then `lead_dispatch_agent` (or `factory contract` + `factory run`) for the current wave only, and IMMEDIATELY end your turn — never poll, never sleep, and never edit product source code on `<project-root>`.";

  // v0.1.0 (ADR 0048 §3): the Project notebook rides the packet as dynamic
  // state — its slug-dependent path plus the bounded content (or the clean
  // empty-state placeholder) — placed with the dynamic preflight lines so
  // `omitSystemPromptDuplicates` keeps it.
  const notebookLines: string[] = [];
  if (input.stateDir !== undefined) {
    const notebookPath = projectNotebookPath(input.stateDir, input.projectSlug);
    const notebook = readProjectNotebook(input.stateDir, input.projectSlug);
    notebookLines.push(`- Project notebook path: ${notebookPath}`);
    notebookLines.push(
      notebook !== undefined
        ? `- Project notebook (${notebookPath}):\n${notebook}`
        : `- Project notebook (${notebookPath}): (none yet — initialize on first verified Gate or observed failure mechanism)`,
    );
  }

  return [
    `--- [paseo-factory seat kickoff packet · role=${input.role} · project=${input.projectSlug}] ---`,
    `- Workspace: ${input.projectRoot}`,
    `- Git: branch=\`${branch}\`, head=\`${head}\`, status=${statusSummary}`,
    `- Top-level files: ${entries}`,
    `- Memory/docs present: ${memoryDocs}`,
    `- ${projectMemoryPresence(input.projectRoot)}`,
    `- Build/Test commands: ${scriptsSummary}`,
    `- Active lanes: ${lanesSummary}`,
    `- Ledger tasks: ${tasksSummary}`,
    ...notebookLines,
    // ADR 0047 §1.2: a Turn-1 packet prepended to a seat whose
    // `config.systemPrompt` already carries `buildRoleKickoffPrompt(role)`
    // drops the duplicated static blocks — design spec, helper-MCP roster,
    // and wave laws — keeping only the Fire-and-End-Turn law and the
    // dynamic repository preflight lines above.
    ...(omitDuplicates ? [] : [linkedDesignSpecification(input.projectRoot)]),
    ...(input.role === "lead" && !omitDuplicates ? [renderHelperMcpRoster(input.helperMcps ?? [])] : []),
    `- Role MCP tools (paseo_factory): ${roleTools}`,
    `- Law: ${fireAndEndTurn}`,
    ...(omitDuplicates
      ? []
      : input.role === "lead"
        ? LEAD_WAVE_LAWS.map((law) => `- Law: ${law}`)
        : [`- Law: ${SUPERVISOR_OUTCOME_BOUNDARY}`]),
    // v0.2.0 (ADR 0049 §2): the bounded Scrum run digest rides the packet as
    // dynamic run state (like the Project notebook), so it survives
    // `omitSystemPromptDuplicates`.
    ...(isScrum && input.scrumRunDigest !== undefined
      ? [`- Active Scrum run digest:\n${input.scrumRunDigest}`]
      : []),
    `--- [end seat kickoff packet] ---`,
    "",
  ].join("\n");
}
