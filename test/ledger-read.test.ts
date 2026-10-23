import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLedgerEvents } from "../plugin/bin/ledger-read.mjs";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

/** The standalone reader applies canonical integrity rules, with optional extra caller restrictions. */

const ts = "2026-10-09T09:00:00.000Z";

function event(seq: number, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ seq, ts, event: name, ...extra });
}

/** A stand-in for factory status's vocabulary rule: known event, task+attempt unless contract_set. */
const knownEvents = new Set(["contract_set", "claim_reported", "gate_finished"]);
function inVocabulary(evt: Record<string, unknown>): boolean {
  if (typeof evt.event !== "string" || !knownEvents.has(evt.event)) return false;
  if (evt.event === "contract_set") return true;
  return typeof evt.task === "string" && typeof evt.attempt === "number" && evt.attempt >= 1;
}

function writeLedger(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, body);
  return path;
}

test("a missing ledger is a verdict, not an error — under either policy", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const absent = join(dir, "ledger.jsonl");
  assert.deepEqual(readLedgerEvents(absent), { missing: true }, "the driver's read");
  assert.deepEqual(readLedgerEvents(absent, { validateEvent: inVocabulary }), { missing: true }, "status's read");
});

test("an unterminated last line never happened — under either policy (ADR 0003)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = writeLedger(dir, `${event(1, "contract_set", { task: "T1" })}\n{"seq":2,"ts":"${ts},ev`);
  const lenient = readLedgerEvents(path);
  assert.deepEqual(lenient.events, [JSON.parse(event(1, "contract_set", { task: "T1" }))]);
  const strict = readLedgerEvents(path, { validateEvent: inVocabulary });
  assert.deepEqual(strict.events, [JSON.parse(event(1, "contract_set", { task: "T1" }))]);
});

test("the strict read refuses a blank line, naming it; anything unparseable or off-vocabulary is corruption at its line", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const good = event(1, "contract_set", { task: "T1" });

  const cases: [string, string, string][] = [
    ["a leading blank line", "\n", "blank line at line 1"],
    ["an interior blank line", `${good}\n\n${good}\n`, "blank line at line 2"],
    // A line of spaces is not a blank line (only "" is) — it fails JSON.parse.
    ["a whitespace-only line", `${good}\n   \n`, "line 2 is not valid JSON"],
    ["junk", `${good}\nnot json\n`, "line 2 is not valid JSON"],
    ["a line that is not an event object", "[1, 2, 3]\n", "line 1 is not a valid ledger event"],
    ["an unknown event name", `${event(1, "teleported", { task: "T1" })}\n`, "line 1 is not a valid ledger event"],
    ["a claim with no attempt number", `${event(1, "claim_reported", { task: "T1" })}\n`, "line 1 is not a valid ledger event"],
  ];
  for (const [name, body, expected] of cases) {
    const read = readLedgerEvents(writeLedger(dir, body), { validateEvent: inVocabulary });
    assert.deepEqual(read, { corrupt: expected }, name);
  }
});

test("the strict read stops at the first corruption and hands back only clean prefixes", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = writeLedger(dir, `${event(1, "contract_set", { task: "T1" })}\n${event(2, "claim_reported", { task: "T1", attempt: 1 })}\njunk\n${event(3, "contract_set", { task: "T2" })}\n`);
  const read = readLedgerEvents(path, { validateEvent: inVocabulary });
  assert.deepEqual(read, { corrupt: "line 3 is not valid JSON" });
});

test("the strict read hands back the complete lines, in order", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const first = JSON.parse(event(1, "contract_set", { task: "T1" }));
  const second = JSON.parse(event(2, "claim_reported", { task: "T1", attempt: 1 }));
  const path = writeLedger(dir, `${event(1, "contract_set", { task: "T1" })}\n${event(2, "claim_reported", { task: "T1", attempt: 1 })}\n`);
  assert.deepEqual(readLedgerEvents(path, { validateEvent: inVocabulary }).events, [first, second]);
});

test("the default read refuses complete damage with the same integrity rules as status", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  assert.deepEqual(readLedgerEvents(writeLedger(dir, "\n")), { corrupt: "blank line at line 1" });
  assert.deepEqual(readLedgerEvents(writeLedger(dir, "[1, 2, 3]\n")), { corrupt: "line 1 is not a valid ledger event" });
  const good = event(1, "contract_set", { task: "T1" });
  assert.deepEqual(readLedgerEvents(writeLedger(dir, `${good}\nnot json\n`)), { corrupt: "line 2 is not valid JSON" });
});

test("a read that fails at the filesystem is handed to the caller, not swallowed", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const notAFile = join(dir, "ledger.jsonl");
  mkdirSync(notAFile, { recursive: true }); // a directory where the ledger should be
  const lenient = readLedgerEvents(notAFile);
  assert.ok(lenient.failed !== undefined, "the lenient read reports the failure");
  assert.equal((lenient.failed as NodeJS.ErrnoException).code, "EISDIR");
  const strict = readLedgerEvents(notAFile, { validateEvent: inVocabulary });
  assert.ok(strict.failed !== undefined, "the strict read reports the failure");
  assert.equal((strict.failed as NodeJS.ErrnoException).code, "EISDIR");
});

test("both CLIs read the ledger through the shared reader", () => {
  for (const cli of ["factory.mjs", "driver.mjs"]) {
    const body = readFileSync(join(repoRoot, "plugin", "bin", cli), "utf8");
    assert.match(body, /import \{ readLedgerEvents \} from "\.\/ledger-read\.mjs";/, `${cli} imports the shared reader`);
    assert.doesNotMatch(body, /function readLedgerEvents\(/, `${cli} carries no private copy of the reader`);
  }
});
