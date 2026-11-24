import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { capHandoffText, normalizeHandoffPaths } from "../plugin/server/handoff-text.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

test("normalizeHandoffPaths strips nested worktree and projectRoot prefixes longest-first and preserves external URLs and symbols", () => {
  const projectRoot = "/Users/dev/repos/app";
  const worktree = "/Users/dev/repos/app/.paseo/worktrees/T-04";
  const input = [
    `- [handler.ts](file://${worktree}/src/handler.ts:42)`,
    `- [${worktree}/src/other.ts](file://${worktree}/src/other.ts)`,
    `- [file://${projectRoot}/docs/spec.md](file://${projectRoot}/docs/spec.md)`,
    `- bare file url: file://${worktree}/test/handler.test.ts#L10`,
    `- bare worktree path: \`${worktree}/src/util.ts:12\``,
    `- bare root path: ${projectRoot}/package.json`,
    `- external link: [RFC](https://example.com${projectRoot}/src/ignored.ts)`,
    `- unrelated file url: file:///other/workspace/src/stay.ts`,
    `- relative path: src/already-relative.ts:7`,
    "- symbols: `lead_merge`, `agent_claim`, `supervisor_dispatch_lead`, `lead_update_notebook`",
  ].join("\n");

  const normalized = normalizeHandoffPaths(input, [projectRoot, `${worktree}/`, ""]);

  assert.ok(normalized.includes("- [handler.ts](src/handler.ts:42)"));
  assert.ok(normalized.includes("- [src/other.ts](src/other.ts)"));
  assert.ok(normalized.includes("- [docs/spec.md](docs/spec.md)"));
  assert.ok(normalized.includes("- bare file url: test/handler.test.ts#L10"));
  assert.ok(normalized.includes("- bare worktree path: `src/util.ts:12`"));
  assert.ok(normalized.includes("- bare root path: package.json"));
  assert.ok(normalized.includes(`- external link: [RFC](https://example.com${projectRoot}/src/ignored.ts)`));
  assert.ok(normalized.includes("- unrelated file url: file:///other/workspace/src/stay.ts"));
  assert.ok(normalized.includes("- relative path: src/already-relative.ts:7"));
  assert.ok(normalized.includes("`lead_merge`, `agent_claim`, `supervisor_dispatch_lead`, `lead_update_notebook`"));
  assert.equal(normalized.includes(worktree), false);
  assert.equal(normalized.includes(`file://${projectRoot}`), false);
  assert.equal(normalizeHandoffPaths(normalized, [projectRoot, worktree]), normalized, "idempotent");
});

test("normalizeHandoffPaths handles backslash separators, trailing slashes, and realpath aliases", (t) => {
  const dir = makeTempDir("handoff-norm-");
  disposeDir(t, dir);
  const wt = join(dir, "wt");
  mkdirSync(wt, { recursive: true });

  const winRoot = "C:\\Users\\dev\\repo\\";
  const winInput = [
    `[C:\\Users\\dev\\repo\\src\\main.ts](file:///C:/Users/dev/repo/src/main.ts)`,
    `file://C:\\Users\\dev\\repo\\lib\\helper.ts`,
    `C:\\Users\\dev\\repo\\test\\unit.test.ts`,
  ].join("\n");
  const winOut = normalizeHandoffPaths(winInput, [winRoot]);
  assert.equal(
    winOut,
    [
      "[src/main.ts](src/main.ts)",
      "lib/helper.ts",
      "test/unit.test.ts",
    ].join("\n"),
  );

  const realInput = `Inspect ${wt}/src/a.ts and file://${wt}/src/b.ts`;
  assert.equal(normalizeHandoffPaths(realInput, [wt]), "Inspect src/a.ts and src/b.ts");
  assert.equal(normalizeHandoffPaths("untouched text", ["/", ""]), "untouched text");
});

