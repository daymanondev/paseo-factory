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
 * - `seat-write-fence` and git fences for `supervisor` and `lead`
 * - `process-kill` (command-position gate, v0.0.84) across all roles
 * - Contract `--scope`, memory write fence, and `<stateDir>` protection for `agent`
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
// Per-Project ledger candidates under the shared registration law (v0.0.92,
// ADR 0045 §1) — the durable projects/<slug>/project.json binding decides,
// never a directory-name guess.
import { projectLedgerStreams } from "./ledger-project.mjs";

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

// The read-only SLP dispositions (ADR 0053 §3, ticket 05) — mirror of
// src/events.ts's READ_ONLY_PEER_DISPOSITIONS (this hook cannot import the TS core).
const READ_ONLY_DISPOSITIONS = new Set(["architect", "reviewer", "scout"]);

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

// BEGIN GENERATED SCOPE POLICY
import { createRequire as scopePolicyRequire } from "node:module";
const scopePolicy = (() => {
const require = scopePolicyRequire(import.meta.url);
const module = { exports: {} };
// Generated by scripts/generate-policies.mjs from checked TypeScript. Do not edit.
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/scope-policy.ts
var scope_policy_exports = {};
__export(scope_policy_exports, {
  PACKAGE_LOCKFILES: () => PACKAGE_LOCKFILES,
  normalizeScopePath: () => normalizeScopePath,
  scopeCoversFile: () => scopeCoversFile,
  scopeGlob: () => scopeGlob,
  scopeRecoveryCommands: () => scopeRecoveryCommands
});
module.exports = __toCommonJS(scope_policy_exports);
var PACKAGE_LOCKFILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
]);
function scopeCoversFile(scope, file) {
  const directMatch = (target) => scope.some((entry) => {
    const prefix = normalizeScopePath(entry);
    const path = normalizeScopePath(target);
    if (!/[*?]/.test(prefix)) return path === prefix || path.startsWith(`${prefix}/`);
    return scopeGlob(prefix).test(path);
  });
  if (directMatch(file)) return true;
  const slashIdx = file.lastIndexOf("/");
  const baseName = slashIdx === -1 ? file : file.slice(slashIdx + 1);
  if (PACKAGE_LOCKFILES.has(baseName)) {
    const companionPkgJson = slashIdx === -1 ? "package.json" : `${file.slice(0, slashIdx)}/package.json`;
    if (directMatch(companionPkgJson)) return true;
  }
  return false;
}
function scopeRecoveryCommands(base, files) {
  const quote = (value) => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
  return files.map((file) => `git restore --source=${quote(base)} -- ${quote(file)}`).join("; ");
}
function normalizeScopePath(path) {
  return path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}
function scopeGlob(pattern) {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        expression += "(?:[^/]+/)*";
        i++;
      } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PACKAGE_LOCKFILES,
  normalizeScopePath,
  scopeCoversFile,
  scopeGlob,
  scopeRecoveryCommands
});

return module.exports;
})();
// END GENERATED SCOPE POLICY

