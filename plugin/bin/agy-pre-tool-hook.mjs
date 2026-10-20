#!/usr/bin/env node
/**
 * agy-pre-tool-hook.mjs — Antigravity (`agy`) PreToolUse hook for paseo-factory
 * (v0.0.26, ADR 0016 §3).
 *
 * Fast-path (<5ms): when `PASEO_FACTORY_SEAT` and `PASEO_FACTORY_CORRELATION`
 * are unset, immediately prints `{"decision":"allow"}` and exits 0 without
 * reading stdin or touching disk, so normal non-factory `agy` sessions have
 * zero overhead.
 *
 * When `PASEO_FACTORY_SEAT` (or `PASEO_FACTORY_CORRELATION`) is set, enforces:
 * - `seat-paseo-tool-fence` across all roles
 * - `seat-write-fence` and git/process fences for `supervisor` and `lead`
 * - Contract `--scope`, memory write fence, and `<stateDir>` protection for `agent`
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const rawSeatEnv = typeof process.env.PASEO_FACTORY_SEAT === "string" ? process.env.PASEO_FACTORY_SEAT.trim() : "";
const rawCorrEnv =
  typeof process.env.PASEO_FACTORY_CORRELATION === "string" ? process.env.PASEO_FACTORY_CORRELATION.trim() : "";

if (rawSeatEnv === "" && rawCorrEnv === "") {
  process.stdout.write('{"decision":"allow"}\n');
  process.exit(0);
}

const SEAT_MEMORY_WHITELIST = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "GLOSSARY.md",
  ".gitignore",
  ".worktreeinclude",
]);

const FORBIDDEN_PASEO_TOOLS = new Set([
  "Task",
  "Agent",
  "send_message",
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "create_agent",
  "kill_agent",
  "archive_agent",
  "send_agent_prompt",
  "update_agent",
  "paseo_create_agent",
  "paseo_kill_agent",
  "paseo_archive_agent",
  "paseo_send_agent_prompt",
  "paseo_update_agent",
  "mcp__paseo__create_agent",
  "mcp__paseo__kill_agent",
  "mcp__paseo__archive_agent",
  "mcp__paseo__send_agent_prompt",
  "mcp__paseo__update_agent",
]);

const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write",
  "edit",
]);

const SHELL_TOOL_NAMES = new Set([
  "run_command",
  "bash",
  "Bash",
  "execute_command",
  "shell",
  "exec",
]);

function stripTrailingSlash(p) {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function isProtectedStatePath(resolvedCandidate, resolvedState, allowedWorktree) {
  if (!resolvedState) return false;
  if (
    resolvedCandidate === `${resolvedState}/ledger.jsonl` ||
    resolvedCandidate === `${resolvedState}/correlations.json` ||
    resolvedCandidate === `${resolvedState}/lanes.json`
  ) {
    return true;
  }
  const projectsPrefix = `${resolvedState}/projects`;
  if (resolvedCandidate === projectsPrefix || resolvedCandidate.startsWith(`${projectsPrefix}/`)) {
    if (resolvedCandidate.endsWith("/lead-handoff.md")) return false;
    if (allowedWorktree) {
      const resolvedWt = stripTrailingSlash(resolve(allowedWorktree));
      if (resolvedCandidate === resolvedWt || resolvedCandidate.startsWith(`${resolvedWt}/`)) return false;
    } else if (/\/projects\/[^/]+\/worktrees\/[^/]+(\/|$)/.test(resolvedCandidate)) {
      return false;
    }
    return true;
  }
  return false;
}

function isSeatMemoryRelativeAllowed(rel) {
  let normalized = rel.trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = stripTrailingSlash(normalized);
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  if (SEAT_MEMORY_WHITELIST.has(normalized)) return true;
  if (normalized === "docs" || normalized.startsWith("docs/")) return true;
  if (normalized === ".scratch" || normalized.startsWith(".scratch/")) return true;
  return false;
}

function isSeatWriteAllowed(projectRoot, candidatePath, stateDir) {
  const raw = typeof candidatePath === "string" ? candidatePath.trim() : "";
  if (raw === "") return false;
  if (raw === "/dev/null") return true;
  if (raw === "~" || raw.startsWith("~/")) return false;

  const resolvedRoot = stripTrailingSlash(resolve(projectRoot || process.cwd()));
  const resolvedState = stateDir ? stripTrailingSlash(resolve(stateDir)) : "";
  const resolvedCandidate = stripTrailingSlash(isAbsolute(raw) ? resolve(raw) : resolve(resolvedRoot, raw));

  if (isProtectedStatePath(resolvedCandidate, resolvedState)) {
    return false;
  }
  if (resolvedState !== "" && (resolvedCandidate === resolvedState || resolvedCandidate.startsWith(`${resolvedState}/`))) {
    return true;
  }
  if (resolvedCandidate === resolvedRoot) return false;
  if (resolvedCandidate.startsWith(`${resolvedRoot}/`)) {
    const rel = resolvedCandidate.slice(resolvedRoot.length + 1);
    return isSeatMemoryRelativeAllowed(rel);
  }
  for (const tmp of ["/tmp", tmpdir(), process.env.TMPDIR].filter(Boolean)) {
    const resolvedTmp = stripTrailingSlash(resolve(tmp));
    if (resolvedCandidate === resolvedTmp || resolvedCandidate.startsWith(`${resolvedTmp}/`)) return true;
  }
  return false;
}

function scopeCoversFile(scope, relPath) {
  let clean = relPath.trim();
  while (clean.startsWith("./")) clean = clean.slice(2);
  if (clean === "" || clean.startsWith("/") || clean.split("/").includes("..")) return false;
  for (const rawPrefix of scope) {
    let prefix = String(rawPrefix).trim();
    while (prefix.startsWith("./")) prefix = prefix.slice(2);
    if (prefix === "") continue;
    if (prefix.endsWith("/")) {
      if (clean.startsWith(prefix) || clean === prefix.slice(0, -1)) return true;
    } else if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function extractShellWriteTargets(command) {
  const targets = [];
  const tokens = command
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, "").replace(/^[;|&()$`]+|[;|&()$`]+$/g, ""))
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const redir = /^(?:\d*|&)>>?(.*)$/.exec(t);
    if (redir) {
      const dest = redir[1] !== "" ? redir[1] : tokens[i + 1];
      if (dest) targets.push(dest);
      continue;
    }
    if (t === "tee") {
      const dest = tokens.slice(i + 1).find((x) => !x.startsWith("-"));
      if (dest) targets.push(dest);
    } else if (["cp", "mv", "install", "rsync", "ln", "truncate"].includes(t)) {
      const ops = tokens.slice(i + 1).filter((x) => !x.startsWith("-"));
      if (ops.length > 0) targets.push(ops[ops.length - 1]);
    } else if (["rm", "touch", "mkdir"].includes(t)) {
      for (const op of tokens.slice(i + 1).filter((x) => !x.startsWith("-"))) targets.push(op);
    } else if (t === "sed" && tokens.slice(i + 1).some((x) => x.startsWith("-i"))) {
      const ops = tokens.slice(i + 1).filter((x) => !x.startsWith("-"));
      if (ops.length > 0) targets.push(ops[ops.length - 1]);
    }
  }
  return targets;
}

function isProcessKillAgainstFactory(command) {
  if (!/\b(?:pkill|killall|kill)\b/.test(command)) return false;
  return /\b(?:plugin-process|paseo)\b/i.test(command);
}

function isForbiddenSeatGit(command) {
  if (!/\bgit\b/.test(command)) return false;
  return /\bgit\s+(?:commit|merge|cherry-pick|rebase|am|apply|stash|reset|clean)\b/.test(command) ||
    /\bgit\s+checkout\s+(?:-[bB]|--)\b/.test(command) ||
    /\bgit\s+push\s+.*(?:--force|-f|--delete|-d)\b/.test(command);
}

function resolveContext() {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const stateDir = process.env.PASEO_FACTORY_STATE_DIR || join(home, "plugin-state", "paseo-factory");
  let seat = rawSeatEnv;
  let projectRoot = process.env.PASEO_FACTORY_PROJECT_ROOT || process.cwd();
  let projectSlug = process.env.PASEO_FACTORY_PROJECT || "";
  let task = process.env.PASEO_FACTORY_TASK || "";

  if (rawCorrEnv && stateDir) {
    try {
      const corrPath = join(stateDir, "correlations.json");
      if (existsSync(corrPath)) {
        const parsed = JSON.parse(readFileSync(corrPath, "utf8"));
        const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];
        const match = records.find((r) => r && r.correlationId === rawCorrEnv);
        if (match) {
          if (!seat && match.role) seat = match.role;
          if (match.projectRoot) projectRoot = match.projectRoot;
          if (match.projectSlug) projectSlug = match.projectSlug;
          if (match.task) task = match.task;
        }
      }
    } catch {
      // ignore correlation read errors
    }
  }
  return { stateDir, seat, projectRoot, projectSlug, task };
}

function loadContractForTask(stateDir, task) {
  if (!stateDir || !task) return null;
  try {
    const ledgerPath = join(stateDir, "ledger.jsonl");
    if (!existsSync(ledgerPath)) return null;
    const lines = readFileSync(ledgerPath, "utf8").split("\n");
    let contract = null;
    let worktree = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.task === task) {
        if (evt.event === "contract_set") contract = evt;
        if (evt.event === "spawn_dispatched" && evt.worktree) worktree = evt.worktree;
      }
    }
    return contract ? { ...contract, worktree } : null;
  } catch {
    return null;
  }
}

function allow() {
  process.stdout.write(
    `${JSON.stringify({
      decision: "allow",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    })}\n`,
  );
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      decision: "deny",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.exit(0);
}

let rawStdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  rawStdin += chunk;
});
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch {
    allow();
  }

  const ctx = resolveContext();
  if (ctx.seat !== "supervisor" && ctx.seat !== "lead" && ctx.seat !== "agent") {
    allow();
  }

  const toolName = String(payload.tool_name ?? payload.toolName ?? payload.name ?? "").trim();
  const toolInput =
    typeof (payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.arguments) === "object" &&
    (payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.arguments) !== null
      ? (payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.arguments)
      : {};

  if (FORBIDDEN_PASEO_TOOLS.has(toolName) || toolName.startsWith("mcp__paseo__")) {
    deny(
      `Direct Paseo agent-lifecycle tool "${toolName}" is forbidden for factory seats (seat-paseo-tool-fence); use paseo_factory MCP tools instead.`,
    );
  }

  if (ctx.seat === "supervisor" || ctx.seat === "lead") {
    if (WRITE_TOOL_NAMES.has(toolName)) {
      const targetPath = String(
        toolInput.Path ?? toolInput.TargetFile ?? toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? "",
      ).trim();
      if (!isSeatWriteAllowed(ctx.projectRoot, targetPath, ctx.stateDir)) {
        deny(
          "Seat write fence: Supervisor and Lead may only write project memory/docs (AGENTS.md, CONTEXT.md, docs/**, .scratch/**); dispatch implementation work to Lead / Task Agents",
        );
      }
      allow();
    }
    if (SHELL_TOOL_NAMES.has(toolName)) {
      const cmd = String(toolInput.CommandLine ?? toolInput.command ?? toolInput.cmd ?? "").trim();
      if (isProcessKillAgainstFactory(cmd)) {
        deny("Seat write fence: killing Paseo or plugin-process is forbidden.");
      }
      if (isForbiddenSeatGit(cmd)) {
        deny("Seat git fence: Supervisor and Lead may not run destructive or committing git commands on <project-root>.");
      }
      for (const target of extractShellWriteTargets(cmd)) {
        if (!isSeatWriteAllowed(ctx.projectRoot, target, ctx.stateDir)) {
          deny(
            "Seat write fence: Supervisor and Lead may only write project memory/docs (AGENTS.md, CONTEXT.md, docs/**, .scratch/**); dispatch implementation work to Lead / Task Agents",
          );
        }
      }
      allow();
    }
    allow();
  }

  if (ctx.seat === "agent") {
    const contract = loadContractForTask(ctx.stateDir, ctx.task);
    const baseRoot = stripTrailingSlash(resolve(contract?.worktree ?? contract?.workspace ?? ctx.projectRoot ?? process.cwd()));
    const resolvedState = ctx.stateDir ? stripTrailingSlash(resolve(ctx.stateDir)) : "";

    const checkAgentPath = (rawTarget) => {
      const raw = String(rawTarget ?? "").trim();
      if (raw === "" || raw === "/dev/null") return null;
      const resolvedCandidate = stripTrailingSlash(isAbsolute(raw) ? resolve(raw) : resolve(baseRoot, raw));
      if (isProtectedStatePath(resolvedCandidate, resolvedState, contract?.worktree)) {
        return `Write to protected factory state path "${raw}" is forbidden (seat-write-fence).`;
      }
      if (resolvedCandidate.startsWith(`${baseRoot}/`)) {
        const rel = resolvedCandidate.slice(baseRoot.length + 1);
        if (["AGENTS.md", "CLAUDE.md", "CONTEXT.md"].includes(rel)) {
          if (!Array.isArray(contract?.scope) || !scopeCoversFile(contract.scope, rel)) {
            return `Write to ${rel} is fenced (policy:memory-write-fenced).`;
          }
        }
        if (Array.isArray(contract?.scope) && contract.scope.length > 0 && !scopeCoversFile(contract.scope, rel)) {
          return `Write to "${rel}" is outside the Contract's declared scope (${contract.scope.join(", ")}).`;
        }
      }
      return null;
    };

    if (WRITE_TOOL_NAMES.has(toolName)) {
      const targetPath = String(
        toolInput.Path ?? toolInput.TargetFile ?? toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? "",
      ).trim();
      const err = checkAgentPath(targetPath);
      if (err) deny(err);
      allow();
    }

    if (SHELL_TOOL_NAMES.has(toolName)) {
      const cmd = String(toolInput.CommandLine ?? toolInput.command ?? toolInput.cmd ?? "").trim();
      if (isProcessKillAgainstFactory(cmd)) {
        deny("Seat write fence: killing Paseo or plugin-process is forbidden.");
      }
      for (const target of extractShellWriteTargets(cmd)) {
        const err = checkAgentPath(target);
        if (err) deny(err);
      }
      allow();
    }
  }

  allow();
});
