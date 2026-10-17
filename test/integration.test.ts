import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkCleanAt, createFactory, prepareTaskWorktree } from "../src/index.ts";
import {
  discoverProjects,
  listProjectRegistrations,
  readProjectRegistration,
  writeProjectRegistration,
  type ProjectRegistration,
} from "../src/index.ts";
import { resolveProject } from "../src/project.ts";
import { copyFixture, disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

/** Parses a ledger line and drops the clock-dependent `ts` so asserts stay exact. */
function lineWithoutTs(line: string): Record<string, unknown> {
  const { ts, ...rest } = JSON.parse(line) as { ts?: unknown };
  assert.match(String(ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  return rest;
}

/**
 * The scripted integration scenario from ticket 07 / roadmap §2, in its ADR
 * shape: contract set → claim reported → gate runs red (`npm test`, 2 failing
 * tests) → report shows the red evidence. §2's literal event name
 * `done_reported` is superseded by ADR 0003 (`claim_reported`), §2's fake sha
 * by ADR 0002 (the claim must resolve to a real commit), and since ticket 08
 * every event carries `ts` and its Attempt number while the Contract fixes the
 * Workspace (ADR 0003 / ADR 0002).
 */
test("roadmap §2 scenario: red npm test produces the five-event ledger and a red-evidence report", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const sha = gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T1", workspace, gate: "npm test", artifact: "src/format.ts" });
  const outcome = await factory.claim({ task: "T1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 1);
  assert.equal(outcome.attempt, 1);

  const lines = readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 5, "exactly the five roadmap events");
  // The doc's literal first three lines — same events, fields, and order, with
  // the ADR 0002/0003 amendments applied.
  assert.deepEqual(lineWithoutTs(lines[0]!), {
    seq: 1,
    event: "contract_set",
    task: "T1",
    workspace,
    gate: "npm test",
    artifact: "src/format.ts",
    base: sha,
  });
  assert.deepEqual(lineWithoutTs(lines[1]!), { seq: 2, event: "claim_reported", task: "T1", attempt: 1, sha });
  assert.deepEqual(lineWithoutTs(lines[2]!), { seq: 3, event: "gate_started", task: "T1", attempt: 1, cmd: "npm test" });

  const gate = JSON.parse(lines[3]!) as { seq: number; event: string; task: string; attempt: number; exit: number; verdict: string; note: string; sha?: string };
  assert.deepEqual(
    { seq: gate.seq, event: gate.event, task: gate.task, attempt: gate.attempt, exit: gate.exit, verdict: gate.verdict, sha: gate.sha },
    { seq: 4, event: "gate_finished", task: "T1", attempt: 1, exit: 1, verdict: "red", sha },
  );
  assert.match(gate.note, /fail 2/, "the note carries the real test failure summary");

  const reportWritten = lineWithoutTs(lines[4]!) as { seq: number; event: string; task: string; attempt: number; path: string };
  assert.deepEqual(reportWritten, {
    seq: 5,
    event: "report_written",
    task: "T1",
    attempt: 1,
    path: join(stateDir, "report-T1-1.md"),
  });

  const report = readFileSync(join(stateDir, "report-T1-1.md"), "utf8");
  assert.match(report, /^# T1 — \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
  assert.ok(report.includes("- Contract: `npm test` green · file `src/format.ts` exists"));
  assert.ok(report.includes(`- Claimed @ `));
  assert.ok(report.includes(`- Attested commit: \`${sha}\``));
  assert.ok(report.includes("- Verdict: RED — "));
  assert.ok(!report.includes("Conclusion"), "no acceptance language — ADR 0002");
});

test("the full loop: red attempt → real fix → green attempt 2 → the Owner accepts it", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const brokenSha = gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "T2", workspace, gate: "npm test", artifact: "src/format.ts" });

  // Attempt 1: the agent claims unfinished work; the gate says red.
  const red = await factory.claim({ task: "T2", sha: brokenSha });
  assert.equal(red.verdict, "red");
  assert.equal(red.attempt, 1);

  // The agent fixes the work for real, commits it, then claims the new commit.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const fixedSha = gitCommitChanges(workspace, "fix pad to truncate and pad correctly");

  const green = await factory.claim({ task: "T2", sha: fixedSha });
  assert.equal(green.verdict, "green");
  assert.equal(green.attempt, 2, "the fix is a new Attempt, not an overwrite (ADR 0003)");
  const report1 = readFileSync(join(stateDir, "report-T2-1.md"), "utf8");
  const report2 = readFileSync(green.reportPath, "utf8");
  assert.ok(report1.includes("- Verdict: RED —"));
  assert.ok(report2.includes("- Attempt: 2 of 2"));
  assert.ok(report2.includes("- Verdict: GREEN —"));
  assert.ok(report2.includes("- Evidence, not acceptance"));

  // Acceptance is the Owner's act, on a specific green Attempt (ADR 0002).
  const accepted = await factory.accept({ task: "T2", attempt: 2 });
  assert.equal(accepted.event, "attempt_accepted");
  assert.deepEqual(factory.ledger.eventsFor("T2").map((e) => e.event), [
    "contract_set",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "report_written",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "report_written",
    "attempt_accepted",
  ]);
});

test("the Task worktree loop: driver-style allocation, claim inside the worktree, Lead accept lands into <project-root>", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const base = gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");
  const { prepareTaskWorktree } = await import("../plugin/bin/task-worktree.mjs");
  const project = resolveProject(workspace);
  assert.equal(project.ok, true, "the fixture workspace is a git Project");

  // The driver's own allocation helper — the same .mjs code `factory run` runs.
  const prepared = prepareTaskWorktree({ stateDir, workspace, task: "WTE2E", base });
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
  if (!prepared.ok) return;
  assert.equal(prepared.path, join(stateDir, "projects", project.ok ? project.slug : "", "worktrees", "WTE2E"));

  const factory = createFactory({ stateDir });
  factory.setContract({ task: "WTE2E", workspace, gate: "npm test", artifact: "src/format.ts" });
  const spawn = factory.requestSpawn({ task: "WTE2E", provider: "claude", arity: 1, worktree: prepared.path });
  assert.equal(spawn.outcome, "dispatched");

  // The agent works INSIDE the worktree; <project-root> never moves.
  writeFileSync(
    join(prepared.path, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const claimed = gitCommitChanges(prepared.path, "fix pad in the worktree");
  const outcome = await factory.claim({ task: "WTE2E", sha: claimed });
  assert.equal(outcome.verdict, "green", "the gate ran against the worktree checkout");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), base, "the root sat at base the whole run");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).trim(), "", "the root stayed clean");

  // The Lead accepts the green attempt; the landing fast-forwards the root.
  const accepted = await factory.accept({ task: "WTE2E", attempt: 1, accepted_by: "lead" });
  assert.equal(accepted.landing, "landed");
  assert.equal(accepted.accepted_by, "lead");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), claimed, "the root's branch fast-forwarded to the verified commit");
  assert.equal(existsSync(prepared.path), false, "the worktree is removed after the landing");
  assert.equal(
    execFileSync("git", ["rev-parse", "--verify", "factory/WTE2E"], { cwd: workspace, encoding: "utf8" }).trim(),
    claimed,
    "branch factory/Wtask> survives",
  );
  const spawnLine = factory.ledger.eventsFor("WTE2E").find((e) => e.event === "spawn_dispatched");
  assert.equal(spawnLine === undefined ? undefined : "worktree" in spawnLine ? spawnLine.worktree : undefined, prepared.path, "the spawn line carried the worktree");
  assert.match(readFileSync(join(stateDir, "report-WTE2E-1.md"), "utf8"), /- Verdict: GREEN/);
});

