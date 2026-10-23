#!/usr/bin/env node
/**
 * bridge.mjs — Role-scoped MCP bridge (`paseo_factory`, v0.0.26, ADR 0016 §1).
 *
 * Zero-dependency Node ESM stdio JSON-RPC 2.0 MCP server supporting both
 * newline-delimited JSON-RPC 2.0 frames and Content-Length framed JSON-RPC 2.0
 * messages. Authenticates the calling seat (`supervisor`, `lead`, `agent`, or
 * unbound) via CLI flags, process environment, parent process environment, and
 * `<stateDir>/correlations.json`, and exposes strictly role-scoped tools over
 * the single-writer Spool.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_WAIT_MS = 60_000;
const GIT_TIMEOUT_MS = 15_000;

/**
 * The spool round-trip wait, overridable for tests and tight operator loops
 * through `PASEO_FACTORY_SPOOL_WAIT_MS` (milliseconds); anything that is not a
 * positive finite number keeps the 60s default.
 */
function resolveSpoolWaitMs() {
  const raw = process.env.PASEO_FACTORY_SPOOL_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WAIT_MS;
}
const SPOOL_WAIT_MS = resolveSpoolWaitMs();

/**
 * Stable JSON serialization of any value — object keys sorted, recursively
 * (arrays keep their order). Pure: the same body always serializes to the
 * same string.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The canonical semantic key of a spool request (v0.0.31, ADR 0017 §6): the
 * stable JSON serialization of every request field EXCEPT `id`. Duplicated on
 * purpose in `plugin/bin/spool-client.mjs` and `plugin/server/spool.ts` — this
 * file is copied standalone into `<stateDir>/bin/bridge.mjs`, so it may import
 * no sibling module — with `test/cli.test.ts` guarding the copies against
 * drift.
 */
function spoolRequestSemanticKey(req) {
  if (req !== null && typeof req === "object" && !Array.isArray(req) && "id" in req) {
    const rest = { ...req };
    delete rest.id;
    return stableStringify(rest);
  }
  return stableStringify(req);
}

/**
 * Scans `spool/requests/*.json` (filename order = submission order) for an
 * un-replied request whose semantic key matches — the offline-dedup seam
 * (ADR 0017 §6). Returns `{ id, path }` of the pending original, or undefined.
 */
function findPendingSemanticDuplicate(spoolRoot, request) {
  const requestsDir = join(spoolRoot, "requests");
  let names;
  try {
    names = readdirSync(requestsDir).sort();
  } catch {
    return undefined;
  }
  const key = spoolRequestSemanticKey(request);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (existsSync(join(spoolRoot, "replies", name))) continue;
    let body;
    try {
      body = JSON.parse(readFileSync(join(requestsDir, name), "utf8"));
    } catch {
      continue; // a half-written or corrupt file is never a dedup match
    }
    if (spoolRequestSemanticKey(body) === key) {
      return { id: name.slice(0, -".json".length), path: join(requestsDir, name) };
    }
  }
  return undefined;
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--correlation" && i + 1 < argv.length) out.correlationId = argv[++i];
    else if (arg === "--role" && i + 1 < argv.length) out.role = argv[++i];
    else if (arg === "--state-dir" && i + 1 < argv.length) out.stateDir = argv[++i];
    else if (arg === "--project" && i + 1 < argv.length) out.projectSlug = argv[++i];
    else if (arg === "--workspace" && i + 1 < argv.length) out.workspace = argv[++i];
    else if (arg === "--task" && i + 1 < argv.length) out.task = argv[++i];
    else if (arg === "--home" && i + 1 < argv.length) out.home = argv[++i];
  }
  return out;
}

