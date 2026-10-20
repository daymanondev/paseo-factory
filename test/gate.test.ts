import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGate } from "../src/gate.ts";
import { REPORT_NOTE_MAX_CHARS } from "../src/constants.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

test("exit 0 with the artifact present is green", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  writeFileSync(join(dir, "out.txt"), "artifact\n");

  const result = await runGate({ cmd: "true", cwd: dir, artifact: "out.txt" });

  assert.equal(result.exit, 0);
  assert.equal(result.verdict, "green");
  assert.equal(result.timedOut, false);
});

test("non-zero exit is red and the note squashes the stdout tail into one line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  writeFileSync(join(dir, "out.txt"), "artifact\n");

  const result = await runGate({ cmd: "echo one; echo two; exit 3", cwd: dir, artifact: "out.txt" });

  assert.equal(result.exit, 3);
  assert.equal(result.verdict, "red");
  assert.equal(result.note, "one two");
});

test("exit 0 with a missing artifact is red — the artifact is part of the contract", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "true", cwd: dir, artifact: "nope.txt" });

  assert.equal(result.exit, 0);
  assert.equal(result.verdict, "red");
  assert.match(result.note, /artifact .*nope\.txt.* not found/);
});

test("note falls back to stderr when stdout is empty", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "echo err-marker 1>&2; exit 1", cwd: dir });

  assert.equal(result.verdict, "red");
  assert.match(result.note, /err-marker/);
});

test("output is capped: only the tail is kept, note stays under the cap", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "for i in $(seq 1 20000); do echo \"line-$i\"; done; exit 1", cwd: dir });

  assert.equal(result.verdict, "red");
  assert.ok(result.note.length <= REPORT_NOTE_MAX_CHARS, `note was ${result.note.length} chars`);
  assert.match(result.note, /line-20000/, "the tail keeps the end of the output");
  assert.doesNotMatch(result.note, /line-1\b.*line-10000/, "old output must be dropped");
});

test("a truncated note cuts at a word boundary with a leading ellipsis — never mid-word (ticket 02c)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const filler = "x".repeat(300); // one giant word the cut would otherwise split

  const result = await runGate({ cmd: `printf '%s tail-word-here' '${filler}'; exit 1`, cwd: dir });

  assert.equal(result.verdict, "red");
  assert.ok(result.note.length <= REPORT_NOTE_MAX_CHARS);
  assert.ok(result.note.startsWith("…"), "the cut is marked");
  assert.match(result.note, /tail-word-here/);
  assert.ok(!result.note.slice(1).startsWith("x"), "no partial word survives the cut");
});

test("the captured output is raw, not the collapsed note — it keeps whitespace (ticket 02a)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "printf 'a\\n\\nb\\n'; exit 1", cwd: dir });

  assert.equal(result.output, "a\n\nb\n", "the persisted log's bytes, as they arrived");
  assert.equal(result.note, "a b", "the note keeps its one-line summary role");
});

test("timeout kills the gate and records red with exit null", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "echo before-timeout; sleep 30", cwd: dir, timeoutMs: 250 });

  assert.equal(result.timedOut, true);
  assert.equal(result.exit, null);
  assert.equal(result.verdict, "red");
  assert.match(result.note, /timeout/i);
  assert.equal(result.output, "before-timeout\n", "output captured up to the kill still survives in full");
});

test("spawn failure in a bad cwd rejects instead of inventing a verdict", async () => {
  await assert.rejects(() => runGate({ cmd: "true", cwd: "/nonexistent-cwd-xyz" }));
});

test("runGate reaps background subprocesses holding stdout open and finishes in <2s (v0.0.26, ADR 0016)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  writeFileSync(join(dir, "out.txt"), "artifact\n");

  const start = Date.now();
  const result = await runGate({
    cmd: "sleep 60 & echo gate-done; exit 0",
    cwd: dir,
    artifact: "out.txt",
    timeoutMs: 10_000,
  });
  const elapsed = Date.now() - start;

  assert.equal(result.verdict, "green");
  assert.equal(result.exit, 0);
  assert.match(result.output ?? "", /gate-done/);
  assert.ok(elapsed < 2_000, `runGate must reap background children and finish in <2s (took ${elapsed}ms)`);
});