// ---- the Task worktree allocation served from the core barrel (v0.0.18, ADR 0010 / ADR 0012) ----

test("the core barrel's prepareTaskWorktree: symlinked node_modules and .worktreeinclude copies stay clean through checkCleanAt and a full factory.claim", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  // node_modules rides as a link, never a copy; .env* is gitignored untracked config.
  mkdirSync(join(workspace, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "node_modules/\n.env*\n");
  writeFileSync(join(workspace, ".worktreeinclude"), "# local env only\n.env*\n");
  const base = gitCommitAll(workspace);
  writeFileSync(join(workspace, ".env.local"), "TOKEN=abc\n");
  const stateDir = join(tmp, "factory");
  const project = resolveProject(workspace);
  assert.equal(project.ok, true, "the fixture workspace is a git Project");

  // The core allocation (v0.0.18): companion-facing options on the proven driver behavior.
  const prepared = prepareTaskWorktree({ stateDir, workspace, task: "COREWT1", base, symlinkNodeModules: true });
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
  if (!prepared.ok) return;
  assert.equal(prepared.path, join(stateDir, "projects", project.ok ? project.slug : "", "worktrees", "COREWT1"));
  assert.equal(prepared.branch, "factory/COREWT1");
  assert.equal(prepared.reset, false, "first allocation is a create, not a reset");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: prepared.path, encoding: "utf8" }).trim(), base, "checked out at the Contract's base commit");

  // node_modules is a directory symlink to the root's, not a copy.
  assert.ok(lstatSync(join(prepared.path, "node_modules")).isSymbolicLink(), "node_modules is a link, not a copy");
  assert.ok(existsSync(join(prepared.path, "node_modules", ".bin")), "the link resolves into the root's node_modules");
  // The .worktreeinclude-matched untracked file rides over.
  assert.equal(readFileSync(join(prepared.path, ".env.local"), "utf8"), "TOKEN=abc\n", "the ignored untracked file rides over");

  // Both the copies and the link are recorded in the worktree's own factory-excludes.
  const gitDir = resolve(execFileSync("git", ["rev-parse", "--git-dir"], { cwd: prepared.path, encoding: "utf8" }).trim());
  assert.equal(
    readFileSync(join(gitDir, "factory-excludes"), "utf8"),
    ".env.local\nnode_modules\n",
    "the per-worktree excludes record the copied file AND the node_modules link",
  );

  // The station the Claim reads: clean tree at the claimed commit — with a symlink that
  // `node_modules/` in .gitignore does NOT cover (git sees a file, not a directory).
  const clean = await checkCleanAt(prepared.path, base);
  assert.equal(clean.ok, true, clean.ok ? "" : clean.reason);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: prepared.path, encoding: "utf8" }).trim(), "", "porcelain is empty — the exclude carries the symlink");
  // <project-root> is untouched — its HEAD and its clean tree.
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), base);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).trim(), "");

  // The full loop against the core allocation: the agent fixes the work inside the worktree.
  const factory = createFactory({ stateDir });
  factory.setContract({ task: "COREWT1", workspace, gate: "npm test", artifact: "src/format.ts" });
  const spawn = factory.requestSpawn({ task: "COREWT1", provider: "claude", arity: 1, worktree: prepared.path });
  assert.equal(spawn.outcome, "dispatched");
  writeFileSync(
    join(prepared.path, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );
  const claimed = gitCommitChanges(prepared.path, "fix pad inside the core-allocated worktree");
  const outcome = await factory.claim({ task: "COREWT1", sha: claimed });
  assert.equal(outcome.verdict, "green", "the gate ran against the worktree checkout with node_modules linked");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), base, "the root sat at base the whole run");
});