function extractShellWriteTargets(command) {
  const targets = [];
  const tokens = shellTokens(command);
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

// BEGIN GENERATED PROCESS TARGET POLICY
import { createRequire as processTargetPolicyRequire } from "node:module";
const processTargetPolicy = (() => {
const require = processTargetPolicyRequire(import.meta.url);
const module = { exports: {} };
// Generated by scripts/generate-policies.mjs from checked TypeScript. Do not edit.
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/process-policy.ts
var process_policy_exports = {};
__export(process_policy_exports, {
  inheritChildOutcome: () => inheritChildOutcome,
  isFactoryInfrastructureProcess: () => isFactoryInfrastructureProcess,
  isTaskWorktreeScopedProcess: () => isTaskWorktreeScopedProcess,
  killProcessGroup: () => killProcessGroup
});
module.exports = __toCommonJS(process_policy_exports);
function killProcessGroup(child, signal = "SIGKILL") {
  if (child.pid === void 0 || process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
function inheritChildOutcome(child, onError) {
  const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(forwarded.map((signal) => [signal, () => {
    child.kill(signal);
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.on("error", (error) => {
    onError(error);
    process.exit(127);
  });
  child.on("close", (code, signal) => {
    if (signal !== null) {
      for (const [forwardedSignal, handler] of handlers) process.removeListener(forwardedSignal, handler);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}
function isFactoryInfrastructureProcess(text) {
  return /(?:^|[\s/])paseo(?:\s|$)|Paseo\.app|Paseo Helper|paseo-factory\/bin\/|runtime-bin\/|(?:bridge|driver|factory|claim)\.mjs|plugin-process|opencode/i.test(text.replace(/\\/g, "/"));
}
function isTaskWorktreeScopedProcess(text) {
  const normalized = text.replace(/\\/g, "/");
  const paths = /[^\s"'`;|&]*\/projects\/[^/\s"'`;|&]+\/worktrees\/[^/\s"'`;|&]+(?:\/[^\s"'`;|&]*)?/g;
  return paths.test(normalized) && !/(?:^|\/)\.\.(?:\/|$)/.test(normalized) && !isFactoryInfrastructureProcess(normalized) && !/plugin-process|paseo|opencode/i.test(normalized.replace(paths, ""));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  inheritChildOutcome,
  isFactoryInfrastructureProcess,
  isTaskWorktreeScopedProcess,
  killProcessGroup
});

return module.exports;
})();
// END GENERATED PROCESS TARGET POLICY
const { isFactoryInfrastructureProcess, isTaskWorktreeScopedProcess } = processTargetPolicy;

// ---- process-kill rule (v0.0.84: command-position gate; mirrors src/choke.ts) -----------------

const PROCESS_KILL_WORDS = new Set(["pkill", "killall", "kill"]);
// BEGIN GENERATED SHELL HEREDOC POLICY
import { createRequire as shellHeredocPolicyRequire } from "node:module";
const shellHeredocPolicy = (() => {
const require = shellHeredocPolicyRequire(import.meta.url);
const module = { exports: {} };
// Generated by scripts/generate-policies.mjs from checked TypeScript. Do not edit.
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/shell-heredoc-policy.ts
var shell_heredoc_policy_exports = {};
__export(shell_heredoc_policy_exports, {
  PROCESS_KILL_WRAPPER_PREFIXES: () => PROCESS_KILL_WRAPPER_PREFIXES,
  inspectShellHeredocs: () => inspectShellHeredocs,
  isTimeoutOrNiceOperand: () => isTimeoutOrNiceOperand,
  quoteAwareWords: () => quoteAwareWords,
  rawShellSegments: () => rawShellSegments,
  stripNonInterpreterHeredocs: () => stripNonInterpreterHeredocs
});
module.exports = __toCommonJS(shell_heredoc_policy_exports);
var PROCESS_KILL_WRAPPER_PREFIXES = /* @__PURE__ */ new Set([
  "env",
  "command",
  "nohup",
  "sudo",
  "xargs",
  "exec",
  "timeout",
  "nice"
]);
function isTimeoutOrNiceOperand(token) {
  return /^[-+]?\d[\d.]*[a-z]?$/i.test(token) || token === "-n" || token === "--adjustment";
}
function rawShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "&" && command[i + 1] === "&" || ch === "|" && command[i + 1] === "|") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") segments.push(current.trim());
  return segments;
}
var HEREDOC_INTERPRETERS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "node", "python", "python3", "ruby", "perl", "php"]);
function heredocDelimiters(line) {
  const delimiters = [];
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;|&()]/.test(line[i - 1]))) break;
    if (line.startsWith("<<<", i)) {
      i += 2;
      continue;
    }
    if (!line.startsWith("<<", i)) continue;
    const match = /^<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/.exec(line.slice(i));
    if (match === null) continue;
    delimiters.push({ delimiter: match[2] ?? match[3] ?? match[4], tabs: match[1] !== void 0, expands: match[2] === void 0 && match[3] === void 0 });
    i += match[0].length - 1;
  }
  return delimiters;
}
function headerWithoutRedirections(header) {
  let result = "";
  let quote = null;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === "\\" && quote !== "'") {
      result += ch + (header[++i] ?? "");
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      result += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      result += ch;
      continue;
    }
    const redirect = /^(?:\d+)?(?:<<<|<<-?|>>|<>|<&|>&|[<>])\s*(?:'[^']*'|"[^"]*"|[^\s;|&<>]+)/.exec(header.slice(i));
    if (redirect !== null) {
      result += " ";
      i += redirect[0].length - 1;
      continue;
    }
    result += ch;
  }
  return result;
}
function heredocHeaderInvokesInterpreter(header) {
  return rawShellSegments(headerWithoutRedirections(header)).some((segment) => {
    const words = quoteAwareWords(segment);
    let i = 0;
    while (i < words.length) {
      const word = words[i];
      const bin = word.split("/").at(-1);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || bin === "export") {
        i++;
        continue;
      }
      if (!PROCESS_KILL_WRAPPER_PREFIXES.has(bin)) return HEREDOC_INTERPRETERS.has(bin);
      i++;
      while (i < words.length && words[i].startsWith("-")) {
        const option = words[i++];
        if (["-u", "--unset", "-C", "--chdir", "-n", "--adjustment"].includes(option)) i++;
      }
      if (bin === "timeout" && i < words.length && isTimeoutOrNiceOperand(words[i])) i++;
    }
    return false;
  });
}
function hasCommandSubstitution(body) {
  const joined = body.replaceAll("\\\n", "");
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "\\") {
      i++;
      continue;
    }
    if (joined[i] === "`" || joined.startsWith("$(", i)) return true;
  }
  return false;
}
function inspectShellHeredocs(command) {
  const lines = command.split("\n");
  const result = [];
  let interpreter = false;
  let commandSubstitution = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    result.push(header);
    const delimiters = heredocDelimiters(header);
    const preserve = delimiters.length > 0 && heredocHeaderInvokesInterpreter(header);
    interpreter ||= preserve;
    for (const { delimiter, tabs, expands } of delimiters) {
      const body = [];
      while (++i < lines.length) {
        const line = lines[i];
        if (preserve) result.push(line);
        if ((tabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "") === delimiter) break;
        body.push(line);
      }
      if (expands && hasCommandSubstitution(body.join("\n"))) commandSubstitution = true;
    }
  }
  return { command: result.join("\n"), interpreter, commandSubstitution };
}
function stripNonInterpreterHeredocs(command) {
  return inspectShellHeredocs(command).command;
}
function quoteAwareWords(segment) {
  const words = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") words.push(current);
  return words;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PROCESS_KILL_WRAPPER_PREFIXES,
  inspectShellHeredocs,
  isTimeoutOrNiceOperand,
  quoteAwareWords,
  rawShellSegments,
  stripNonInterpreterHeredocs
});