test("capHandoffText returns within-cap text unchanged and trims multi-section Markdown bottom-up with reserved floors", () => {
  const small = "# 1. Remaining\nSmall body\n\n# 2. Read-First Files\nsrc/a.ts:1";
  assert.equal(capHandoffText(small, 4096), small);

  // Oversized Section 4 should be trimmed before Sections 1-3, while preserving its reserved floor.
  const sec1 = "# 1. Remaining Requirements & Failing Checks\n" + Array.from({ length: 10 }, (_, i) => `- Check ${i}: failing on edge case`).join("\n");
  const sec2 = "# 2. Dead Ends & Do-Not-Retry\n- Tried patching X directly; failed typecheck.";
  const sec3 = "# 3. Read-First Files for Successor\n- src/core.ts:42\n- test/core.test.ts:12";
  const sec4 = "# 4. Completed & Verified Slice\n" + Array.from({ length: 200 }, (_, i) => `- Completed item ${i}: verified unit behavior cleanly`).join("\n");
  const doc = [sec1, sec2, sec3, sec4].join("\n\n");

  const capped = capHandoffText(doc, 2048);
  assert.ok(Buffer.byteLength(capped, "utf8") <= 2048);
  assert.ok(capped.includes(sec1), "Section 1 is preserved completely");
  assert.ok(capped.includes(sec2), "Section 2 is preserved completely");
  assert.ok(capped.includes(sec3), "Section 3 is preserved completely");
  assert.ok(capped.includes("# 4. Completed & Verified Slice"), "Section 4 heading survives");
  assert.match(capped, /\.\.\.\[truncated\]/);

  // Oversized Section 1 must still leave reserved floors on trailing Sections 2-4.
  const hugeSec1 = "# 1. Remaining Requirements & Failing Checks\n" + Array.from({ length: 180 }, (_, i) => `- Pending item ${i}: detailed failure trace`).join("\n");
  const smallSec2 = "# 2. Dead Ends & Do-Not-Retry\n- Do not retry approach A: ENOENT.";
  const smallSec3 = "# 3. Read-First Files for Successor\n- src/app.ts:10";
  const medSec4 = "# 4. Completed & Verified Slice\n" + Array.from({ length: 40 }, (_, i) => `- Verified slice ${i}: ok`).join("\n");
  const bigTopDoc = [hugeSec1, smallSec2, smallSec3, medSec4].join("\n\n");

  const cappedTop = capHandoffText(bigTopDoc, 2048);
  assert.ok(Buffer.byteLength(cappedTop, "utf8") <= 2048);
  assert.ok(cappedTop.includes("# 1. Remaining Requirements & Failing Checks"));
  assert.ok(cappedTop.includes(smallSec2), "Section 2 <= floor is never wiped");
  assert.ok(cappedTop.includes(smallSec3), "Section 3 <= floor is never wiped");
  assert.ok(cappedTop.includes("# 4. Completed & Verified Slice"), "Section 4 keeps its reserved floor");
});

test("capHandoffText handles preamble, plain-prose fallback, tiny maxBytes, and multi-byte UTF-8 safely", () => {
  const withPreamble = [
    "Intro note line 1\nIntro note line 2",
    "## Ledger digest\n" + Array.from({ length: 20 }, (_, i) => `seq ${i} event`).join("\n"),
    "## Recent timeline\n" + Array.from({ length: 80 }, (_, i) => `Assistant: turn ${i} output`).join("\n"),
  ].join("\n\n");
  const cappedPreamble = capHandoffText(withPreamble, 1024);
  assert.ok(Buffer.byteLength(cappedPreamble, "utf8") <= 1024);
  assert.ok(cappedPreamble.includes("Intro note line 1"));
  assert.ok(cappedPreamble.includes("## Ledger digest"));
  assert.ok(cappedPreamble.includes("## Recent timeline"));

  const plainProse = Array.from({ length: 60 }, (_, i) => `Plain line ${i} 🧪 đ →`).join("\n");
  const cappedPlain = capHandoffText(plainProse, 300);
  assert.ok(Buffer.byteLength(cappedPlain, "utf8") <= 300);
  assert.equal(cappedPlain.includes("\uFFFD"), false);
  assert.match(cappedPlain, /\n\.\.\.\[truncated\]$/);

  const oneSectionUnicode = "# Peer reply\n" + "Verified 🧪 đ\n".repeat(400);
  const cappedOne = capHandoffText(oneSectionUnicode, 1024);
  assert.ok(Buffer.byteLength(cappedOne, "utf8") <= 1024);
  assert.equal(cappedOne.includes("\uFFFD"), false);
  assert.match(cappedOne, /^# Peer reply/);
  assert.match(cappedOne, /\n\.\.\.\[truncated\]$/);

  // Tiny maxBytes <= 128 and extreme multi-section floor overflow
  const manyHeadings = Array.from({ length: 30 }, (_, i) => `## Section ${i}\nBody ${i} 🧪`).join("\n\n");
  for (const limit of [0, 5, 15, 64, 128, 200]) {
    const out = capHandoffText(manyHeadings, limit);
    assert.ok(Buffer.byteLength(out, "utf8") <= limit, `strict byte limit ${limit}`);
    assert.equal(out.includes("\uFFFD"), false, `no replacement char at limit ${limit}`);
  }
});
