import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_NOTEBOOK_FILENAME,
  PROJECT_NOTEBOOK_MAX_BYTES,
  PROJECT_NOTEBOOK_MAX_LINES,
  projectNotebookPath,
  readProjectNotebook,
} from "../src/project.ts";
import { PROJECT_NOTEBOOK_MAX_GUARD_ROWS } from "../src/preflight.ts";
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
  // "đ" is 2 UTF-8 bytes: 100 lines x 25 chars = 2500 chars = 5000 raw bytes — but the
  // 80-line cap runs FIRST (80 lines = 4079 bytes <= 4096), so this fixture pins the
  // within-cap early return after the line cap, not the byte-cut branch itself.
  const oversized = Array.from({ length: 100 }, () => "đ".repeat(25)).join("\n");
  writeFileSync(projectNotebookPath(stateDir, "demo-abc123"), oversized);

  const read = readProjectNotebook(stateDir, "demo-abc123");
  assert.ok(read !== undefined, "an oversized notebook still reads");
  assert.ok(Buffer.byteLength(read!, "utf8") <= PROJECT_NOTEBOOK_MAX_BYTES, `at most ${PROJECT_NOTEBOOK_MAX_BYTES} bytes, got ${Buffer.byteLength(read!, "utf8")}`);
  assert.ok(!read!.includes("\uFFFD"), "byte truncation never splits a multi-byte character");
  assert.ok(read!.endsWith("đ"), "the cut lands on a complete character boundary");
});

test("readProjectNotebook cuts an <= 80-line notebook that still exceeds 4096 UTF-8 bytes on a character boundary", (t) => {
  const stateDir = makeTempDir("notebook-bytes-only-");
  disposeDir(t, stateDir);
  mkdirSync(join(stateDir, "projects", "demo-abc123"), { recursive: true });
  // 70 lines x 70 "đ" (2 bytes each) = 9869 UTF-8 bytes — within the 80-line cap, so
  // ONLY the byte-cut branch can bound it (deleting that branch would return all
  // 9869 bytes and fail the byte-cap assertion).
  const withinLines = Array.from({ length: 70 }, () => "đ".repeat(70)).join("\n");
  assert.ok(withinLines.split("\n").length <= PROJECT_NOTEBOOK_MAX_LINES, "fixture stays within the line cap");
  assert.ok(Buffer.byteLength(withinLines, "utf8") > PROJECT_NOTEBOOK_MAX_BYTES, "fixture exceeds the byte cap");
  writeFileSync(projectNotebookPath(stateDir, "demo-abc123"), withinLines);

  const read = readProjectNotebook(stateDir, "demo-abc123");
  assert.ok(read !== undefined, "an oversized notebook still reads");
  const readBytes = Buffer.byteLength(read!, "utf8");
  assert.ok(readBytes <= PROJECT_NOTEBOOK_MAX_BYTES, `at most ${PROJECT_NOTEBOOK_MAX_BYTES} bytes, got ${readBytes}`);
  assert.ok(readBytes > PROJECT_NOTEBOOK_MAX_BYTES - 8, "the cut sits at the cap, not far below it");
  assert.ok(withinLines.startsWith(read!), "the byte cut keeps a prefix of the notebook");
  assert.ok(!read!.includes("\uFFFD"), "byte truncation never splits a multi-byte character");
  assert.ok(read!.endsWith("đ"), "the cut lands on a complete character boundary");
});

test("readProjectNotebook never throws on an unreadable notebook (a directory at the path)", (t) => {
  const stateDir = makeTempDir("notebook-unreadable-");
  disposeDir(t, stateDir);
  mkdirSync(projectNotebookPath(stateDir, "demo-abc123"), { recursive: true });
  assert.equal(readProjectNotebook(stateDir, "demo-abc123"), undefined);
});

// ---- the legacy .scratch promotion (v0.5.0, ADR 0052 §1, ticket 06) ---------------------------

test("readProjectNotebook promotes a legacy <project-root>/.scratch/notebook.md when projectRoot is known (ADR 0052 Decision 1)", (t) => {
  const stateDir = makeTempDir("notebook-promote-");
  disposeDir(t, stateDir);
  const projectRoot = makeTempDir("notebook-promote-root-");
  disposeDir(t, projectRoot);
  const legacy = "## 1. Verification & Run Recipe\nnpm run check\n\n## 2. Recurrence Guard\n| ID | Cause |\n| --- | --- |\n| V-01 | c → e |\n";
  mkdirSync(join(projectRoot, ".scratch"), { recursive: true });
  writeFileSync(join(projectRoot, ".scratch", "notebook.md"), legacy);

  const read = readProjectNotebook(stateDir, "demo-abc123", projectRoot);
  assert.equal(read, legacy, "the promoted legacy content reads back");
  assert.equal(readFileSync(projectNotebookPath(stateDir, "demo-abc123"), "utf8"), legacy, "the canonical <projectStateDir>/notebook.md now exists");
  assert.equal(existsSync(join(projectRoot, ".scratch", "notebook.md")), false, "the untracked working-tree copy is unlinked");
});

test("readProjectNotebook without projectRoot never touches a legacy scratch copy (backward-compatible reads)", (t) => {
  const stateDir = makeTempDir("notebook-nopromote-");
  disposeDir(t, stateDir);
  const projectRoot = makeTempDir("notebook-nopromote-root-");
  disposeDir(t, projectRoot);
  mkdirSync(join(projectRoot, ".scratch"), { recursive: true });
  writeFileSync(join(projectRoot, ".scratch", "notebook.md"), "## 1. Verification & Run Recipe\nlegacy\n");

  assert.equal(readProjectNotebook(stateDir, "demo-abc123"), undefined, "the two-argument read stays read-only");
  assert.equal(existsSync(join(projectRoot, ".scratch", "notebook.md")), true, "no projectRoot means no promotion, no unlink");
  assert.equal(existsSync(projectNotebookPath(stateDir, "demo-abc123")), false);
});

test("PROJECT_NOTEBOOK_MAX_GUARD_ROWS pins the Recurrence Guard row cap (spec line 106)", () => {
  assert.equal(PROJECT_NOTEBOOK_MAX_GUARD_ROWS, 12);
});