function expandHome(raw) {
  if (raw === "~") return homedir();
  if (typeof raw === "string" && raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

function readParentProcessEnv() {
  if (process.platform === "win32" || typeof process.ppid !== "number" || process.ppid <= 1) return {};
  try {
    const out = execFileSync("ps", ["eww", "-o", "command=", "-p", String(process.ppid)], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const env = {};
    const keys = [
      "PASEO_FACTORY_CORRELATION",
      "PASEO_FACTORY_SEAT",
      "PASEO_FACTORY_STATE_DIR",
      "PASEO_FACTORY_PROJECT",
      "PASEO_AGENT_ID",
      "PASEO_AGENT_CWD",
      "PASEO_HOME",
    ];
    for (const key of keys) {
      const re = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`);
      const m = re.exec(out);
      if (m && m[1]) env[key] = m[1];
    }
    return env;
  } catch {
    return {};
  }
}

function readCorrelationsFile(stateDir) {
  const path = join(stateDir, "correlations.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray(parsed.records)
        ? parsed.records
        : [];
    return list.filter((r) => typeof r === "object" && r !== null && typeof r.correlationId === "string");
  } catch {
    return [];
  }
}

function resolveProjectFromDir(cwd) {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = stdout.trim().split("\n");
    const root = (lines[0] ?? "").trim();
    const commonDirRaw = (lines[1] ?? "").trim();
    if (root === "" || commonDirRaw === "") return null;
    const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwd, commonDirRaw);
    const gitCommonDir = realpathSync(commonDirAbs);
    const hash = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 6);
    return { root, gitCommonDir, slug: `${basename(root)}-${hash}` };
  } catch {
    return null;
  }
}

const cliFlags = parseCliArgs(process.argv.slice(2));
let cachedParentEnv = null;

function resolveBridgeContext() {
  const env = process.env;
  const needParentFallback =
    !cliFlags.correlationId &&
    !env.PASEO_FACTORY_CORRELATION &&
    !cliFlags.role &&
    !env.PASEO_FACTORY_SEAT;
  if (needParentFallback && cachedParentEnv === null) {
    cachedParentEnv = readParentProcessEnv();
  }
  const pEnv = cachedParentEnv ?? {};

  const homeRaw =
    cliFlags.home ??
    env.PASEO_HOME ??
    pEnv.PASEO_HOME ??
    join(homedir(), ".paseo");
  const home = expandHome(homeRaw);
  const stateDir = expandHome(
    cliFlags.stateDir ??
      env.PASEO_FACTORY_STATE_DIR ??
      pEnv.PASEO_FACTORY_STATE_DIR ??
      join(home, "plugin-state", "paseo-factory"),
  );

  const correlationId =
    (cliFlags.correlationId ?? env.PASEO_FACTORY_CORRELATION ?? pEnv.PASEO_FACTORY_CORRELATION ?? "").trim() || undefined;
  const agentId = (env.PASEO_AGENT_ID ?? pEnv.PASEO_AGENT_ID ?? "").trim() || undefined;

  let record;
  if (correlationId || agentId) {
    const records = readCorrelationsFile(stateDir);
    if (correlationId) {
      record = records.find((r) => r.correlationId === correlationId);
    }
    if (!record && agentId) {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].agentId === agentId) {
          record = records[i];
          break;
        }
      }
    }
  }

  const rawRole = (
    record?.role ??
    cliFlags.role ??
    env.PASEO_FACTORY_SEAT ??
    pEnv.PASEO_FACTORY_SEAT ??
    ""
  ).trim();
  const role = rawRole === "supervisor" || rawRole === "lead" || rawRole === "agent" ? rawRole : undefined;

  const workspace =
    (cliFlags.workspace ?? record?.projectRoot ?? env.PASEO_AGENT_CWD ?? pEnv.PASEO_AGENT_CWD ?? process.cwd()).trim();
  let projectSlug =
    (record?.projectSlug ?? cliFlags.projectSlug ?? env.PASEO_FACTORY_PROJECT ?? pEnv.PASEO_FACTORY_PROJECT ?? "").trim() ||
    undefined;
  let projectRoot = record?.projectRoot;

  if ((!projectSlug || !projectRoot) && workspace) {
    const resolved = resolveProjectFromDir(workspace);
    if (resolved) {
      if (!projectSlug) projectSlug = resolved.slug;
      if (!projectRoot) projectRoot = resolved.root;
    }
  }

  const task = (record?.task ?? cliFlags.task ?? "").trim() || undefined;
  const effectiveAgentId = record?.agentId ?? agentId;

  return {
    home,
    stateDir,
    spoolRoot: join(stateDir, "spool"),
    correlationId: record?.correlationId ?? correlationId,
    agentId: effectiveAgentId,
    role,
    projectSlug,
    projectRoot,
    workspace,
    task,
  };
}

function randomId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Drops a request file and returns its path — unless an un-replied request
 * with the identical semantic payload already sits in `spool/requests/`
 * (v0.0.31, ADR 0017 §6), in which case that pending request's id and file are
 * reused and NO second file is written: a `Peer` retrying `agent_claim` while
 * the plugin process is stopped stacks zero duplicate files. On dedup the
 * incoming `request.id` is mutated to the reused id, so the caller polls the
 * reply of the request that is actually queued.
 */
function submitSpoolRequest(spoolRoot, request) {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const pending = findPendingSemanticDuplicate(spoolRoot, request);
  if (pending !== undefined) {
    request.id = pending.id;
    return pending.path;
  }
  const path = join(requestsDir, `${request.id}.json`);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(request)}\n`);
  renameSync(tmp, path);
  return path;
}

function awaitSpoolReply(spoolRoot, id, timeoutMs = DEFAULT_WAIT_MS, pollMs = 50) {
  const replyPath = join(spoolRoot, "replies", `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const tick = () => {
      if (existsSync(replyPath)) {
        try {
          resolvePromise(JSON.parse(readFileSync(replyPath, "utf8")));
          return;
        } catch {
          // retry if mid-rename
        }
      }
      if (Date.now() >= deadline) {
        resolvePromise(null);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

async function roundTripSpool(ctx, request, timeoutMs = SPOOL_WAIT_MS) {
  const submitter = ctx.agentId ?? ctx.correlationId ?? ctx.role ?? "owner";
  const payload = {
    ...request,
    ...(request.submitter === undefined && request.kind !== "claim" ? { submitter } : {}),
    ...(ctx.role !== undefined && request.seat === undefined && request.kind !== "claim" ? { seat: ctx.role } : {}),
  };
  submitSpoolRequest(ctx.spoolRoot, payload);
  const reply = await awaitSpoolReply(ctx.spoolRoot, payload.id, timeoutMs);
  if (reply === null) {
    // The stop-on-timeout instruction (v0.0.31, ADR 0017 §6): the single
    // deduplicated request stays durably queued in spool/requests/ — the
    // plugin resumes the pipeline when reloaded — so the caller must stop
    // retrying and end its turn immediately. This bridge NEVER auto-reloads
    // or restarts plugins behind the Owner's back (spec §Out of Scope).
    return {
      ok: false,
      code: "spool-timeout",
      message:
        `No reply from the factory plugin after ${Math.round(timeoutMs / 1000)}s (request ${payload.id} remains queued in spool/requests/). ` +
        `The paseo-factory plugin may be stopped — DO NOT retry or call this tool again; end your turn immediately so the plugin can process the queued request when reloaded.`,
    };
  }
  return reply;
}

// BEGIN GENERATED LEDGER POLICY
import { createRequire as ledgerValidationPolicyRequire } from "node:module";
const ledgerValidationPolicy = (() => {
const require = ledgerValidationPolicyRequire(import.meta.url);
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

// src/ledger-validation.ts
var ledger_validation_exports = {};
__export(ledger_validation_exports, {
  isValidLedgerEvent: () => isValidLedgerEvent,
  parseLedgerJsonl: () => parseLedgerJsonl,
  usageIsValid: () => usageIsValid
});
module.exports = __toCommonJS(ledger_validation_exports);

// src/events.ts
var EVENT_NAMES = [
  "contract_set",
  "claim_reported",
  "gate_started",
  "gate_finished",
  "fresh_eyes_written",
  "watch_written",
  "report_written",
  "attempt_accepted",
  "permit_allowed",
  "permit_denied",
  "git_blocked",
  "spawn_dispatched",
  "spawn_refused",
  "meter_written",
  "repoke_dispatched",
  "repoke_refused",
  "respawn_dispatched",
  "respawn_refused",
  "needs_human",
  "retro_written"
];
var NEEDS_HUMAN_REASONS = ["denied-again", "silent-after-repoke", "attempt-ceiling", "died-after-respawn"];
function posInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
function needsHumanEvidenceIsValid(evidence, reason) {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
  const rec = evidence;
  if (Object.keys(rec).length !== 2) return false;
  const isDenialRepoke = posInt(rec.denial) && posInt(rec.repoke);
  const isAttemptGate = posInt(rec.attempt) && posInt(rec.gate);
  const isSpawnRespawn = posInt(rec.spawn) && posInt(rec.respawn);
  if (reason === "denied-again" || reason === "silent-after-repoke") return isDenialRepoke;
  if (reason === "attempt-ceiling") return isAttemptGate;
  if (reason === "died-after-respawn") return isSpawnRespawn;
  if (reason !== void 0) return false;
  return isDenialRepoke || isAttemptGate || isSpawnRespawn;
}

// src/ledger-validation.ts
function isValidLedgerEvent(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value;
  return (event.schema_version === void 0 || event.schema_version === 1) && Number.isSafeInteger(event.seq) && event.seq > 0 && typeof event.ts === "string" && typeof event.event === "string" && EVENT_NAMES.includes(event.event) && shapeIsValid(value);
}
function parseLedgerJsonl(raw, options = {}) {
  const lines = raw.split("\n");
  lines.pop();
  const events = [];
  let previousSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = i + 1;
    if (line === "") return { corrupt: `blank line at line ${at}` };
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return { corrupt: `line ${at} is not valid JSON` };
    }
    if (!isValidLedgerEvent(value) || value.seq <= previousSeq || options.validateEvent !== void 0 && !options.validateEvent(value)) {
      return { corrupt: `line ${at} is not a valid ledger event` };
    }
    previousSeq = value.seq;
    events.push(value);
  }
  return { events };
}
function shapeIsValid(evt) {
  const asRecord = evt;
  const taskIsString = typeof asRecord.task === "string";
  if (evt.event === "contract_set") return taskIsString;
  if (evt.event === "retro_written") {
    return typeof asRecord.model === "string" && (asRecord.outcome === "written" || asRecord.outcome === "failed") && typeof asRecord.durationMs === "number" && Number.isFinite(asRecord.durationMs) && asRecord.durationMs >= 0;
  }
  if (evt.event === "permit_allowed" || evt.event === "permit_denied") {
    return taskIsString && typeof asRecord.agent === "string" && (evt.event === "permit_allowed" || typeof asRecord.rule === "string");
  }
  if (evt.event === "git_blocked") {
    return (asRecord.task === void 0 || taskIsString) && (asRecord.agent === void 0 || typeof asRecord.agent === "string") && typeof asRecord.command === "string" && typeof asRecord.rule === "string" && typeof asRecord.cwd === "string" && typeof asRecord.blockId === "string";
  }
  if (evt.event === "spawn_dispatched" || evt.event === "spawn_refused") {
    return taskIsString && typeof asRecord.provider === "string" && typeof asRecord.arity === "number" && Number.isInteger(asRecord.arity) && asRecord.arity >= 1 && (evt.event === "spawn_dispatched" || typeof asRecord.rule === "string" && typeof asRecord.reason === "string");
  }
  if (evt.event === "meter_written") {
    return taskIsString && typeof asRecord.provider === "string" && (asRecord.agent === void 0 || typeof asRecord.agent === "string") && usageIsValid(asRecord.usage);
  }
  if (evt.event === "repoke_dispatched" || evt.event === "repoke_refused") {
    return taskIsString && typeof asRecord.agent === "string" && (evt.event === "repoke_dispatched" || typeof asRecord.rule === "string" && typeof asRecord.reason === "string");
  }
  if (evt.event === "respawn_dispatched" || evt.event === "respawn_refused") {
    return taskIsString && typeof asRecord.provider === "string" && typeof asRecord.died_agent === "string" && (evt.event === "respawn_dispatched" || typeof asRecord.rule === "string" && typeof asRecord.reason === "string");
  }
  if (evt.event === "needs_human") {
    return taskIsString && typeof asRecord.reason === "string" && NEEDS_HUMAN_REASONS.includes(asRecord.reason) && needsHumanEvidenceIsValid(asRecord.evidence, asRecord.reason);
  }
  const attempt = asRecord.attempt;
  return taskIsString && typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1;
}
function usageIsValid(usage) {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return false;
  for (const [key, value] of Object.entries(usage)) {
    if (!["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd"].includes(key)) return false;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  return true;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isValidLedgerEvent,
  parseLedgerJsonl,
  usageIsValid
});

return module.exports;
})();
// END GENERATED LEDGER POLICY

function readLedgerEventsList(stateDir) {
  const ledgerPath = join(stateDir, "ledger.jsonl");
  let raw;
  try { raw = readFileSync(ledgerPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`cannot read ${ledgerPath}: ${error.message}`);
  }
  const read = ledgerValidationPolicy.parseLedgerJsonl(raw);
  if (read.corrupt !== undefined) throw new Error(`${ledgerPath} is not a readable ledger: ${read.corrupt}`);
  return read.events;
}

function formatFactoryStatus(stateDir, workspaceFilter) {
  const events = readLedgerEventsList(stateDir);
  if (events.length === 0) {
    return `factory: no tasks yet (ledger: ${join(stateDir, "ledger.jsonl")})`;
  }
  const NO_ATTEMPT_EVENTS = new Set([
    "contract_set",
    "permit_allowed",
    "permit_denied",
    "git_blocked",
    "spawn_dispatched",
    "spawn_refused",
    "meter_written",
    "repoke_dispatched",
    "repoke_refused",
    "respawn_dispatched",
    "respawn_refused",
    "needs_human",
    "retro_written",
  ]);
  const order = [];
  const byTask = new Map();
  let retro;
  for (const evt of events) {
    if (evt.event === "retro_written") {
      retro = evt;
      continue;
    }
    if (evt.event !== "contract_set" && NO_ATTEMPT_EVENTS.has(evt.event)) {
      const counted = byTask.get(evt.task);
      if (counted !== undefined) {
        if (evt.event === "permit_allowed") counted.allowed += 1;
        else if (evt.event === "permit_denied") counted.denied += 1;
        else if (evt.event === "git_blocked") counted.blocked += 1;
        else if (evt.event === "needs_human") counted.needsHuman = evt.reason;
      }
      continue;
    }
    let state = byTask.get(evt.task);
    if (state === undefined) {
      state = {
        attempts: 0,
        verdict: undefined,
        sha: undefined,
        eye: undefined,
        accepted: false,
        allowed: 0,
        denied: 0,
        blocked: 0,
        needsHuman: undefined,
        workspace: undefined,
      };
      byTask.set(evt.task, state);
      order.push(evt.task);
    }
    if (evt.event === "contract_set") {
      state.workspace = evt.workspace;
      if (!state.accepted) {
        state.attempts = 0;
        state.verdict = undefined;
        state.sha = undefined;
        state.eye = undefined;
        state.needsHuman = undefined;
        state.allowed = 0;
        state.denied = 0;
        state.blocked = 0;
      }
      continue;
    }
    if (evt.attempt > state.attempts) state.attempts = evt.attempt;
    if (evt.event === "gate_finished") {
      state.verdict = evt.verdict;
      state.sha = typeof evt.sha === "string" ? evt.sha.slice(0, 7) : undefined;
    }
    if (evt.event === "fresh_eyes_written") {
      state.eye = typeof evt.outcome === "string" ? evt.outcome : undefined;
    }
    if (evt.event === "attempt_accepted") state.accepted = true;
  }

  const lines = [];
  for (const task of order) {
    const s = byTask.get(task);
    if (workspaceFilter && s.workspace && s.workspace !== workspaceFilter) continue;
    lines.push(
      `${task} attempts=${s.attempts} verdict=${s.verdict ?? "-"} sha=${s.sha ?? "-"} accepted=${s.accepted ? "yes" : "no"} eye=${s.eye ?? "-"} choke=${s.allowed}/${s.denied}/${s.blocked}` +
        `${s.needsHuman === undefined ? "" : ` needs-human=${s.needsHuman}`}`,
    );
  }
  if (retro !== undefined) {
    const day = typeof retro.ts === "string" ? retro.ts.slice(0, 10) : "-";
    const count = retro.outcome === "written" && Number.isInteger(retro.proposalCount) ? ` proposals=${retro.proposalCount}` : "";
    lines.push(`retro last=${day} outcome=${retro.outcome ?? "-"}${count}`);
  }
  return lines.length > 0 ? lines.join("\n") : "factory: no matching tasks";
}

function allocateTaskWorktree(stateDir, contract, task, events = []) {
  const resolved = resolveProjectFromDir(contract.workspace);
  if (!resolved) {
    return { ok: false, reason: `workspace "${contract.workspace}" does not resolve to a git repository` };
  }
  let isRoot = false;
  try {
    isRoot = realpathSync(contract.workspace) === realpathSync(resolved.root);
  } catch {
    isRoot = contract.workspace === resolved.root;
  }
  if (!isRoot) {
    return { ok: true, legacy: true, cwd: contract.workspace, branch: task };
  }
  let baseCommit = contract.base;
  const contractSeq = typeof contract.seq === "number" ? contract.seq : -1;
  const upstreamLandedAfterContract =
    contractSeq >= 0 &&
    Array.isArray(events) &&
    events.some((e) => typeof e.seq === "number" && e.seq > contractSeq && e.event === "attempt_accepted") &&
    !events.some((e) => typeof e.seq === "number" && e.seq > contractSeq && e.task === task && e.event === "claim_reported");
  if (upstreamLandedAfterContract || typeof baseCommit !== "string" || !/^[0-9a-f]{40}$/i.test(baseCommit)) {
    const headOut = spawnSync("git", ["rev-parse", "HEAD"], { cwd: resolved.root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
    if (headOut.status !== 0) {
      return { ok: false, reason: `cannot resolve HEAD in ${resolved.root}` };
    }
    baseCommit = headOut.stdout.trim();
  }
  const worktreePath = join(stateDir, "projects", resolved.slug, "worktrees", task);
  const branch = `factory/${task}`;
  if (existsSync(worktreePath)) {
    const branchOut = spawnSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    const ancestorOut = spawnSync("git", ["-C", worktreePath, "merge-base", "--is-ancestor", baseCommit, "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (branchOut.status === 0 && branchOut.stdout.trim() === branch && ancestorOut.status === 0) {
      worktreePolicy.hydrateTaskWorktree(resolved.root, worktreePath, { copyIncludes: false });
      return { ok: true, cwd: worktreePath, branch, worktree: worktreePath, reused: true };
    }
    const rmOut = spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: resolved.root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (rmOut.status !== 0) {
      rmSync(worktreePath, { recursive: true, force: true });
      spawnSync("git", ["worktree", "prune"], { cwd: resolved.root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
    }
  } else {
    spawnSync("git", ["worktree", "prune"], { cwd: resolved.root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  }
  const addOut = spawnSync("git", ["worktree", "add", "-B", branch, worktreePath, baseCommit], {
    cwd: resolved.root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (addOut.status !== 0) {
    return { ok: false, reason: `could not create worktree at ${worktreePath}: ${(addOut.stderr || "").trim()}` };
  }
  worktreePolicy.hydrateTaskWorktree(resolved.root, worktreePath);
  return { ok: true, cwd: worktreePath, branch, worktree: worktreePath };
}

// BEGIN GENERATED WORKTREE POLICY
import { createRequire as worktreePolicyRequire } from "node:module";
const worktreePolicy = (() => {
const require = worktreePolicyRequire(import.meta.url);
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

// src/worktree-policy.ts
var worktree_policy_exports = {};
__export(worktree_policy_exports, {
  hydrateTaskWorktree: () => hydrateTaskWorktree,
  worktreeIncludeMatches: () => worktreeIncludeMatches
});
module.exports = __toCommonJS(worktree_policy_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// src/scope-policy.ts
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

// src/worktree-policy.ts
function gitIn(cwd, args) {
  return (0, import_node_child_process.spawnSync)("git", args, { cwd, encoding: "utf8", timeout: 15e3 });
}
function worktreeIncludeMatches(pattern, file) {
  const clean = normalizeScopePath(pattern);
  return pattern.endsWith("/") ? file.startsWith(`${clean}/`) : scopeGlob(clean).test(file);
}
function hydrateTaskWorktree(root, worktree, options = {}) {
  const excluded = [];
  if (options.copyIncludes !== false) {
    let raw = "";
    try {
      raw = (0, import_node_fs.readFileSync)((0, import_node_path.join)(root, ".worktreeinclude"), "utf8");
    } catch {
    }
    const patterns = raw.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    const candidates = /* @__PURE__ */ new Set();
    if (patterns.length > 0) {
      for (const extra of [[], ["--ignored"]]) {
        const listed = gitIn(root, ["ls-files", "-z", "--others", "--exclude-standard", ...extra]);
        if (listed.error !== void 0 || listed.status !== 0) continue;
        for (const file of listed.stdout.split("\0")) if (file !== "") candidates.add(file);
      }
    }
    for (const file of candidates) {
      if (!patterns.some((pattern) => worktreeIncludeMatches(pattern, file))) continue;
      const source = (0, import_node_path.join)(root, file);
      const target = (0, import_node_path.join)(worktree, file);
      try {
        if (!(0, import_node_fs.statSync)(source).isFile()) continue;
        (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(target), { recursive: true });
        (0, import_node_fs.cpSync)(source, target);
        excluded.push(file);
      } catch {
      }
    }
  }
  if (options.inheritNodeModules !== false && inheritNodeModules(root, worktree)) excluded.push("node_modules");
  excludeFromWorktree(root, worktree, excluded);
}
function inheritNodeModules(root, worktree) {
  const source = (0, import_node_path.join)(root, "node_modules");
  const target = (0, import_node_path.join)(worktree, "node_modules");
  try {
    if (!(0, import_node_fs.statSync)(source).isDirectory()) return false;
    try {
      (0, import_node_fs.lstatSync)(target);
    } catch (error) {
      if (error.code !== "ENOENT") return false;
      (0, import_node_fs.symlinkSync)(source, target, process.platform === "win32" ? "junction" : "dir");
    }
    return true;
  } catch {
    return false;
  }
}
function excludeFromWorktree(root, worktree, files) {
  if (files.length === 0) return;
  try {
    const result = gitIn(worktree, ["rev-parse", "--git-dir"]);
    if (result.error !== void 0 || result.status !== 0) return;
    const excludes = (0, import_node_path.join)((0, import_node_path.resolve)(worktree, result.stdout.trim()), "factory-excludes");
    let existing = "";
    try {
      existing = (0, import_node_fs.readFileSync)(excludes, "utf8");
    } catch {
    }
    const patterns = /* @__PURE__ */ new Set([...existing.split("\n").filter(Boolean), ...files.map((file) => `/${file.replace(/[\\*?\[\] ]/g, "\\$&")}`)]);
    (0, import_node_fs.writeFileSync)(excludes, `${[...patterns].join("\n")}
`);
    gitIn(root, ["config", "extensions.worktreeConfig", "true"]);
    gitIn(worktree, ["config", "--worktree", "core.excludesFile", excludes]);
  } catch {
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  hydrateTaskWorktree,
  worktreeIncludeMatches
});

return module.exports;
})();
// END GENERATED WORKTREE POLICY

function resolveDefaultWorkerLane(stateDir, projectSlug) {
  const DEFAULT_LANE = "pi/zai/glm-5.3";
  try {
    if (projectSlug) {
      const projLanesPath = join(stateDir, "projects", projectSlug, "lanes.json");
      if (existsSync(projLanesPath)) {
        const parsed = JSON.parse(readFileSync(projLanesPath, "utf8"));
        if (typeof parsed?.worker === "string" && parsed.worker.trim() !== "") return parsed.worker.trim();
      }
    }
    const globalLanesPath = join(stateDir, "lanes.json");
    if (existsSync(globalLanesPath)) {
      const parsed = JSON.parse(readFileSync(globalLanesPath, "utf8"));
      if (typeof parsed?.worker === "string" && parsed.worker.trim() !== "") return parsed.worker.trim();
    }
  } catch {
    // fallback to default
  }
  return DEFAULT_LANE;
}

const TOOL_DEFINITIONS = {
  supervisor_dispatch_lead: {
    name: "supervisor_dispatch_lead",
    description:
      "Dispatch an implementation directive to the Project's Lead seat via the serialized Lead mailbox. After calling this tool, end your turn immediately and wait for Lead's wave report.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The directive text for Lead." },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["message"],
    },
  },
  supervisor_accept_task: {
    name: "supervisor_accept_task",
    description: "Accept a green Attempt of a Task on the Owner's behalf (`by: supervisor`).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to accept." },
        attempt: { type: "number", description: "1-indexed Attempt number to accept." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "attempt"],
    },
  },
  lead_set_contract: {
    name: "lead_set_contract",
    description:
      "Register a Task's immutable Contract (`gate`, `artifact`, optional `scope`, `skills`, `freshEyes`, `watch`, `description`) before spawning its working Agent.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Unique Task ID (letters, digits, '.', '_', '-')." },
        gate: { type: "string", description: "Gate command to verify the Task." },
        artifact: { type: "string", description: "Workspace-relative artifact path that must exist and be non-empty." },
        base: { type: "string", description: "Optional base commit SHA." },
        scope: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional comma-separated path prefixes or array of path prefixes the task may touch.",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of SKILL.md names the working Agent must open first.",
        },
        freshEyes: {
          type: "boolean",
          description:
            "Enable or disable the advisory fresh-eyes review pass on green verdicts (defaults to true for Lead when the freshEyes lane is usable; pass false to opt out).",
        },
        watch: { type: "boolean", description: "Enable the post-verdict watch pass." },
        description: { type: "string", description: "Optional task assignment description." },
        workspace: { type: "string", description: "Optional Project root path (defaults to current project root)." },
      },
      required: ["task", "gate", "artifact"],
    },
  },
  lead_spawn_agent: {
    name: "lead_spawn_agent",
    description:
      "Allocate isolated Task worktrees (`<projectStateDir>/worktrees/<task>` on branch `factory/<task>`) and dispatch working Agent(s) for the contracted Task(s). After calling this tool, end your turn immediately and wait for the completion report.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Task IDs to spawn working Agents for.",
        },
        provider: {
          type: "string",
          description: "Optional `<provider>/<model>[:<thinking>]` override (defaults to `lanes.worker`).",
        },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["tasks"],
    },
  },
  lead_accept_task: {
    name: "lead_accept_task",
    description:
      "Accept a green, CONCERN-free Attempt of a Task (`by: lead`) and land its Task worktree commit into `<project-root>`.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to accept." },
        attempt: { type: "number", description: "1-indexed Attempt number to accept." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "attempt"],
    },
  },
  lead_repoke_agent: {
    name: "lead_repoke_agent",
    description: "Spend the Task's single automatic re-poke on a stalled working Agent.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID to re-poke." },
        agent: { type: "string", description: "Optional target Agent ID (resolved automatically from task when omitted)." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task"],
    },
  },
  lead_needs_human: {
    name: "lead_needs_human",
    description:
      "Record a terminal `needs_human` escalation for a Task with its corroborating ledger sequence pair.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task ID." },
        reason: {
          type: "string",
          enum: ["denied-again", "silent-after-repoke", "attempt-ceiling", "died-after-respawn"],
          description: "Escalation reason.",
        },
        evidenceSeqs: {
          type: "array",
          items: { type: "number" },
          description: "Optional two ledger event sequence numbers corroborating `reason` (auto-resolved from ledger when omitted).",
        },
        summary: { type: "string", description: "Human-readable escalation summary." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["task", "reason", "summary"],
    },
  },
  lead_report_to_supervisor: {
    name: "lead_report_to_supervisor",
    description:
      "Send a wave completion or escalation report to the Project's Supervisor mailbox (`to: supervisor`, `from: lead`, `kind: report`). After calling this tool, end your turn immediately.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Report message for Supervisor." },
        workspace: { type: "string", description: "Optional Project root path." },
      },
      required: ["message"],
    },
  },
  agent_claim: {
    name: "agent_claim",
    description:
      "Submit a Claim for your bound Task in the Task worktree. Runs the Contract's Gate and returns the Verdict (`GREEN` or `RED`) and report.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Optional Task ID (defaults to your bound correlation Task)." },
        commit: { type: "string", description: "Optional git commit SHA (defaults to `git rev-parse HEAD` in the Task worktree)." },
      },
    },
  },
  agent_escalate_blocker: {
    name: "agent_escalate_blocker",
    description:
      "Escalate an unresolvable blocker (e.g., an edit required outside `--scope` or contradictory Contract criteria) to the Project's Lead mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Detailed blocker explanation for Lead." },
      },
      required: ["message"],
    },
  },
  factory_dispatch_supervisor: {
    name: "factory_dispatch_supervisor",
    description: "Route an Owner directive into a Project's Supervisor mailbox (`to: supervisor`).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Project repository root path." },
        message: { type: "string", description: "Directive message for Supervisor." },
      },
      required: ["workspace", "message"],
    },
  },
  factory_status: {
    name: "factory_status",
    description: "Return the Project's folded Ledger task digest (`attempts`, `verdict`, `sha`, `accepted`, `eye`, `choke`).",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional Project root path filter." },
      },
    },
  },
};

const ROLE_TOOL_NAMES = {
  supervisor: ["supervisor_dispatch_lead", "supervisor_accept_task", "factory_status"],
  lead: [
    "lead_set_contract",
    "lead_spawn_agent",
    "lead_accept_task",
    "lead_repoke_agent",
    "lead_needs_human",
    "lead_report_to_supervisor",
    "factory_status",
  ],
  agent: ["agent_claim", "agent_escalate_blocker"],
  unbound: ["factory_dispatch_supervisor", "factory_status"],
};

function getAllowedToolNames(role) {
  if (role === "supervisor" || role === "lead" || role === "agent") {
    return ROLE_TOOL_NAMES[role];
  }
  return ROLE_TOOL_NAMES.unbound;
}

function toolResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleToolCall(name, rawArgs) {
  const ctx = resolveBridgeContext();
  const allowed = getAllowedToolNames(ctx.role);
  if (!allowed.includes(name)) {
    return toolResult(
      `Tool "${name}" is not permitted for role "${ctx.role ?? "unbound"}". Allowed tools for this seat: ${allowed.join(", ")}.`,
      true,
    );
  }
  const args = typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {};

  if (name === "factory_status") {
    const ws = typeof args.workspace === "string" && args.workspace.trim() !== "" ? resolve(args.workspace.trim()) : undefined;
    return toolResult(formatFactoryStatus(ctx.stateDir, ws));
  }

  if (name === "factory_dispatch_supervisor") {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    const workspace = typeof args.workspace === "string" && args.workspace.trim() !== "" ? resolve(args.workspace.trim()) : ctx.projectRoot ?? ctx.workspace;
    if (message === "" || !workspace) {
      return toolResult("factory_dispatch_supervisor requires non-empty `workspace` and `message`.", true);
    }
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "supervisor_dispatch",
      workspace,
      message,
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(`${reply.summary}\nEnd your turn now and open the Supervisor session.`);
  }

  if (name === "supervisor_dispatch_lead") {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (message === "") return toolResult("supervisor_dispatch_lead requires a non-empty `message`.", true);
    const workspace =
      typeof args.workspace === "string" && args.workspace.trim() !== ""
        ? resolve(args.workspace.trim())
        : ctx.projectRoot ?? ctx.workspace;
    if (ctx.agentId && ctx.projectSlug) {
      const projPath = join(ctx.stateDir, "projects", ctx.projectSlug, "project.json");
      try {
        if (existsSync(projPath)) {
          const reg = JSON.parse(readFileSync(projPath, "utf8"));
          if (reg && typeof reg === "object" && reg.supervisor !== ctx.agentId) {
            reg.supervisor = ctx.agentId;
            writeFileSync(projPath, `${JSON.stringify(reg, null, 2)}\n`);
          }
        }
      } catch {
        // best-effort active supervisor binding update
      }
    }
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "lead_dispatch",
      ...(workspace ? { workspace } : ctx.projectSlug ? { project: ctx.projectSlug } : {}),
      from: "supervisor",
      message,
      seat: "supervisor",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(
      `${reply.summary}\nDirective dispatched to Lead (${reply.leadAgentId ?? "lead"}). End your turn immediately and wait for Lead's report.`,
    );
  }

  if (name === "supervisor_accept_task") {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const attempt = Number(args.attempt);
    if (task === "" || !Number.isInteger(attempt) || attempt < 1) {
      return toolResult("supervisor_accept_task requires `task` (string) and `attempt` (positive integer).", true);
    }
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "accept",
      task,
      attempt,
      by: "supervisor",
      seat: "supervisor",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(reply.summary);
  }

  if (name === "lead_set_contract") {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const gate = typeof args.gate === "string" ? args.gate.trim() : "";
    const artifact = typeof args.artifact === "string" ? args.artifact.trim() : "";
    if (task === "" || gate === "" || artifact === "") {
      return toolResult("lead_set_contract requires non-empty `task`, `gate`, and `artifact`.", true);
    }
    const workspace =
      typeof args.workspace === "string" && args.workspace.trim() !== ""
        ? resolve(args.workspace.trim())
        : ctx.projectRoot ?? ctx.workspace;
    let scope;
    if (typeof args.scope === "string" && args.scope.trim() !== "") {
      scope = args.scope
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (Array.isArray(args.scope)) {
      scope = args.scope.map((s) => String(s).trim()).filter(Boolean);
    }
    const skills = Array.isArray(args.skills)
      ? args.skills.map((s) => String(s).trim()).filter(Boolean)
      : undefined;
    const base =
      typeof args.base === "string" && args.base.trim() !== "" ? args.base.trim() : undefined;
    const description =
      typeof args.description === "string" && args.description.trim() !== "" ? args.description.trim() : undefined;

    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "contract",
      task,
      workspace,
      gate,
      artifact,
      ...(base ? { base } : {}),
      ...(scope && scope.length > 0 ? { scope } : {}),
      ...(skills && skills.length > 0 ? { skills } : {}),
      ...(typeof args.freshEyes === "boolean" ? { freshEyes: args.freshEyes } : {}),
      ...(args.watch === true ? { watch: true } : {}),
      ...(description ? { description } : {}),
      seat: "lead",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(reply.summary);
  }

  if (name === "lead_spawn_agent") {
    const tasks = Array.isArray(args.tasks)
      ? args.tasks.map((t) => String(t).trim()).filter(Boolean)
      : typeof args.task === "string" && args.task.trim() !== ""
        ? [args.task.trim()]
        : [];
    if (tasks.length === 0) {
      return toolResult("lead_spawn_agent requires `tasks` (non-empty array of task IDs).", true);
    }
    const defaultWorkerLane = resolveDefaultWorkerLane(ctx.stateDir, ctx.projectSlug);
    const rawProvider = typeof args.provider === "string" ? args.provider.trim() : "";
    let provider = defaultWorkerLane;
    if (
      rawProvider !== "" &&
      rawProvider !== "worker" &&
      rawProvider !== "default" &&
      rawProvider !== "auto" &&
      rawProvider !== "factory-peer" &&
      rawProvider.includes("/")
    ) {
      const slashIdx = rawProvider.indexOf("/");
      const reqProv = rawProvider.slice(0, slashIdx);
      const reqModel = rawProvider.slice(slashIdx + 1).split(":")[0];
      const defSlashIdx = defaultWorkerLane.indexOf("/");
      const defProv = defSlashIdx !== -1 ? defaultWorkerLane.slice(0, defSlashIdx) : "";
      const defModel = defSlashIdx !== -1 ? defaultWorkerLane.slice(defSlashIdx + 1).split(":")[0] : "";
      if ((reqProv === defProv || reqProv === "factory-peer") && (reqModel === defModel || defModel.endsWith(`/${reqModel}`))) {
        provider = defaultWorkerLane;
      } else {
        provider = rawProvider;
      }
    }

    // If a live Paseo daemon socket exists alongside factory.mjs, launch the
    // detached background Driver after verifying/allocating worktree or wait
    // for spawn_dispatched. When no daemon socket is present (or when running
    // in spool-only mode), allocate the Task worktree and submit the spawn
    // request directly through the Spool.
    const daemonSockExists = existsSync(join(ctx.home, "endpoint.sock"));
    let factoryBinCandidate = join(dirname(new URL(import.meta.url).pathname), "factory.mjs");
    if (!existsSync(factoryBinCandidate)) {
      try {
        const cfgPath = join(ctx.home, "config.json");
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
          const pluginPath = cfg?.plugins?.["paseo-factory"]?.path;
          if (typeof pluginPath === "string" && existsSync(join(pluginPath, "bin", "factory.mjs"))) {
            factoryBinCandidate = join(pluginPath, "bin", "factory.mjs");
          }
        }
      } catch {
        // ignore unreadable config.json
      }
    }
    if (daemonSockExists && existsSync(factoryBinCandidate)) {
      const eventsBefore = readLedgerEventsList(ctx.stateDir).length;
      const child = spawn(
        process.execPath,
        [
          factoryBinCandidate,
          "--home",
          ctx.home,
          "run",
          ...tasks,
          ...(provider ? ["--provider", provider] : []),
        ],
        {
          cwd: ctx.projectRoot ?? ctx.workspace,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            PASEO_HOME: ctx.home,
            PASEO_FACTORY_SEAT: "lead",
            ...(ctx.correlationId ? { PASEO_FACTORY_CORRELATION: ctx.correlationId } : {}),
          },
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();

      // Wait briefly (up to 4s) for spawn_dispatched / spawn_refused to record
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const eventsNow = readLedgerEventsList(ctx.stateDir).slice(eventsBefore);
        const spawnEvents = eventsNow.filter(
          (e) => (e.event === "spawn_dispatched" || e.event === "spawn_refused") && tasks.includes(e.task),
        );
        if (spawnEvents.length >= tasks.length) {
          const refused = spawnEvents.find((e) => e.event === "spawn_refused");
          if (refused) {
            return toolResult(`spawn refused for ${refused.task}: ${refused.rule} — ${refused.reason}`, true);
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 75));
      }
      return toolResult(
        `Driver launched in background for task(s): ${tasks.join(", ")} under ${provider}. End your turn now and wait for the completion report in your mailbox.`,
      );
    }

    // Direct Spool + Task worktree path
    const events = readLedgerEventsList(ctx.stateDir);
    const summaries = [];
    for (const task of tasks) {
      let contract;
      for (const evt of events) {
        if (evt.event === "contract_set" && evt.task === task) contract = evt;
      }
      let worktree;
      if (contract) {
        const prep = allocateTaskWorktree(ctx.stateDir, contract, task, events);
        if (!prep.ok) {
          return toolResult(`Failed to prepare Task worktree for ${task}: ${prep.reason}`, true);
        }
        worktree = prep.worktree;
      }
      const promptParts = [];
      if (Array.isArray(contract?.skills) && contract.skills.length > 0) {
        promptParts.push(
          `Required skills to open first: ${contract.skills.join(", ")} (read ~/.agents/skills/<skill>/SKILL.md or .agents/skills/<skill>/SKILL.md before starting)`,
        );
      }
      if (typeof contract?.description === "string" && contract.description.trim() !== "") {
        promptParts.push(`Task (${task}): ${contract.description.trim()}`);
      }
      if (Array.isArray(contract?.scope) && contract.scope.length > 0) {
        promptParts.push(`Allowed scope: ${contract.scope.join(", ")}`);
      }
      promptParts.push(
        `Execute task ${task}: produce artifact ${contract?.artifact ?? "(see contract)"} and pass gate \`${contract?.gate ?? ""}\`, commit on branch factory/${task}, and call agent_claim.`,
      );
      const taskPrompt =
        typeof args.prompt === "string" && args.prompt.trim() !== ""
          ? args.prompt.trim()
          : promptParts.join("\n\n");
      const reply = await roundTripSpool(ctx, {
        id: randomId(),
        kind: "spawn",
        task,
        provider,
        arity: tasks.length,
        ...(worktree ? { worktree } : {}),
        prompt: taskPrompt,
        seat: "lead",
      });
      if (!reply.ok) {
        return toolResult(`${reply.code}: ${reply.message}`, true);
      }
      summaries.push(
        `${reply.summary}${worktree ? ` (worktree: ${worktree})` : ""}`,
      );
    }
    return toolResult(
      `${summaries.join("\n")}\nWorking Agent spawn dispatched. End your turn now and wait for the Verdict notification.`,
    );
  }

  if (name === "lead_accept_task") {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const attempt = Number(args.attempt);
    if (task === "" || !Number.isInteger(attempt) || attempt < 1) {
      return toolResult("lead_accept_task requires `task` (string) and `attempt` (positive integer).", true);
    }
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "accept",
      task,
      attempt,
      by: "lead",
      seat: "lead",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(reply.summary);
  }

  if (name === "lead_repoke_agent") {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (task === "") return toolResult("lead_repoke_agent requires `task`.", true);
    let targetAgent = typeof args.agent === "string" && args.agent.trim() !== "" ? args.agent.trim() : undefined;
    if (!targetAgent) {
      const records = readCorrelationsFile(ctx.stateDir);
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].role === "agent" && records[i].task === task && records[i].agentId) {
          targetAgent = records[i].agentId;
          break;
        }
      }
    }
    if (!targetAgent) {
      const events = readLedgerEventsList(ctx.stateDir);
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const evt = events[i];
        if (evt.task === task && typeof evt.agent === "string" && evt.agent.trim() !== "") {
          targetAgent = evt.agent.trim();
          break;
        }
      }
    }
    if (!targetAgent) targetAgent = `agent-${task}`;
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "repoke",
      task,
      agent: targetAgent,
      seat: "lead",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(reply.summary);
  }

  if (name === "lead_needs_human") {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const seqs = Array.isArray(args.evidenceSeqs) ? args.evidenceSeqs.map(Number) : [];
    if (task === "" || reason === "") {
      return toolResult(
        "lead_needs_human requires `task`, `reason`, and `summary`.",
        true,
      );
    }
    const events = readLedgerEventsList(ctx.stateDir).filter((e) => e.task === task);
    const lastContract = events.findLast((e) => e.event === "contract_set");
    const epochEvents = lastContract ? events.filter((e) => e.seq >= lastContract.seq) : events;
    const hasValidSeqs = seqs.length >= 2 && Number.isInteger(seqs[0]) && seqs[0] > 0 && Number.isInteger(seqs[1]) && seqs[1] > 0;
    let evidence;
    if (reason === "denied-again" || reason === "silent-after-repoke") {
      const denial = epochEvents.findLast((e) => e.event === "permit_denied");
      const repoke = epochEvents.findLast((e) => e.event === "repoke_dispatched");
      evidence =
        denial && repoke
          ? { denial: denial.seq, repoke: repoke.seq }
          : hasValidSeqs
            ? { denial: seqs[0], repoke: seqs[1] }
            : { denial: 1, repoke: 2 };
    } else if (reason === "attempt-ceiling") {
      const gate3 = epochEvents.findLast((e) => e.event === "gate_finished" && e.attempt === 3 && e.verdict === "red");
      evidence =
        gate3
          ? { attempt: 3, gate: gate3.seq }
          : hasValidSeqs
            ? { attempt: seqs[0], gate: seqs[1] }
            : { attempt: 3, gate: 1 };
    } else if (reason === "died-after-respawn") {
      const spawnEvt = epochEvents.findLast((e) => e.event === "spawn_dispatched");
      const respawnEvt = epochEvents.findLast((e) => e.event === "respawn_dispatched");
      evidence =
        spawnEvt && respawnEvt
          ? { spawn: spawnEvt.seq, respawn: respawnEvt.seq }
          : hasValidSeqs
            ? { spawn: seqs[0], respawn: seqs[1] }
            : { spawn: 1, respawn: 2 };
    } else {
      return toolResult(`Invalid needs_human reason "${reason}".`, true);
    }
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "needs_human",
      task,
      reason,
      evidence,
      seat: "lead",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(`${reply.summary}${args.summary ? ` — ${args.summary}` : ""}`);
  }

  if (name === "lead_report_to_supervisor") {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (message === "") return toolResult("lead_report_to_supervisor requires a non-empty `message`.", true);
    const workspace =
      typeof args.workspace === "string" && args.workspace.trim() !== ""
        ? resolve(args.workspace.trim())
        : ctx.projectRoot ?? ctx.workspace;
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "supervisor_report",
      ...(workspace ? { workspace } : ctx.projectSlug ? { project: ctx.projectSlug } : {}),
      message,
      seat: "lead",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(`${reply.summary}\nReport queued for Supervisor. End your turn immediately.`);
  }

  if (name === "agent_claim") {
    const task = (typeof args.task === "string" && args.task.trim() !== "" ? args.task.trim() : ctx.task) ?? "";
    if (task === "") {
      return toolResult("agent_claim requires `task` (or a task-bound correlation token).", true);
    }
    const rawCommit = typeof args.commit === "string" && args.commit.trim() !== "" ? args.commit.trim() : typeof args.sha === "string" && args.sha.trim() !== "" ? args.sha.trim() : "";
    let sha = rawCommit;
    if (sha === "") {
      let worktreeCwd = process.cwd();
      if (ctx.projectSlug) {
        const candidate = join(ctx.stateDir, "projects", ctx.projectSlug, "worktrees", task);
        if (existsSync(candidate)) worktreeCwd = candidate;
      }
      const headOut = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreeCwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
      });
      if (headOut.status !== 0) {
        return toolResult(`Could not resolve HEAD in ${worktreeCwd}: ${(headOut.stderr || "").trim()}`, true);
      }
      sha = headOut.stdout.trim();
    }
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "claim",
      task,
      sha,
      ...(ctx.agentId ? { agent: ctx.agentId } : ctx.correlationId ? { agent: ctx.correlationId } : {}),
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    const lines = [
      `Claim outcome: ${reply.summary}`,
      `Verdict: ${String(reply.verdict ?? "").toUpperCase()}`,
      ...(reply.attempt !== undefined ? [`Attempt: ${reply.attempt}`] : []),
      ...(reply.reportPath ? [`Report: ${reply.reportPath}`] : []),
      ...(reply.note ? [`Note: ${reply.note}`] : []),
    ];
    return toolResult(lines.join("\n"), reply.verdict === "red");
  }

  if (name === "agent_escalate_blocker") {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (message === "") return toolResult("agent_escalate_blocker requires a non-empty `message`.", true);
    const workspace = ctx.projectRoot ?? ctx.workspace;
    const prefix = ctx.task ? `[Blocker on task ${ctx.task}] ` : "[Agent Blocker] ";
    const reply = await roundTripSpool(ctx, {
      id: randomId(),
      kind: "lead_dispatch",
      ...(workspace ? { workspace } : ctx.projectSlug ? { project: ctx.projectSlug } : {}),
      from: "peer",
      message: `${prefix}${message}`,
      seat: "agent",
    });
    if (!reply.ok) return toolResult(`${reply.code}: ${reply.message}`, true);
    return toolResult(`Blocker escalated to Lead (${reply.mailId ?? "queued"}). End your turn and wait for Lead guidance.`);
  }

  return toolResult(`Unknown tool "${name}".`, true);
}

