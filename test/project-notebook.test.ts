import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_NOTEBOOK_FILENAME,
  PROJECT_NOTEBOOK_MAX_BYTES,
  PROJECT_NOTEBOOK_MAX_LINES,
  projectNotebookPath,
  readProjectNotebook,
} from "../src/project.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The Per-Project Lead notebook helper seam (v0.1.0, ADR 0048 §3):
 * `projectNotebookPath` resolves `<stateDir>/projects/<slug>/notebook.md` and
 * `readProjectNotebook` bounds whatever a bloated file holds so it can never
 * overflow a Seat kickoff packet or Retro digest (spec Testing Decision 2).
 */

test("projectNotebookPath resolves exactly <stateDir>/projects/<slug>/notebook.md", () => {
  assert.equal(projectNotebookPath("/state/factory", "demo-abc123"), "/state/factory/projects/demo-abc123/notebook.md");
  assert.equal(PROJECT_NOTEBOOK_FILENAME, "notebook.md");
  assert.equal(PROJECT_NOTEBOOK_MAX_LINES, 80);
  assert.equal(PROJECT_NOTEBOOK_MAX_BYTES, 4096);
});

test("readProjectNotebook returns undefined when the notebook is absent, empty, or unreadable", (t) => {
  const stateDir = makeTempDir("notebook-absent-");
  disposeDir(t, stateDir);
  mkdirSync(join(stateDir, "projects", "demo-abc123"), { recursive: true });
  assert.equal(readProjectNotebook(stateDir, "demo-abc123"), undefined, "no notebook.md yet");

  writeFileSync(projectNotebookPath(stateDir, "demo-abc123"), "");
  assert.equal(readProjectNotebook(stateDir, "demo-abc123"), undefined, "an empty file reads as absent");

  writeFileSync(projectNotebookPath(stateDir, "demo-abc123"), " \n\t\n");
  assert.equal(readProjectNotebook(stateDir, "demo-abc123"), undefined, "a whitespace-only file reads as absent");
});

test("readProjectNotebook returns within-cap content unchanged", (t) => {
  const stateDir = makeTempDir("notebook-small-");
  disposeDir(t, stateDir);
  mkdirSync(join(stateDir, "projects", "demo-abc123"), { recursive: true });
  const content = "## 1. Verification & Run Recipe\nnpm run check\n\n## 2. Recurrence Guard\n| ID | Cause |\n";
  writeFileSync(projectNotebookPath(stateDir, "demo-abc123"), content);
  assert.equal(readProjectNotebook(stateDir, "demo-abc123"), content);
});

test("readProjectNotebook truncates deterministically at <= 80 lines when the file is longer", (t) => {
  const stateDir = makeTempDir("notebook-lines-");
  disposeDir(t, stateDir);
  mkdirSync(join(stateDir, "projects", "demo-abc123"), { recursive: true });
  const lines = Array.from({ length: 120 }, (_, i) => `line-${String(i + 1).padStart(3, "0")}`);
  writeFileSync(projectNotebookPath(stateDir, "demo-abc123"), `${lines.join("\n")}\n`);

  const read = readProjectNotebook(stateDir, "demo-abc123");
  assert.ok(read !== undefined, "an oversized notebook still reads");
  const kept = read!.split("\n");
  assert.ok(kept.length <= PROJECT_NOTEBOOK_MAX_LINES, `at most ${PROJECT_NOTEBOOK_MAX_LINES} lines, got ${kept.length}`);
  assert.ok(kept.includes("line-080"), "the first 80 lines survive");
  assert.ok(!read!.includes("line-081"), "line 81 and beyond are cut");
});

test("readProjectNotebook truncates at <= 4096 UTF-8 bytes without splitting a multi-byte character", (t) => {
  const stateDir = makeTempDir("notebook-bytes-");
  disposeDir(t, stateDir);
  mkdirSync(join(stateDir, "projects", "demo-abc123"), { recursive: true });
  // "đ" is 2 UTF-8 bytes: 100 lines x 25 chars = 2500 chars = 5000 bytes > 4096.
  const oversized = Array.from({ length: 100 }, () => "đ".repeat(25)).join("\n");
  writeFileSync(projectNotebookPath(stateDir, "demo-abc123"), oversized);

  const read = readProjectNotebook(stateDir, "demo-abc123");
  assert.ok(read !== undefined, "an oversized notebook still reads");
  assert.ok(Buffer.byteLength(read!, "utf8") <= PROJECT_NOTEBOOK_MAX_BYTES, `at most ${PROJECT_NOTEBOOK_MAX_BYTES} bytes, got ${Buffer.byteLength(read!, "utf8")}`);
  assert.ok(!read!.includes("\uFFFD"), "byte truncation never splits a multi-byte character");
  assert.ok(read!.endsWith("đ"), "the cut lands on a complete character boundary");
});

test("readProjectNotebook never throws on an unreadable notebook (a directory at the path)", (t) => {
  const stateDir = makeTempDir("notebook-unreadable-");
  disposeDir(t, stateDir);
  mkdirSync(projectNotebookPath(stateDir, "demo-abc123"), { recursive: true });
  assert.equal(readProjectNotebook(stateDir, "demo-abc123"), undefined);
});