return module.exports;
})();
// END GENERATED SHELL HEREDOC POLICY
const { inspectShellHeredocs, stripNonInterpreterHeredocs, rawShellSegments: splitShellSegments, quoteAwareWords: quoteAwareTokens, PROCESS_KILL_WRAPPER_PREFIXES, isTimeoutOrNiceOperand } = shellHeredocPolicy;
const SHELL_DASH_C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

/** The quote-blind judgment tokenizer (mirrors src/choke.ts `shellTokens`). */
function shellTokens(command) {
  return command
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, "").replace(/^[;|&()$`]+|[;|&()$`]+$/g, ""))
    .filter(Boolean);
}

function commandWordIndex(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === "export" || PROCESS_KILL_WRAPPER_PREFIXES.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
      if (w === "timeout" || w === "nice") {
        while (i < words.length && isTimeoutOrNiceOperand(words[i])) i += 1;
      }
      continue;
    }
    break;
  }
  return i;
}

function killWordInCommandPosition(segment) {
  const words = quoteAwareTokens(segment);
  const cmd = words[commandWordIndex(words)];
  if (cmd === undefined) return false;
  return PROCESS_KILL_WORDS.has(cmd.split("/").at(-1) ?? cmd);
}

function killWordLeadsShellDashCPayload(segment) {
  const words = quoteAwareTokens(segment);
  const i = commandWordIndex(words);
  const shell = words[i];
  if (shell === undefined || !/sh$/.test(shell.split("/").at(-1) ?? shell)) return false;
  let j = i + 1;
  while (j < words.length && words[j].startsWith("-") && !SHELL_DASH_C_FLAG.test(words[j])) j += 1;
  if (j >= words.length || !SHELL_DASH_C_FLAG.test(words[j])) return false;
  const payload = words[j + 1];
  if (payload === undefined) return false;
  return PROCESS_KILL_WORDS.has(payload.split(/\s+/)[0] ?? payload);
}