// ---- Stdio JSON-RPC 2.0 Framing (Newline-delimited & Content-Length) ----

let responseFraming = "newline";
let stdinBuffer = Buffer.alloc(0);
let pendingOps = 0;
let stdinEnded = false;

function writeJsonRpcMessage(msg) {
  const json = JSON.stringify(msg);
  if (responseFraming === "content-length") {
    const bytes = Buffer.from(json, "utf8");
    process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);
    process.stdout.write(bytes);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function handleRpcMessage(msg) {
  if (typeof msg !== "object" || msg === null) return;
  const { id, method, params } = msg;

  // Notifications have no id
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === "initialize") {
      const clientProtocol =
        typeof params?.protocolVersion === "string" && params.protocolVersion.trim() !== ""
          ? params.protocolVersion
          : "2024-11-05";
      writeJsonRpcMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientProtocol,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "paseo_factory",
            version: "0.0.32",
          },
        },
      });
      return;
    }

    if (method === "ping") {
      writeJsonRpcMessage({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      const ctx = resolveBridgeContext();
      const names = getAllowedToolNames(ctx.role);
      const tools = names.map((n) => TOOL_DEFINITIONS[n]).filter(Boolean);
      writeJsonRpcMessage({
        jsonrpc: "2.0",
        id,
        result: { tools },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = typeof params?.name === "string" ? params.name : "";
      const toolArgs = params?.arguments ?? {};
      const result = await handleToolCall(toolName, toolArgs);
      writeJsonRpcMessage({
        jsonrpc: "2.0",
        id,
        result,
      });
      return;
    }

    writeJsonRpcMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${String(method)}`,
      },
    });
  } catch (err) {
    writeJsonRpcMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

function drainStdinBuffer() {
  while (stdinBuffer.length > 0) {
    const preview = stdinBuffer.subarray(0, Math.min(stdinBuffer.length, 64)).toString("utf8");
    const trimmedPreview = preview.replace(/^[\r\n]+/, "");
    if (trimmedPreview.length < preview.length) {
      const trimBytes = Buffer.byteLength(preview.slice(0, preview.length - trimmedPreview.length), "utf8");
      stdinBuffer = stdinBuffer.subarray(trimBytes);
      if (stdinBuffer.length === 0) break;
    }
    const headStr = stdinBuffer.subarray(0, Math.min(stdinBuffer.length, 32)).toString("utf8");
    if (/^Content-Length:/i.test(headStr)) {
      responseFraming = "content-length";
      const sepIndex = stdinBuffer.indexOf("\r\n\r\n");
      const lfSepIndex = stdinBuffer.indexOf("\n\n");
      let headerEnd = -1;
      let sepLen = 4;
      if (sepIndex !== -1 && (lfSepIndex === -1 || sepIndex < lfSepIndex)) {
        headerEnd = sepIndex;
        sepLen = 4;
      } else if (lfSepIndex !== -1) {
        headerEnd = lfSepIndex;
        sepLen = 2;
      }
      if (headerEnd === -1) return;
      const headerText = stdinBuffer.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!m) {
        stdinBuffer = stdinBuffer.subarray(headerEnd + sepLen);
        continue;
      }
      const contentLen = Number(m[1]);
      const totalLen = headerEnd + sepLen + contentLen;
      if (stdinBuffer.length < totalLen) return;
      const bodyStr = stdinBuffer.subarray(headerEnd + sepLen, totalLen).toString("utf8");
      stdinBuffer = stdinBuffer.subarray(totalLen);
      let parsed;
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        continue;
      }
      dispatchMessage(parsed);
    } else {
      const nlIndex = stdinBuffer.indexOf("\n");
      if (nlIndex === -1) return;
      const line = stdinBuffer.subarray(0, nlIndex).toString("utf8").trim();
      stdinBuffer = stdinBuffer.subarray(nlIndex + 1);
      if (line === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      dispatchMessage(parsed);
    }
  }
}

let rpcQueue = Promise.resolve();

function dispatchMessage(parsed) {
  pendingOps += 1;
  rpcQueue = rpcQueue
    .then(() => handleRpcMessage(parsed))
    .catch(() => {})
    .finally(() => {
      pendingOps -= 1;
      if (stdinEnded && pendingOps === 0) {
        process.exit(0);
      }
    });
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  drainStdinBuffer();
});

process.stdin.on("end", () => {
  stdinEnded = true;
  drainStdinBuffer();
  if (pendingOps === 0) {
    process.exit(0);
  }
});
