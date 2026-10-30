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
import type { LedgerEvent } from "./events.ts";

export interface SeatKickoffPacketInput {
  role: "supervisor" | "lead";
  projectSlug: string;
  projectRoot: string;
  ledgerEvents: readonly LedgerEvent[];
  lanes?: Record<string, string>;
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
      } else if (evt.event === "needs_human") {
        row.status = `needs_human (${evt.reason})`;
      }
    }
  }
  if (tasks.size === 0) return "none (clean slate)";
  return [...tasks.values()]
    .map((t) => `${t.task} [${t.status}, attempts=${t.attempts}, verdict=${t.latestVerdict}]`)
    .join("; ");
}

export function buildSeatKickoffPacket(input: SeatKickoffPacketInput): string {
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

  const roleTools =
    input.role === "supervisor"
      ? "`supervisor_dispatch_lead`, `supervisor_read_ledger`, `supervisor_end_cycle`"
      : "`lead_set_contract`, `lead_dispatch_agent`, `lead_verify`, `lead_merge`, `lead_report_to_supervisor`";

  const fireAndEndTurn =
    input.role === "supervisor"
      ? "Fire-and-End-Turn: call `supervisor_dispatch_lead` (or run `factory lead dispatch`) and IMMEDIATELY end your turn — never poll, never sleep, and never edit product source code."
      : "Fire-and-End-Turn: outline the serial-wave roadmap, call `lead_set_contract` then `lead_dispatch_agent` (or `factory contract` + `factory run`) for the current wave only, and IMMEDIATELY end your turn — never poll, never sleep, and never edit product source code on `<project-root>`.";

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
    `- Role MCP tools (paseo_factory): ${roleTools}`,
    `- Law: ${fireAndEndTurn}`,
    ...(input.role === "lead" ? LEAD_WAVE_LAWS.map((law) => `- Law: ${law}`) : [`- Law: ${SUPERVISOR_OUTCOME_BOUNDARY}`]),
    `--- [end seat kickoff packet] ---`,
    "",
  ].join("\n");
}