function isProcessKillAgainstFactory(command) {
  if (!/\b(?:pkill|killall|kill)\b/.test(command)) return false;
  if (!/\b(?:plugin-process|paseo)\b/i.test(command) && !isFactoryInfrastructureProcess(command)) return false;
  for (const segment of splitShellSegments(command)) {
    if (killWordInCommandPosition(segment) || killWordLeadsShellDashCPayload(segment)) {
      if (!isTaskWorktreeScopedProcess(segment)) return true;
    }
  }
  return false;
}

const PROCESS_KILL_FENCE_MESSAGE =
  "process-kill fence: a pkill/kill/killall command aimed at Paseo or plugin-process is denied at ask time; the Layer-3 pkill/kill/killall shims (ADR 0016) still refuse it at exec time";

function isForbiddenSupervisorGit(command) {
  if (!/\bgit\b/.test(command)) return false;
  return /\bgit\s+(?:commit|merge|cherry-pick|rebase|am|apply|stash|reset|clean)\b/.test(command) ||
    /\bgit\s+checkout\s+(?:-[bB]|--)\b/.test(command) ||
    /\bgit\s+push\s+.*(?:--force|-f|--delete|-d)\b/.test(command);
}

function isForbiddenLeadGit(command) {
  if (!/\bgit\b/.test(command)) return false;
  return /\bgit\s+reset\s+.*--hard\b/.test(command) ||
    /\bgit\s+clean\s+.*(?:-f|--force)\b/.test(command) ||
    /\bgit\s+checkout\s+(?:-[fF]|--)\b/.test(command) ||
    /\bgit\s+branch\s+.*-D\b/.test(command) ||
    /\bgit\s+push\s+.*(?:--force|-f|--delete|-d)\b/.test(command);
}

function extractLeadGitStageTargets(command) {
  const targets = [];
  for (const segment of command.split(/(?:&&|\|\||;|\n)/)) {
    const tokens = quoteAwareTokens(segment);
    const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
    if (gitIdx === -1) continue;
    let subIdx = gitIdx + 1;
    while (subIdx < tokens.length && tokens[subIdx].startsWith("-")) {
      if (["-C", "-c", "--git-dir", "--work-tree"].includes(tokens[subIdx])) subIdx += 2;
      else subIdx += 1;
    }
    const sub = tokens[subIdx];
    if (sub !== "add" && sub !== "commit") continue;
    const args = tokens.slice(subIdx + 1);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        for (const rest of args.slice(i + 1)) {
          if (rest && rest !== ".") targets.push(rest);
        }
        break;
      }
      if (["-m", "--message", "-F", "--file", "--author", "--date", "-c", "-C"].includes(arg)) {
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      if (arg !== ".") targets.push(arg);
    }
  }
  return targets;
}