test("the core barrel's prepareTaskWorktree lands companion overrides: custom worktreePath and branchName replace the defaults", (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  // A Best-of-N arena repo: deps installed at the root, NO .worktreeinclude —
  // the excludes file must still land for the node_modules link alone.
  mkdirSync(join(workspace, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "node_modules/\n");
  const base = gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");
  const arena = join(tmp, "arena", "attempt-1");

  const prepared = prepareTaskWorktree({
    stateDir,
    workspace,
    task: "BO1",
    base,
    worktreePath: arena,
    branchName: "burn-lab/BO1-a1",
    symlinkNodeModules: true,
  });
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
  if (!prepared.ok) return;
  assert.equal(prepared.path, arena, "the override replaces taskWorktreePath(stateDir, slug, task)");
  assert.equal(prepared.branch, "burn-lab/BO1-a1", "the override replaces factory/<task>");
  assert.equal(prepared.reset, false, "first allocation is a create, not a reset");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: arena, encoding: "utf8" }).trim(), "burn-lab/BO1-a1", "the worktree runs on the custom branch");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: arena, encoding: "utf8" }).trim(), base, "checked out at the Contract's base commit");
  assert.ok(execFileSync("git", ["worktree", "list"], { cwd: workspace, encoding: "utf8" }).includes(arena), "a linked worktree of the project checkout");
  assert.ok(lstatSync(join(arena, "node_modules")).isSymbolicLink(), "node_modules is a link, not a copy");
  const gitDir = resolve(execFileSync("git", ["rev-parse", "--git-dir"], { cwd: arena, encoding: "utf8" }).trim());
  assert.equal(readFileSync(join(gitDir, "factory-excludes"), "utf8"), "node_modules\n", "no include file matched, yet the link is excluded");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: arena, encoding: "utf8" }).trim(), "", "the arena sits clean");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).trim(), "", "the root stays clean");

  // A Best-of-N re-attempt: the previous attempt committed and moved on; a
  // re-run at the same override path resets to base — with `base` omitted, the
  // root's HEAD is the fallback base.
  writeFileSync(join(arena, "src", "format.ts"), "export const dirty = 1;\n");
  gitCommitChanges(arena, "attempt 1 went sideways");
  const again = prepareTaskWorktree({ stateDir, workspace, task: "BO1", worktreePath: arena, branchName: "burn-lab/BO1-a1" });
  assert.ok(again.ok, again.ok ? "" : again.reason);
  if (!again.ok) return;
  assert.equal(again.reset, true, "the second allocation at the custom path is a reset");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: arena, encoding: "utf8" }).trim(), base, "back at base — the omitted base fell back to the root's HEAD");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: arena, encoding: "utf8" }).trim(), "", "the reset arena sits clean");

  // Refusal parity with the driver's allocator, at the barrel seam.
  const plain = join(tmp, "plain");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "x.txt"), "not a repo\n");
  const refused = prepareTaskWorktree({ stateDir, workspace: plain, task: "BO2" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /does not resolve to a git Project/);
});

