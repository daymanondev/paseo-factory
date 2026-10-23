// Generated from src/ledger-read.ts and canonical Ledger validation. Do not edit.

// src/ledger-read.ts
import { readFileSync } from "node:fs";

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

// src/ledger-read.ts
function readLedgerEvents(path, options = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { failed: error };
  }
  return parseLedgerJsonl(raw, options);
}
export {
  readLedgerEvents
};