function resolveContext(payload) {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const stateDir = process.env.PASEO_FACTORY_STATE_DIR || join(home, "plugin-state", "paseo-factory");
  let seat = rawSeatEnv;
  const workspacePath =
    Array.isArray(payload?.workspacePaths) &&
    typeof payload.workspacePaths[0] === "string" &&
    payload.workspacePaths[0].trim() !== ""
      ? payload.workspacePaths[0].trim()
      : "";
  const payloadCwd = typeof payload?.cwd === "string" && payload.cwd.trim() !== "" ? payload.cwd.trim() : "";
  let projectRoot = process.env.PASEO_FACTORY_PROJECT_ROOT || payloadCwd || workspacePath || process.cwd();
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

/**
 * The Task's Contract, read from the OWNING Project's isolated ledger
 * (v0.0.92, ADR 0045 §1): the correlation-bound `projectSlug` first, then a
 * scan of every per-Project ledger under `<stateDir>/projects/` for the Task's
 * `contract_set`, and only then the legacy root `<stateDir>/ledger.jsonl`.
 * The loose per-line parse stays (a PreToolUse gate must tolerate a mid-write
 * tail) — resolution picks the FILE, never the parse policy.
 */
function loadContractForTask(stateDir, task, projectSlug) {
  if (!stateDir || !task) return null;
  const candidates = [];
  if (typeof projectSlug === "string" && projectSlug.trim() !== "") {
    candidates.push(join(stateDir, "projects", projectSlug.trim(), "ledger.jsonl"));
  }
  for (const stream of projectLedgerStreams(stateDir)) {
    if (!candidates.includes(stream.path) && existsSync(stream.path)) candidates.push(stream.path);
  }
  candidates.push(join(stateDir, "ledger.jsonl"));
  for (const ledgerPath of candidates) {
    try {
      if (!existsSync(ledgerPath)) continue;
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
      if (contract) return { ...contract, worktree };
    } catch {
      // an unreadable candidate is skipped, never trusted
    }
  }
  return null;
}

function allow() {
  process.stdout.write('{"decision":"allow"}\n');
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
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

  const ctx = resolveContext(payload);
  if (ctx.seat !== "supervisor" && ctx.seat !== "lead" && ctx.seat !== "agent") {
    allow();
  }

  const toolCallObj =
    typeof payload.toolCall === "object" && payload.toolCall !== null ? payload.toolCall : null;
  const toolName = String(
    toolCallObj?.name ?? payload.tool_name ?? payload.toolName ?? payload.name ?? "",
  ).trim();
  const rawInput =
    toolCallObj?.args ??
    toolCallObj?.arguments ??
    payload.tool_input ??
    payload.toolInput ??
    payload.input ??
    payload.arguments;
  const toolInput =
    typeof rawInput === "object" && rawInput !== null ? rawInput : {};
  const mcpCalledToolName =
    toolName === "call_mcp_tool" ? String(toolInput.ToolName ?? toolInput.toolName ?? "").trim() : "";

  if (
    FORBIDDEN_PASEO_TOOLS.has(toolName) ||
    toolName.startsWith("mcp__paseo__") ||
    (mcpCalledToolName !== "" && (FORBIDDEN_PASEO_TOOLS.has(mcpCalledToolName) || mcpCalledToolName.startsWith("mcp__paseo__")))
  ) {
    const blockedName = mcpCalledToolName || toolName;
    deny(
      `Direct Paseo agent-lifecycle tool "${blockedName}" is forbidden for factory seats (seat-paseo-tool-fence); use paseo_factory MCP tools instead.`,
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
      const heredocs = inspectShellHeredocs(String(toolInput.CommandLine ?? toolInput.command ?? toolInput.cmd ?? "").trim());
      const cmd = heredocs.command;
      if (isProcessKillAgainstFactory(cmd)) {
        deny(PROCESS_KILL_FENCE_MESSAGE);
      }
      if (heredocs.interpreter || heredocs.commandSubstitution) {
        deny("Seat write fence: Supervisor and Lead may only write project memory/docs (AGENTS.md, CONTEXT.md, docs/**, .scratch/**); dispatch implementation work to Lead / Task Agents");
      }
      if (ctx.seat === "supervisor" && isForbiddenSupervisorGit(cmd)) {
        deny("Seat git fence: Supervisor may not run destructive or committing git commands on <project-root>.");
      }
      if (ctx.seat === "lead" && isForbiddenLeadGit(cmd)) {
        deny("Seat git fence: Lead may not run destructive git commands on <project-root>.");
      }
      if (ctx.seat === "lead") {
        for (const target of extractLeadGitStageTargets(cmd)) {
          if (!isSeatWriteAllowed(ctx.projectRoot, target, ctx.stateDir)) {
            deny(
              "Seat git fence (lead-git-fence): Lead may only stage/commit project memory/docs (AGENTS.md, CONTEXT.md, GLOSSARY.md, docs/**, .scratch/**); dispatch implementation work to Task Agents",
            );
          }
        }
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
    const contract = loadContractForTask(ctx.stateDir, ctx.task, ctx.projectSlug);
    const baseRoot = stripTrailingSlash(resolve(contract?.worktree ?? contract?.workspace ?? ctx.projectRoot ?? process.cwd()));
    const resolvedState = ctx.stateDir ? stripTrailingSlash(resolve(ctx.stateDir)) : "";
    // The read-only three (ADR 0053 §3, ticket 05) — the plain-JS mirror of
    // src/events.ts's READ_ONLY_PEER_DISPOSITIONS: this hook cannot import the
    // TS core, so the three names live here too. A read-only Peer's writes
    // deny at Layer 1 (here) exactly as they do at Layer 2 (the choke judges)
    // and Layer 3 (the git shim) — strictly read-only, no scope opt-in.
    const readOnlyDisposition = READ_ONLY_DISPOSITIONS.has(contract?.disposition) ? contract.disposition : null;

    const checkAgentPath = (rawTarget) => {
      const raw = String(rawTarget ?? "").trim();
      if (raw === "" || raw === "/dev/null") return null;
      const resolvedCandidate = stripTrailingSlash(isAbsolute(raw) ? resolve(raw) : resolve(baseRoot, raw));
      if (isProtectedStatePath(resolvedCandidate, resolvedState, contract?.worktree)) {
        return `Write to protected factory state path "${raw}" is forbidden (seat-write-fence).`;
      }
      if (resolvedCandidate.startsWith(`${baseRoot}/`)) {
        const rel = resolvedCandidate.slice(baseRoot.length + 1);
        if (readOnlyDisposition) {
          return `Write to ${rel} is fenced (read-only-disposition-fence) — the ${readOnlyDisposition} disposition is read-only; deliver findings in the 6-Field Handoff at agent_claim.`;
        }
        if (["AGENTS.md", "CLAUDE.md", "CONTEXT.md"].includes(rel)) {
          if (!Array.isArray(contract?.scope) || !scopePolicy.scopeCoversFile(contract.scope, rel)) {
            return `Write to ${rel} is fenced (policy:memory-write-fenced).`;
          }
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
      const heredocs = inspectShellHeredocs(String(toolInput.CommandLine ?? toolInput.command ?? toolInput.cmd ?? "").trim());
      const cmd = heredocs.command;
      if (isProcessKillAgainstFactory(cmd)) {
        deny(PROCESS_KILL_FENCE_MESSAGE);
      }
      if (heredocs.commandSubstitution) deny("Executable command substitution in an expanding heredoc cannot be treated as literal text (seat-write-fence).");
      for (const target of extractShellWriteTargets(cmd)) {
        const err = checkAgentPath(target);
        if (err) deny(err);
      }
      allow();
    }
  }

  allow();
});