// ---- the shared Project registry served from the core barrel (v0.0.18, ADR 0010 / ADR 0012) ----

/** Makes a real temp git repo (one file, one commit) — the registry binds roots git can answer for. */
function makeRegistryRepo(dir: string, name: string): { root: string; slug: string } {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "README.md"), `# ${name}\n`);
  gitCommitAll(join(dir, name));
  const project = resolveProject(join(dir, name));
  assert.ok(project.ok, `${name} is a git Project`);
  // git's --show-toplevel answers with the physical path (macOS `/private/var` vs `/var`), so pin the root to it.
  return { root: project.root, slug: project.slug };
}

test("the core barrel serves the shared Project registry: write/read/list round-trip with field-wise seat merges", (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const acme = makeRegistryRepo(tmp, "acme-api");
  const beta = makeRegistryRepo(tmp, "beta-web");
  const stateDir = join(tmp, "factory");

  // Before any write there is no registry — undefined, never a guess.
  assert.equal(readProjectRegistration(stateDir, acme.slug), undefined);

  // Seat bindings land field-wise across separate writes.
  writeProjectRegistration(stateDir, acme.slug, { root: acme.root, supervisor: "agent-sup-1" });
  writeProjectRegistration(stateDir, acme.slug, { root: acme.root, lead: "agent-lead-1" });
  const merged: ProjectRegistration | undefined = readProjectRegistration(stateDir, acme.slug);
  assert.deepEqual(merged, { slug: acme.slug, root: acme.root, supervisor: "agent-sup-1", lead: "agent-lead-1" });

  // The on-disk shape is the format factory-burn-lab shares — pretty JSON plus the trailing newline.
  assert.equal(
    readFileSync(join(stateDir, "projects", acme.slug, "project.json"), "utf8"),
    `${JSON.stringify({ root: acme.root, supervisor: "agent-sup-1", lead: "agent-lead-1" }, null, 2)}\n`,
  );

  // `null` clears one seat; the untouched seat survives.
  writeProjectRegistration(stateDir, acme.slug, { root: acme.root, lead: null });
  assert.equal(readProjectRegistration(stateDir, acme.slug)?.lead, undefined);
  assert.equal(readProjectRegistration(stateDir, acme.slug)?.supervisor, "agent-sup-1");

  // `undefined` leaves the seats alone — a root-only rewrite preserves both ids.
  writeProjectRegistration(stateDir, acme.slug, { root: acme.root, supervisor: undefined, lead: undefined });
  assert.deepEqual(readProjectRegistration(stateDir, acme.slug), { slug: acme.slug, root: acme.root, supervisor: "agent-sup-1" });

  // The listing is every registration on disk, slug order.
  writeProjectRegistration(stateDir, beta.slug, { root: beta.root, supervisor: "agent-sup-2" });
  assert.deepEqual(listProjectRegistrations(stateDir).map((r) => r.slug), [acme.slug, beta.slug].sort((a, b) => a.localeCompare(b)));

  // An empty state dir lists nothing.
  assert.deepEqual(listProjectRegistrations(join(tmp, "empty-state")), []);
});

test("the core barrel's discoverProjects merges registry, live seat agents, and Paseo's projects.json — registry wins on conflicts", (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const acme = makeRegistryRepo(tmp, "acme-api");
  const paseoUi = makeRegistryRepo(tmp, "paseo-ui");
  const stateDir = join(tmp, "factory");

  writeProjectRegistration(stateDir, acme.slug, { root: acme.root, supervisor: "agent-sup-1" });

  // Live seat agents: a same-slug conflict (registry wins), a fresh slug the registry has never seated,
  // and an agent missing labels.seat (skipped — a seat label is required).
  const liveSeatAgents: { labels: Record<string, string>; cwd: string }[] = [
    { labels: { seat: "supervisor", project: acme.slug }, cwd: "/w/elsewhere" },
    { labels: { seat: "lead", project: "other-xyz789" }, cwd: "/w/other" },
    { labels: { project: "no-seat-label" }, cwd: "/w/noseat" },
  ];

  // Paseo's <home>/projects/projects.json: one non-archived real repo (resolved through git),
  // one archived entry (skipped), one pointing nowhere (resolveProject refuses).
  const home = makeTempDir();
  disposeDir(t, home);
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(
    join(home, "projects", "projects.json"),
    JSON.stringify([
      { projectId: "p1", rootPath: paseoUi.root, kind: "git", archivedAt: null },
      { projectId: "p2", rootPath: "/nonexistent/archived", kind: "git", archivedAt: "2026-01-01T00:00:00Z" },
      { projectId: "p3", rootPath: "/nonexistent/active", kind: "git", archivedAt: null },
    ]),
  );

  const discovered = discoverProjects(stateDir, liveSeatAgents, home);
  assert.deepEqual(
    discovered,
    [
      { slug: "other-xyz789", root: "/w/other" },
      { slug: paseoUi.slug, root: paseoUi.root },
      { slug: acme.slug, root: acme.root },
    ].sort((a, b) => a.slug.localeCompare(b.slug)),
    "registry files, live seat agents, and non-archived Paseo projects all feed the discovery, slug order",
  );

  // Without a home there is no projects.json leg — registry plus live agents only.
  assert.deepEqual(discoverProjects(stateDir, liveSeatAgents), [
    { slug: "other-xyz789", root: "/w/other" },
    { slug: acme.slug, root: acme.root },
  ].sort((a, b) => a.slug.localeCompare(b.slug)));
});
