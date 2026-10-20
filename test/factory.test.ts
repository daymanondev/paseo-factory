import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { projectStateDir, resolveProject } from "../src/project.ts";
import { MAX_ATTEMPTS } from "../src/events.ts";
import type { NeedsHumanReason } from "../src/events.ts";
import { FactoryError } from "../src/errors.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

function makeWorkspace(dir: string): { workspace: string; artifact: string; sha: string } {
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  return { workspace, artifact, sha };
}

// ---- the canonical Project identity (v0.0.14, ADR 0010 §1/§5) --------------------------------

/** The slug the spec's formula demands for a repo whose git dir sits at `<repo>/.git`. */
function expectedSlugFor(repo: string): { slug: string; gitCommonDir: string } {
  const gitCommonDir = realpathSync(join(repo, ".git"));
  const hash = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 6);
  return { slug: `${basenameOf(repo)}-${hash}`, gitCommonDir };
}

function basenameOf(path: string): string {
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf("/");
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

test("resolveProject: one canonical Project per repo — the same root and slug from any directory inside it", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const repo = join(dir, "acme-api");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
  gitCommitAll(repo);
  const expected = expectedSlugFor(repo);

  const fromRoot = resolveProject(repo);
  assert.ok(fromRoot.ok, fromRoot.ok ? "" : fromRoot.reason);
  const fromInside = resolveProject(join(repo, "src"));
  assert.ok(fromInside.ok, fromInside.ok ? "" : fromInside.reason);
  assert.equal(fromRoot.root, fromInside.root, "any cwd inside the repo resolves the same top-level checkout");
  assert.equal(fromRoot.gitCommonDir, expected.gitCommonDir);
  assert.equal(fromRoot.slug, expected.slug, "slug = <basename(root)>-<sha1(realpath(gitCommonDir)).slice(0,6)>");
  assert.equal(projectStateDir(join(dir, "state"), fromRoot.slug), join(dir, "state", "projects", fromRoot.slug));
});

test("resolveProject: a linked worktree keeps the main repo's git dir in its slug — the hash anchors the repo", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const repo = join(dir, "main-repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a.txt"), "a\n");
  gitCommitAll(repo);
  const worktreeDir = join(dir, "feature-wt");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktreeDir], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  const main = expectedSlugFor(repo);

  const resolved = resolveProject(worktreeDir);
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.reason);
  assert.equal(resolved.gitCommonDir, main.gitCommonDir, "--git-common-dir follows the link back to the main repo's git dir");
  const mainHash = createHash("sha1").update(main.gitCommonDir).digest("hex").slice(0, 6);
  assert.equal(resolved.slug, `feature-wt-${mainHash}`);
});

test("resolveProject: a directory outside any git repo is a named refusal, never a guess", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const plain = join(dir, "plain");
  mkdirSync(plain, { recursive: true });

  const resolved = resolveProject(plain);
  assert.ok(!resolved.ok);
  assert.match(resolved.reason, /git/);
});

test("a project-scoped factory keeps its ledger, reports, and gate logs under projects/<slug>/ — the root ledger stays untouched", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const project = resolveProject(workspace);
  assert.ok(project.ok, project.ok ? "" : project.reason);

  const factory = createFactory({ stateDir, projectSlug: project.slug });
  factory.setContract({ task: "P1", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "P1", sha });
  assert.equal(outcome.verdict, "green");

  const projectDir = join(stateDir, "projects", project.slug);
  assert.ok(existsSync(join(projectDir, "ledger.jsonl")), "the ledger lands under projects/<slug>/");
  assert.ok(existsSync(join(projectDir, "report-P1-1.md")), "reports land under projects/<slug>/");
  assert.ok(existsSync(join(projectDir, "gate-P1-1.log")), "gate logs land under projects/<slug>/");
  assert.ok(!existsSync(join(stateDir, "ledger.jsonl")), "no project scope, no root ledger — the trees stay isolated");
  assert.equal(factory.stateDir, stateDir, "the Factory's stateDir stays the root: the spool, the choke writable set, and the git-block log keep their root paths");

  // The legacy path: no projectSlug → exactly today's layout (every pre-0.0.14 test's law).
  const legacy = createFactory({ stateDir: join(dir, "legacy") });
  legacy.setContract({ task: "L1", workspace, gate: "true", artifact });
  await legacy.claim({ task: "L1", sha });
  assert.ok(existsSync(join(dir, "legacy", "ledger.jsonl")));
  assert.ok(!existsSync(join(dir, "legacy", "projects")));
});

test("setContract records the workspace with the criteria, allows re-contracting an unaccepted task into a new epoch, and refuses once accepted or while an attempt is open", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  const evt = factory.setContract({ task: "T1", workspace, gate: "npm test", artifact });

  const { ts, ...rest } = evt;
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rest, {
    seq: 1,
    event: "contract_set",
    task: "T1",
    workspace,
    gate: "npm test",
    artifact,
    base: sha, // recorded on every Contract since v0.0.2 (ticket 03 R2)
  });

  // Re-contracting an unaccepted task with no open attempt starts a fresh Contract epoch.
  const evt2 = factory.setContract({ task: "T1", workspace, gate: "true", artifact });
  assert.equal(evt2.event, "contract_set");
  assert.equal(evt2.seq, 2);
  assert.equal(factory.contractFor("T1")?.gate, "true");

  // While an attempt is open in the current epoch, setContract refuses with gate-running.
  factory.ledger.append({ event: "claim_reported", task: "T1", attempt: 1, sha });
  assert.throws(
    () => factory.setContract({ task: "T1", workspace, gate: "true", artifact }),
    factoryErrorCode("gate-running"),
  );
  factory.ledger.append({ event: "gate_finished", task: "T1", attempt: 1, exit: 1, verdict: "red", note: "failed" });
  factory.ledger.append({ event: "report_written", task: "T1", attempt: 1, path: "report-T1-1.md" });

  // Once the attempt closes, re-contracting T1 starts epoch 3, where the next claim is attempt 1.
  const evt3 = factory.setContract({ task: "T1", workspace, gate: "true", artifact });
  assert.equal(evt3.event, "contract_set");

  // Once a task is accepted, setContract refuses with already-accepted.
  const claimed = await factory.claim({ task: "T1", sha });
  assert.equal(claimed.attempt, 1);
  assert.equal(claimed.verdict, "green");
  await factory.accept({ task: "T1", attempt: 1 });
  assert.throws(
    () => factory.setContract({ task: "T1", workspace, gate: "echo easier", artifact }),
    factoryErrorCode("already-accepted"),
  );
});

test("setContract rejects a workspace that is not an existing absolute directory", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  for (const bad of ["relative/ws", "/definitely/not/here"]) {
    assert.throws(
      () => factory.setContract({ task: "W1", workspace: bad, gate: "true", artifact: "src/x.ts" }),
      factoryErrorCode("invalid-contract"),
      `workspace "${bad}" must be rejected`,
    );
  }
  assert.throws(
    () => factory.setContract({ task: "W1", workspace: join(workspace, "src", "format.ts"), gate: "true", artifact: "src/x.ts" }),
    factoryErrorCode("invalid-contract"),
    "a file is not a workspace",
  );
  assert.deepEqual([...factory.ledger.events], []);
});

test("setContract rejects unusable input instead of writing it to the ledger", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  for (const bad of ["", "../evil", "a/b", ".hidden", "task with spaces"]) {
    assert.throws(
      () => factory.setContract({ task: bad, workspace, gate: "npm test", artifact: "src/x.ts" }),
      (err: unknown) => err instanceof FactoryError,
      `task id "${bad}" must be rejected`,
    );
  }
  assert.throws(() => factory.setContract({ task: "T1", workspace, gate: "  ", artifact: "src/x.ts" }), FactoryError);
  assert.throws(() => factory.setContract({ task: "T1", workspace, gate: "npm test", artifact: "" }), FactoryError);
  assert.deepEqual([...factory.ledger.events], [], "rejected input must not touch the ledger");
});

test("claim without a contract fails before anything is appended", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  await assert.rejects(factory.claim({ task: "T404", sha: "a1b2c3d" }), factoryErrorCode("unknown-task"));
  assert.deepEqual([...factory.ledger.events], []);
});

test("claim with an unknown sha is a red verdict, never a HEAD fallback", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "U1", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "U1", sha: "1234567890123456789012345678901234567890" });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.attempt, 1);
  assert.equal(outcome.gate.exit, null, "the gate command must not run on an unverified sha");
  assert.match(outcome.gate.note, /cannot be resolved/);
  assert.equal(outcome.gate.sha, undefined);
  assert.deepEqual(
    factory.ledger.eventsFor("U1").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
});

test("claim with an empty sha is a red verdict, not a thrown error", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "U2", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "U2", sha: "   " });

  assert.equal(outcome.verdict, "red");
  assert.match(outcome.gate.note, /claimed sha is empty/);
});

test("claim on a dirty tree is red even though the commit exists", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  writeFileSync(join(workspace, artifact), "export function pad() { return 1; }\n"); // uncommitted change
  factory.setContract({ task: "D1", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "D1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null);
  assert.match(outcome.gate.note, /not clean at the claimed commit before the gate/);
  assert.equal(outcome.gate.sha, sha, "the sha still resolved, so the verdict records what it attests");
});

test("a gate that moves HEAD during the run is red even when it exits 0", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "M1", workspace, gate: "git commit -q --allow-empty -m moved", artifact });
  const outcome = await factory.claim({ task: "M1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 0, "the command itself succeeded — that is exactly the trap");
  assert.match(outcome.gate.note, /workspace moved during the gate/);
});

test("a claim by short sha attests the full resolved commit", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "S1", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "S1", sha: sha.slice(0, 7) });

  assert.equal(outcome.verdict, "green");
  assert.equal(outcome.gate.sha, sha);
  assert.match(sha, /^[0-9a-f]{40}$/);
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes(`- Attested commit: \`${sha}\``), "the report shows the commit the verdict attests");
});

test("claim red path appends the full event sequence and writes the report", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "T9", workspace, gate: "exit 3", artifact });
  const outcome = await factory.claim({ task: "T9", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 3);
  assert.deepEqual(
    factory.ledger.eventsFor("T9").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
  assert.equal(outcome.reportPath, join(stateDir, "report-T9-1.md"));
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.match(report, /# T9 — /);
  assert.ok(report.includes("- Verdict: RED —"));
});

test("claim green path when gate passes and artifact exists at the claimed commit", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "T10", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "T10", sha });

  assert.equal(outcome.verdict, "green");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Verdict: GREEN —"));
  assert.ok(!report.includes("Conclusion"), "the report states evidence, it does not conclude");
  assert.ok(!/\bDONE\b/.test(report), '"done" stays out of the report — green is evidence, not acceptance');
});

test("claim timeout flows through as red with exit null", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), timeoutMs: 250 });

  factory.setContract({ task: "T11", workspace, gate: "sleep 30", artifact });
  const outcome = await factory.claim({ task: "T11", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null);
  assert.match(outcome.gate.note, /timeout/i);
});

test("a gate command that does not exist is red with the shell's exit code", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "T12", workspace, gate: "definitely-not-a-command-xyz", artifact });
  const outcome = await factory.claim({ task: "T12", sha });

  // /bin/sh resolves command-not-found itself and exits 127 — the factory
  // records that fact instead of special-casing it.
  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 127);
  assert.match(outcome.gate.note, /not found/i);
  assert.deepEqual(
    factory.ledger.eventsFor("T12").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
});

test("a workspace git cannot read is refused at contract time — the base is the diff range (ticket 03 R2)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "plain");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const factory = createFactory({ stateDir: join(dir, "factory") });

  // Since v0.0.2 every Contract records its base commit, so a workspace with
  // no resolvable HEAD is refused up front — scoped or not.
  assert.throws(
    () => factory.setContract({ task: "G1", workspace, gate: "true", artifact: "src/format.ts" }),
    factoryErrorCode("invalid-contract"),
  );
  assert.deepEqual([...factory.ledger.events], []);
});

test("scoped contract: an in-scope-only diff behaves exactly as today", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "SC1", workspace, gate: "true", artifact, scope: ["src"] });
  writeFileSync(join(workspace, "src", "extra.ts"), "export const extra = 1;\n");
  const sha2 = gitCommitChanges(workspace, "add extra module in scope");
  const outcome = await factory.claim({ task: "SC1", sha: sha2 });

  assert.equal(outcome.verdict, "green");
  assert.equal(outcome.gate.sha, sha2);
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("scope: `src`"), "the report shows the declared boundary");
});

test("scoped contract: one file outside scope is red with that file named", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "SC2", workspace, gate: "true", artifact, scope: ["src"] });
  writeFileSync(join(workspace, "src", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(workspace, "README.md"), "# touched out of scope\n");
  const sha2 = gitCommitChanges(workspace, "add extra module and touch README");
  const outcome = await factory.claim({ task: "SC2", sha: sha2 });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 0, "the gate passed — the overreach is what is red");
  assert.ok(outcome.gate.note.includes("changes outside declared scope"), outcome.gate.note);
  assert.ok(outcome.gate.note.includes("README.md"), "the offending file is named");
  assert.ok(!outcome.gate.note.includes("extra.ts"), "in-scope files are not named");
});

test("omitted scope keeps the unrestricted v0.0.1 behavior", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "SC3", workspace, gate: "true", artifact });
  writeFileSync(join(workspace, "README.md"), "# anywhere is fine without a scope\n");
  const sha2 = gitCommitChanges(workspace, "touch README with no scope declared");
  const outcome = await factory.claim({ task: "SC3", sha: sha2 });

  assert.equal(outcome.verdict, "green");
});

test("the memory write fence on claims: AGENTS.md/CLAUDE.md/CONTEXT.md edits red every contract that does not scope them", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  // Unrestricted scope used to mean "anywhere is fine" — the fence (v0.0.14,
  // ADR 0010 §6) carves the three memory files out of that: project memory is
  // the Supervisor/Lead's act, never a worker's side effect.
  factory.setContract({ task: "F1", workspace, gate: "true", artifact });
  writeFileSync(join(workspace, "AGENTS.md"), "# poisoned rules\n");
  const poisoned = gitCommitChanges(workspace, "edit AGENTS.md");
  const unscoped = await factory.claim({ task: "F1", sha: poisoned });
  assert.equal(unscoped.verdict, "red");
  assert.equal(unscoped.gate.exit, 0, "the gate passed — the memory edit is what is red");
  assert.match(unscoped.gate.note, /AGENTS\.md/, "the offending file is named");
  assert.match(unscoped.gate.note, /memory/i);
  assert.ok(!unscoped.gate.note.includes("outside declared scope"), "an unscoped contract speaks the fence's words, not the scope check's");

  // A scoped contract that does NOT list the file: the scope check reds it
  // (the fence and the scope check agree — the file is outside the boundary).
  const ws2 = join(dir, "ws2");
  mkdirSync(join(ws2, "src"), { recursive: true });
  writeFileSync(join(ws2, artifact), "export function pad() {}\n");
  gitCommitAll(ws2);
  factory.setContract({ task: "F2", workspace: ws2, gate: "true", artifact, scope: ["src"] });
  writeFileSync(join(ws2, "CLAUDE.md"), "# poisoned too\n");
  const fencedScoped = gitCommitChanges(ws2, "edit CLAUDE.md");
  const scoped = await factory.claim({ task: "F2", sha: fencedScoped });
  assert.equal(scoped.verdict, "red");
  assert.match(scoped.gate.note, /outside declared scope/);
  assert.match(scoped.gate.note, /CLAUDE\.md/);

  // The opt-in: a Contract that explicitly scopes the memory file admits the
  // edit (documentation maintenance is legal work when contracted for).
  const ws3 = join(dir, "ws3");
  mkdirSync(join(ws3, "src"), { recursive: true });
  writeFileSync(join(ws3, artifact), "export function pad() {}\n");
  gitCommitAll(ws3);
  factory.setContract({ task: "F3", workspace: ws3, gate: "true", artifact, scope: ["AGENTS.md"] });
  writeFileSync(join(ws3, "AGENTS.md"), "# a ratified rule, deliberately contracted\n");
  const ratified = gitCommitChanges(ws3, "edit AGENTS.md under an explicit scope");
  const allowed = await factory.claim({ task: "F3", sha: ratified });
  assert.equal(allowed.verdict, "green", "an explicitly scoped memory edit is contracted work");
});

test("unusable scope entries are rejected without touching the ledger", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  for (const bad of [["/absolute/path"], ["../escape"], [""], ["ok", ".."]]) {
    assert.throws(
      () => factory.setContract({ task: "SC4", workspace, gate: "true", artifact, scope: bad as string[] }),
      factoryErrorCode("invalid-contract"),
      `scope ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.deepEqual([...factory.ledger.events], []);
});

test("a scoped contract refuses a workspace git cannot read", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "plain");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const factory = createFactory({ stateDir: join(dir, "factory") });

  assert.throws(
    () => factory.setContract({ task: "SC5", workspace, gate: "true", artifact: "src/format.ts", scope: ["src"] }),
    factoryErrorCode("invalid-contract"),
  );
});

test("setContract carries an optional skills list — validated when present, omitted when empty", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  // A second, distinct tree — one contract per workspace (the conflict guard's own law).
  const secondWorkspace = join(dir, "ws2");
  mkdirSync(join(secondWorkspace, "src"), { recursive: true });
  writeFileSync(join(secondWorkspace, artifact), "export function pad() {}\n");
  gitCommitAll(secondWorkspace);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  const withSkills = factory.setContract({ task: "SK1", workspace, gate: "true", artifact, skills: ["tdd", "diagnosing-bugs"] });
  assert.deepEqual(withSkills.skills, ["tdd", "diagnosing-bugs"], "the mandated skills ride the Contract line");

  const empty = factory.setContract({ task: "SK2", workspace: secondWorkspace, gate: "true", artifact, skills: [] });
  assert.equal("skills" in empty, false, "an empty list omits the field — scope's own law");

  for (const bad of [[""], ["ok", 1], ["  "]]) {
    assert.throws(
      () => factory.setContract({ task: "SKX", workspace: secondWorkspace, gate: "true", artifact, skills: bad as unknown as string[] }),
      factoryErrorCode("invalid-contract"),
      `skills ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.equal(
    factory.ledger.events.filter((e) => e.event === "contract_set").length,
    2,
    "only the two valid contracts landed — rejected skills touch nothing",
  );
});

test("two tasks share one ledger with independent seq and reports", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const ws2 = join(dir, "ws2");
  mkdirSync(join(ws2, "src"), { recursive: true });
  writeFileSync(join(ws2, artifact), "export function pad() {}\n");
  const sha2 = gitCommitAll(ws2);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "A1", workspace, gate: "true", artifact });
  factory.setContract({ task: "A2", workspace: ws2, gate: "exit 1", artifact });
  const first = await factory.claim({ task: "A1", sha });
  const second = await factory.claim({ task: "A2", sha: sha2 });

  assert.equal(first.verdict, "green");
  assert.equal(second.verdict, "red");
  assert.deepEqual(factory.ledger.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.notEqual(first.reportPath, second.reportPath);
});

test("a second claim after a red attempt opens attempt 2 with its own report (ADR 0003)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "R1", workspace, gate: "exit 1", artifact });
  const first = await factory.claim({ task: "R1", sha });
  const second = await factory.claim({ task: "R1", sha });

  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);
  assert.equal(second.reportPath, join(stateDir, "report-R1-2.md"));
  assert.ok(existsSync(join(stateDir, "report-R1-1.md")), "attempt 1's report is never overwritten");
  assert.deepEqual(
    factory.ledger.eventsFor("R1").filter((e) => "attempt" in e && e.attempt === 2).map((e) => e.event),
    ["claim_reported", "gate_started", "gate_finished", "report_written"],
  );
  const report2 = readFileSync(second.reportPath, "utf8");
  assert.ok(report2.includes("- Attempt: 2 of 2"));
});

test("a claim while the previous attempt's gate is still running is rejected (ADR 0003)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "R2", workspace, gate: "sleep 1", artifact });
  const inFlight = factory.claim({ task: "R2", sha });
  await assert.rejects(factory.claim({ task: "R2", sha }), factoryErrorCode("gate-running"));
  const outcome = await inFlight;
  assert.equal(outcome.attempt, 1, "the original claim completes untouched");
  assert.deepEqual(
    factory.ledger.eventsFor("R2").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
    "the rejected claim appended nothing",
  );
});

test("accept: the Owner accepts a green attempt, once, and only green attempts (ADR 0002)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "AC1", workspace, gate: "grep -q padEnd src/format.ts", artifact });
  const red = await factory.claim({ task: "AC1", sha });
  assert.equal(red.verdict, "red");
  await assert.rejects(factory.accept({ task: "AC1", attempt: 1 }), factoryErrorCode("not-green"));
  assert.deepEqual(
    factory.ledger.eventsFor("AC1").filter((e) => e.event === "attempt_accepted"),
    [],
    "a rejected acceptance writes nothing",
  );

  // The agent fixes the work; the next attempt is green and acceptable.
  writeFileSync(join(workspace, artifact), "export function pad(input: string, width: number): string {\n  return input.padEnd(width).slice(0, width);\n}\n");
  const sha2 = gitCommitChanges(workspace, "fix pad");
  const green = await factory.claim({ task: "AC1", sha: sha2 });
  assert.equal(green.verdict, "green");

  const accepted = await factory.accept({ task: "AC1", attempt: green.attempt });
  assert.equal(accepted.event, "attempt_accepted");
  assert.equal(accepted.attempt, green.attempt);

  await assert.rejects(factory.accept({ task: "AC1", attempt: 1 }), factoryErrorCode("already-accepted"));
  await assert.rejects(factory.accept({ task: "AC1", attempt: 9 }), factoryErrorCode("unknown-attempt"));
  await assert.rejects(factory.accept({ task: "AC2", attempt: 1 }), factoryErrorCode("unknown-task"));
  await assert.rejects(factory.accept({ task: "AC1", attempt: 0 }), factoryErrorCode("invalid-attempt"));
});

test("opening the ledger closes an attempt interrupted mid-gate: red, reported, logged (ADR 0003)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");

  // The factory "crashes" mid-gate: claim_reported + gate_started, nothing after.
  const crashed = createFactory({ stateDir });
  crashed.setContract({ task: "REC1", workspace, gate: "sleep 30", artifact });
  crashed.ledger.append({ event: "claim_reported", task: "REC1", attempt: 1, sha });
  crashed.ledger.append({ event: "gate_started", task: "REC1", attempt: 1, cmd: "sleep 30" });

  const reopened = createFactory({ stateDir });

  assert.deepEqual(reopened.recoveredAttempts, [{ task: "REC1", attempt: 1 }]);
  const gate = reopened.ledger.eventsFor("REC1").findLast((e) => e.event === "gate_finished");
  assert.equal(gate?.verdict, "red");
  assert.equal(gate?.exit, null);
  assert.match(gate?.note ?? "", /interrupted — the factory restarted before the Gate finished/);
  const reportPath = join(stateDir, "report-REC1-1.md");
  assert.ok(existsSync(reportPath), "the recovered attempt still gets its report");
  assert.match(readFileSync(reportPath, "utf8"), /- Verdict: RED — interrupted/);

  // The task is claimable again — the recovered attempt is closed.
  const next = await reopened.claim({ task: "REC1", sha });
  assert.equal(next.attempt, 2, "the next claim opens attempt 2, never reuses the interrupted one");
});

test("opening the ledger closes an attempt interrupted before the gate even started", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");

  const crashed = createFactory({ stateDir });
  crashed.setContract({ task: "REC2", workspace, gate: "true", artifact });
  crashed.ledger.append({ event: "claim_reported", task: "REC2", attempt: 1, sha });

  const reopened = createFactory({ stateDir });

  assert.deepEqual(reopened.recoveredAttempts, [{ task: "REC2", attempt: 1 }]);
  const gate = reopened.ledger.eventsFor("REC2").findLast((e) => e.event === "gate_finished");
  assert.match(gate?.note ?? "", /interrupted — the factory restarted before the Gate started/);
});

test("liveContractFor binds a cwd to a live contract — exact, nested, retired by acceptance", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const wsA = join(dir, "wsA");
  const wsB = join(dir, "wsB");
  for (const ws of [wsA, wsB]) {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "x.ts"), "x\n");
    gitCommitAll(ws);
  }
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "A", workspace: wsA, gate: "true", artifact: "src/x.ts" });
  factory.setContract({ task: "B", workspace: wsB, gate: "true", artifact: "src/x.ts" });

  assert.equal(factory.liveContractFor(wsA)?.task, "A");
  assert.equal(factory.liveContractFor(join(wsA, "src"))?.task, "A", "a cwd inside the workspace is still that workspace's agent");
  assert.equal(factory.liveContractFor(wsB)?.task, "B");
  assert.equal(factory.liveContractFor(join(dir, "wsA-evil")), undefined, "a sibling prefix is not inside — /wsA-evil must not match /wsA");

  // Acceptance retires: once A is accepted, its tree binds no live contract.
  factory.ledger.append({ event: "attempt_accepted", task: "A", attempt: 1 });
  assert.equal(factory.liveContractFor(wsA), undefined, "accepted — no live contract, no choke");
  assert.equal(factory.liveContractFor(wsB)?.task, "B", "acceptance is per task, not global");
});

test("setContract refuses a workspace overlapping another live contract — equal, nested, containing (H1/H2)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const wsA = join(dir, "wsA");
  const wsDeep = join(wsA, "deep");
  const wsB = join(dir, "wsB");
  for (const ws of [wsA, wsDeep, wsB]) {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "x.ts"), "x\n");
    gitCommitAll(ws);
  }
  gitCommitAll(dir); // the parent tree of them all — for the "contains" arm
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "A", workspace: wsA, gate: "true", artifact: "src/x.ts" });

  // Same tree, different task — equal.
  assert.throws(
    () => factory.setContract({ task: "SAME", workspace: wsA, gate: "true", artifact: "src/x.ts" }),
    (err: unknown) => err instanceof FactoryError && err.code === "workspace-conflict" && /is the same tree as.*task A/.test(err.message),
  );
  // A contract inside A's tree — nests.
  assert.throws(
    () => factory.setContract({ task: "NEST", workspace: wsDeep, gate: "true", artifact: "src/x.ts" }),
    (err: unknown) => err instanceof FactoryError && err.code === "workspace-conflict" && /sits inside/.test(err.message),
  );
  // A contract on the parent tree — contains A.
  assert.throws(
    () => factory.setContract({ task: "WIDE", workspace: dir, gate: "true", artifact: "wsA/src/x.ts" }),
    (err: unknown) => err instanceof FactoryError && err.code === "workspace-conflict" && /contains/.test(err.message),
  );
  // A trailing slash on the same tree is still the same tree.
  assert.throws(
    () => factory.setContract({ task: "SLASH", workspace: `${wsA}/`, gate: "true", artifact: "src/x.ts" }),
    factoryErrorCode("workspace-conflict"),
  );
  // Every refusal left the ledger untouched.
  assert.deepEqual(
    factory.ledger.events.map((e) => `${e.event}:${"task" in e ? e.task : ""}`),
    ["contract_set:A"],
  );

  // Acceptance retires the tree: A accepted, the same workspace contracts again.
  factory.ledger.append({ event: "attempt_accepted", task: "A", attempt: 1 });
  const next = factory.setContract({ task: "REUSE", workspace: wsA, gate: "true", artifact: "src/x.ts" });
  assert.equal(next.event, "contract_set");

  // Sibling trees never conflicted in the first place.
  const sibling = createFactory({ stateDir: join(dir, "state2") });
  sibling.setContract({ task: "A", workspace: wsA, gate: "true", artifact: "src/x.ts" });
  assert.equal(sibling.setContract({ task: "B", workspace: wsB, gate: "true", artifact: "src/x.ts" }).event, "contract_set");
});

test("claim refuses on an accepted task — the H6 rider closes the loop's far end", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "CLOSED", workspace, gate: "true", artifact });
  await factory.claim({ task: "CLOSED", sha });
  await factory.accept({ task: "CLOSED", attempt: 1 });
  const eventsBefore = factory.ledger.events.length;

  await assert.rejects(factory.claim({ task: "CLOSED", sha }), factoryErrorCode("already-accepted"));
  assert.equal(factory.ledger.events.length, eventsBefore, "the refused claim appends nothing");
});

test("requestSpawn dispatches a contracted task and appends exactly one spawn_dispatched line", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "SPAWN-1", workspace, gate: "true", artifact, scope: ["src"] });

  const decision = factory.requestSpawn({ task: "SPAWN-1", provider: "claude/opus-4-8", arity: 2 });

  assert.equal(decision.outcome, "dispatched");
  const { ts, ...rest } = decision.event;
  assert.deepEqual(rest, { seq: 2, event: "spawn_dispatched", task: "SPAWN-1", provider: "claude/opus-4-8", arity: 2 });
  assert.deepEqual(factory.ledger.eventsFor("SPAWN-1").map((e) => e.event), ["contract_set", "spawn_dispatched"]);
});

test("requestSpawn refuses and records one spawn_refused line per rule", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "x"), "x\n");
  gitCommitAll(elsewhere);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "KNOWN", workspace, gate: "true", artifact, scope: ["src"] });
  factory.setContract({ task: "BARE", workspace: elsewhere, gate: "true", artifact: "x" });

  // Unknown task — the refusal still gets its line, named for the ask.
  const unknown = factory.requestSpawn({ task: "GHOST", provider: "claude", arity: 1 });
  assert.equal(unknown.outcome, "refused");
  if (unknown.outcome === "refused") {
    assert.equal(unknown.code, "unknown-task");
    assert.equal(unknown.event.rule, "spawn:unknown-task");
    assert.match(unknown.event.reason, /no contract set for task GHOST/);
  }

  // Malformed task id — refused, not thrown.
  const invalid = factory.requestSpawn({ task: "no spaces", provider: "claude", arity: 1 });
  assert.equal(invalid.outcome, "refused");
  if (invalid.outcome === "refused") assert.equal(invalid.event.rule, "spawn:invalid-task");

  // Scope-mandatory fires at arity ≥ 2 only — n=1 dispatches the bare contract.
  const bare1 = factory.requestSpawn({ task: "BARE", provider: "claude", arity: 1 });
  assert.equal(bare1.outcome, "dispatched", "a lone run may carry an unscoped contract (v0.0.1 behavior)");
  const bare2 = factory.requestSpawn({ task: "BARE", provider: "claude", arity: 2 });
  assert.equal(bare2.outcome, "refused");
  if (bare2.outcome === "refused") {
    assert.equal(bare2.code, "spawn-scope-mandatory");
    assert.match(bare2.event.reason, /must be scoped to run in parallel/);
  }

  // Accepted task — closed to spawns.
  await factory.claim({ task: "KNOWN", sha });
  await factory.accept({ task: "KNOWN", attempt: 1 });
  const accepted = factory.requestSpawn({ task: "KNOWN", provider: "claude", arity: 1 });
  assert.equal(accepted.outcome, "refused");
  if (accepted.outcome === "refused") assert.equal(accepted.event.rule, "spawn:accepted-task");

  const lines = factory.ledger.events.filter((e) => e.event === "spawn_refused");
  assert.equal(lines.length, 4, "every refusal is exactly one line");
  assert.ok(lines.every((e) => e.event === "spawn_refused" && typeof e.provider === "string" && e.arity >= 1));
});

test("requestSpawn refuses a workspace overlapping another live contract — the driver's spawn-time arm", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const wsA = join(dir, "wsA");
  const wsB = join(dir, "wsB");
  for (const ws of [wsA, wsB]) {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "x.ts"), "x\n");
    gitCommitAll(ws);
  }
  // Contract both before either is live-blocked: the overlap was contracted
  // via direct ledger appends (the setContract guard would refuse it), so the
  // spawn-time scan is the last line of defense — belt and braces by design.
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "A", workspace: wsA, gate: "true", artifact: "src/x.ts", scope: ["src"] });
  const bContract = factory.ledger.append({ event: "contract_set", task: "B", workspace: join(wsA, "sub"), gate: "true", artifact: "src/x.ts", scope: ["src"] });
  assert.ok(bContract.event === "contract_set");

  const refused = factory.requestSpawn({ task: "B", provider: "claude", arity: 2 });
  assert.equal(refused.outcome, "refused");
  if (refused.outcome === "refused") {
    assert.equal(refused.code, "workspace-conflict");
    assert.equal(refused.event.rule, "spawn:workspace-conflict");
    assert.match(refused.event.reason, /sits inside the live contract of task A/);
  }
  // The scan is symmetric: A's tree now contains B's live contract, so A
  // refuses too — an overlapping live set is unsafe for both sides, whoever
  // contracted it.
  const alsoRefused = factory.requestSpawn({ task: "A", provider: "claude", arity: 2 });
  assert.equal(alsoRefused.outcome, "refused");
  if (alsoRefused.outcome === "refused") {
    assert.equal(alsoRefused.code, "workspace-conflict");
    assert.match(alsoRefused.event.reason, /contains the live contract of task B/);
  }
});

// ---- the Lead's two acts (v0.0.10, ticket 03 items 2–3) ------------------------------

test("repoke dispatches once per task and refuses the second ask with one repoke_refused line (the structural idempotency)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "LEAD1", workspace, gate: "true", artifact });

  const first = factory.repoke("LEAD1", "ag-lead1");
  assert.equal(first.outcome, "dispatched");
  const { ts, ...rest } = first.outcome === "dispatched" ? first.event : { ts: "", event: undefined };
  assert.deepEqual(rest, { seq: 2, event: "repoke_dispatched", task: "LEAD1", agent: "ag-lead1" }, "the dispatch line IS the spent marker — task and its target, nothing else");

  // The one-per-task law lives plugin-side: a second ask names its own refusal.
  const second = factory.repoke("LEAD1", "ag-lead1");
  assert.equal(second.outcome, "refused");
  if (second.outcome === "refused") {
    assert.equal(second.code, "already-spent");
    assert.equal(second.event.rule, "repoke:already-spent");
    assert.match(second.event.reason, /already spent its one re-poke/);
    assert.equal(second.event.agent, "ag-lead1", "the refusal names the target the request named");
  }

  // Unknown task and malformed ids — each still exactly one line.
  const unknown = factory.repoke("GHOST", "ag-x");
  assert.equal(unknown.outcome === "refused" && unknown.event.rule, "repoke:unknown-task");
  const invalid = factory.repoke("no spaces", "ag-x");
  assert.equal(invalid.outcome === "refused" && invalid.event.rule, "repoke:invalid-task");

  // An accepted task is closed to pokes as to spawns (its own tree — LEAD1's stays live).
  const wsDone = join(dir, "ws-done");
  mkdirSync(join(wsDone, "src"), { recursive: true });
  writeFileSync(join(wsDone, "src", "x.ts"), "x\n");
  const shaDone = gitCommitAll(wsDone);
  factory.setContract({ task: "DONE", workspace: wsDone, gate: "true", artifact: "src/x.ts" });
  await factory.claim({ task: "DONE", sha: shaDone });
  await factory.accept({ task: "DONE", attempt: 1 });
  const accepted = factory.repoke("DONE", "ag-done");
  assert.equal(accepted.outcome === "refused" && accepted.event.rule, "repoke:accepted-task");

  assert.deepEqual(
    factory.ledger.events.filter((e) => e.event === "repoke_refused").map((e) => (e as { rule: string }).rule),
    ["repoke:already-spent", "repoke:unknown-task", "repoke:invalid-task", "repoke:accepted-task"],
    "every refusal is one recorded line, the spawn precedent",
  );
});

test("needsHuman appends the named end only over a corroborated spend — the meter's own refusal law", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "LEAD2", workspace, gate: "true", artifact });

  // No spend yet — nothing to name, no line. needsHuman throws
  // synchronously (the meter's own shape), so the closures carry it.
  assert.throws(
    () => factory.needsHuman({ task: "LEAD2", reason: "denied-again", evidence: { denial: 3, repoke: 4 } }),
    factoryErrorCode("invalid-needs-human"),
  );
  assert.equal(factory.ledger.events.some((e) => e.event === "needs_human"), false);

  // The stall's own denial — the evidence's denial must be a real line.
  const denial = factory.ledger.append({
    event: "permit_denied",
    task: "LEAD2",
    agent: "ag-lead2",
    name: "Bash",
    kind: "tool",
    command: "git reset --hard",
    rule: "policy:S1-git-vocabulary",
    reason: "caught",
  });
  const dispatch = factory.repoke("LEAD2", "ag-lead2");
  assert.equal(dispatch.outcome, "dispatched");
  const spentSeq = dispatch.outcome === "dispatched" ? dispatch.event.seq : 0;

  // Evidence must name THE spend the slice holds.
  assert.throws(
    () => factory.needsHuman({ task: "LEAD2", reason: "silent-after-repoke", evidence: { denial: 1, repoke: spentSeq + 5 } }),
    factoryErrorCode("invalid-needs-human"),
  );
  assert.throws(
    // The cast is the point: the vocabulary is a compile-time fact, and the
    // runtime guard still refuses what a cast smuggles through.
    () => factory.needsHuman({ task: "LEAD2", reason: "nudged" as NeedsHumanReason, evidence: { denial: 1, repoke: spentSeq } }),
    factoryErrorCode("invalid-needs-human"),
    "the reason vocabulary is fixed",
  );
  assert.throws(
    () => factory.needsHuman({ task: "GHOST", reason: "denied-again", evidence: { denial: 1, repoke: spentSeq } }),
    factoryErrorCode("unknown-task"),
  );

  const line = factory.needsHuman({ task: "LEAD2", reason: "silent-after-repoke", evidence: { denial: denial.seq, repoke: spentSeq } });
  const { ts, ...rest } = line;
  assert.deepEqual(rest, { seq: spentSeq + 1, event: "needs_human", task: "LEAD2", reason: "silent-after-repoke", evidence: { denial: denial.seq, repoke: spentSeq } });

  // The task is not closed: a second needs_human line is another recorded
  // fact (the ledger appends), and the wake path stays the ordinary spawn.
  assert.equal(factory.ledger.eventsFor("LEAD2").some((e) => e.event === "attempt_accepted"), false);
});

// ---- v0.0.12 (ADR 0008): attempt-ceiling + respawn ----------------------------------

test("claim enforces the Attempt ceiling (MAX_ATTEMPTS = 3): Attempts 1–3 open, Attempt 4 throws attempt-ceiling with zero new ledger lines", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "CEIL1", workspace, gate: "false", artifact });

  assert.equal(MAX_ATTEMPTS, 3, "the ceiling is fixed in code at 3 (ADR 0008 §1)");

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const out = await factory.claim({ task: "CEIL1", sha });
    assert.equal(out.attempt, i);
    assert.equal(out.verdict, "red");
  }
  const countAfterThree = factory.ledger.eventsFor("CEIL1").length;

  await assert.rejects(
    () => factory.claim({ task: "CEIL1", sha }),
    factoryErrorCode("attempt-ceiling"),
    "no fourth Attempt may open",
  );
  assert.equal(
    factory.ledger.eventsFor("CEIL1").length,
    countAfterThree,
    "the refused fourth claim writes neither claim_reported nor gate_started",
  );
});

test("requestSpawn refuses at the Attempt ceiling (spawn:attempt-ceiling) when three red Attempts are already on record", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "CEIL-SP", workspace, gate: "false", artifact });

  for (let i = 1; i <= 2; i++) {
    await factory.claim({ task: "CEIL-SP", sha });
  }
  const beforeCeiling = factory.requestSpawn({ task: "CEIL-SP", provider: "pi/zai/glm-5.3", arity: 1 });
  assert.equal(beforeCeiling.outcome, "dispatched", "below the ceiling, dispatching a fresh spawn to finish the remaining Attempt is legal");

  await factory.claim({ task: "CEIL-SP", sha });
  const atCeiling = factory.requestSpawn({ task: "CEIL-SP", provider: "pi/zai/glm-5.3", arity: 1 });
  assert.equal(atCeiling.outcome, "refused");
  if (atCeiling.outcome === "refused") {
    assert.equal(atCeiling.code, "attempt-ceiling");
    assert.equal(atCeiling.event.rule, "spawn:attempt-ceiling");
    assert.match(atCeiling.event.reason, /attempt ceiling/);
  }
});

test("respawn enforces one automatic Respawn per progress marker (spawn_dispatched or gate_finished), resets after a new Attempt, and records refusals", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "RESP1", workspace, gate: "false", artifact });

  // Before any spawn_dispatched, respawn refuses with respawn:not-spawned.
  const notSpawned = factory.respawn({ task: "RESP1", provider: "pi/zai/glm-5.3", died_agent: "ag-0" });
  assert.equal(notSpawned.outcome, "refused");
  if (notSpawned.outcome === "refused") {
    assert.equal(notSpawned.code, "not-spawned");
    assert.equal(notSpawned.event.rule, "respawn:not-spawned");
  }

  // Initial spawn sets the first progress marker.
  const spawned = factory.requestSpawn({ task: "RESP1", provider: "pi/zai/glm-5.3", arity: 1 });
  assert.equal(spawned.outcome, "dispatched");

  // First death after spawn → respawn_dispatched.
  const first = factory.respawn({ task: "RESP1", provider: "pi/zai/glm-5.3", died_agent: "ag-1" });
  assert.equal(first.outcome, "dispatched");
  if (first.outcome === "dispatched") {
    const { ts, ...rest } = first.event;
    assert.deepEqual(rest, {
      seq: 4,
      event: "respawn_dispatched",
      task: "RESP1",
      provider: "pi/zai/glm-5.3",
      died_agent: "ag-1",
    });
  }

  // Second death with no new gate_finished in between → refused (respawn:already-spent).
  const second = factory.respawn({ task: "RESP1", provider: "pi/zai/glm-5.3", died_agent: "ag-2" });
  assert.equal(second.outcome, "refused");
  if (second.outcome === "refused") {
    assert.equal(second.code, "respawn-ceiling");
    assert.equal(second.event.rule, "respawn:already-spent");
    assert.equal(second.event.died_agent, "ag-2");
  }

  // A new Attempt (gate_finished) is a new progress marker — resets the one-respawn allowance.
  const a1 = await factory.claim({ task: "RESP1", sha });
  assert.equal(a1.attempt, 1);
  assert.equal(a1.verdict, "red");

  const afterAttempt1 = factory.respawn({ task: "RESP1", provider: "pi/zai/glm-5.3", died_agent: "ag-2" });
  assert.equal(afterAttempt1.outcome, "dispatched", "a new gate_finished progress marker allows one fresh respawn");

  const spentAgain = factory.respawn({ task: "RESP1", provider: "pi/zai/glm-5.3", died_agent: "ag-3" });
  assert.equal(spentAgain.outcome, "refused");
  if (spentAgain.outcome === "refused") {
    assert.equal(spentAgain.code, "respawn-ceiling");
    assert.equal(spentAgain.event.rule, "respawn:already-spent");
  }

  // Exhaust Attempts 2 and 3 → respawn refuses at attempt-ceiling.
  await factory.claim({ task: "RESP1", sha });
  await factory.claim({ task: "RESP1", sha });
  const atCeiling = factory.respawn({ task: "RESP1", provider: "pi/zai/glm-5.3", died_agent: "ag-4" });
  assert.equal(atCeiling.outcome, "refused");
  if (atCeiling.outcome === "refused") {
    assert.equal(atCeiling.code, "attempt-ceiling");
    assert.equal(atCeiling.event.rule, "respawn:attempt-ceiling");
  }

  // Validation refusals: invalid request, invalid task, unknown task.
  const badReq = factory.respawn({ task: "RESP1", provider: "pi/zai/glm-5.3", died_agent: "  " });
  assert.equal(badReq.outcome === "refused" && badReq.event.rule, "respawn:invalid-request");
  const badTask = factory.respawn({ task: "bad task", provider: "pi/zai/glm-5.3", died_agent: "ag-x" });
  assert.equal(badTask.outcome === "refused" && badTask.event.rule, "respawn:invalid-task");
  const unknown = factory.respawn({ task: "GHOST", provider: "pi/zai/glm-5.3", died_agent: "ag-x" });
  assert.equal(unknown.outcome === "refused" && unknown.event.rule, "respawn:unknown-task");
});

test("needsHuman corroborates attempt-ceiling and died-after-respawn against the ledger slice, refusing forged or mismatched evidence", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "NH-V12", workspace, gate: "false", artifact });

  const spawnOut = factory.requestSpawn({ task: "NH-V12", provider: "pi/zai/glm-5.3", arity: 1 });
  assert.equal(spawnOut.outcome, "dispatched");
  const spawnSeq = spawnOut.outcome === "dispatched" ? spawnOut.event.seq : 0;

  // Before any respawn, died-after-respawn refuses.
  assert.throws(
    () => factory.needsHuman({ task: "NH-V12", reason: "died-after-respawn", evidence: { spawn: spawnSeq, respawn: spawnSeq + 1 } }),
    factoryErrorCode("invalid-needs-human"),
  );

  const respawnOut = factory.respawn({ task: "NH-V12", provider: "pi/zai/glm-5.3", died_agent: "ag-1" });
  assert.equal(respawnOut.outcome, "dispatched");
  const respawnSeq = respawnOut.outcome === "dispatched" ? respawnOut.event.seq : 0;

  // Mismatched reason + evidence shape refuses.
  assert.throws(
    () => factory.needsHuman({ task: "NH-V12", reason: "died-after-respawn", evidence: { attempt: 3, gate: respawnSeq } as never }),
    factoryErrorCode("invalid-needs-human"),
  );
  // Forged spawn seq refuses.
  assert.throws(
    () => factory.needsHuman({ task: "NH-V12", reason: "died-after-respawn", evidence: { spawn: 999, respawn: respawnSeq } }),
    factoryErrorCode("invalid-needs-human"),
  );

  // Valid died-after-respawn appends needs_human.
  const diedLine = factory.needsHuman({
    task: "NH-V12",
    reason: "died-after-respawn",
    evidence: { spawn: spawnSeq, respawn: respawnSeq },
  });
  assert.equal(diedLine.reason, "died-after-respawn");
  assert.deepEqual(diedLine.evidence, { spawn: spawnSeq, respawn: respawnSeq });

  // Once a gate_finished lands after respawnSeq, that respawn is no longer an unprogressed death.
  const a1 = await factory.claim({ task: "NH-V12", sha });
  assert.throws(
    () => factory.needsHuman({ task: "NH-V12", reason: "died-after-respawn", evidence: { spawn: spawnSeq, respawn: respawnSeq } }),
    factoryErrorCode("invalid-needs-human"),
    "a gate_finished after respawn invalidates died-after-respawn for that earlier respawn",
  );

  // Attempt-ceiling requires attempt === 3 and a red gate_finished at attempt 3.
  assert.throws(
    () => factory.needsHuman({ task: "NH-V12", reason: "attempt-ceiling", evidence: { attempt: 1, gate: a1.gate.seq } }),
    factoryErrorCode("invalid-needs-human"),
  );
  assert.throws(
    () => factory.needsHuman({ task: "NH-V12", reason: "attempt-ceiling", evidence: { attempt: 3, gate: a1.gate.seq } }),
    factoryErrorCode("invalid-needs-human"),
    "a1's gate_finished is attempt 1, not 3",
  );

  await factory.claim({ task: "NH-V12", sha });
  const a3 = await factory.claim({ task: "NH-V12", sha });
  assert.equal(a3.attempt, 3);
  assert.equal(a3.verdict, "red");

  const ceilLine = factory.needsHuman({
    task: "NH-V12",
    reason: "attempt-ceiling",
    evidence: { attempt: 3, gate: a3.gate.seq },
  });
  assert.equal(ceilLine.reason, "attempt-ceiling");
  assert.deepEqual(ceilLine.evidence, { attempt: 3, gate: a3.gate.seq });
});





// ---- the Task worktree (v0.0.14, ADR 0010 §4/§5): spawn records it, claim and the choke bind to it ----

/** One git fact about a checkout, as a string — the worktree tests' `git rev-parse` shorthand. */
function gitFact(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A real linked worktree the way the driver's task-worktree.mjs allocates it — outside the project root, like `<stateDir>/projects/<slug>/worktrees/<task>`. */
function makeTaskWorktree(dir: string, workspace: string, task: string, base: string): string {
  const path = join(dir, "state", "worktrees", task);
  execFileSync("git", ["worktree", "add", "-b", `factory/${task}`, path, base], { cwd: workspace });
  return path;
}

test("spawn records the driver's worktree; worktreeFor reads it back, claim and the choke bind to it", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha: base } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  const worktree = makeTaskWorktree(dir, workspace, "WTA", base);
  factory.setContract({ task: "WTA", workspace, gate: "true", artifact });
  const spawn = factory.requestSpawn({ task: "WTA", provider: "claude", arity: 1, worktree });
  assert.equal(spawn.outcome, "dispatched");
  if (spawn.outcome === "dispatched") {
    assert.equal(spawn.event.worktree, worktree, "the driver-level execution detail rides the spawn line");
  }
  assert.equal(factory.worktreeFor("WTA"), worktree);

  // The choke's binding (liveContractFor): the worktree and its subdirs bind
  // to the task's contract — the worktree sits OUTSIDE <project-root>, so
  // this is the binding that keeps a worktree agent contracted.
  assert.equal(factory.liveContractFor(worktree)?.task, "WTA");
  assert.equal(factory.liveContractFor(join(worktree, "src"))?.task, "WTA");
  assert.equal(factory.liveContractFor(workspace)?.task, "WTA", "the project root still binds its own contract too");
  assert.equal(factory.worktreeFor("NOPE"), undefined);

  // The claim executes in the worktree: the gate's cwd, the clean checks, and
  // the diff all read the worktree, and <project-root> never moves.
  writeFileSync(join(worktree, artifact), "export function pad(input: string, width: number): string {\n  return input.padEnd(width).slice(0, width);\n}\n");
  const claimed = gitCommitChanges(worktree, "work in the worktree");
  const outcome = await factory.claim({ task: "WTA", sha: claimed });
  assert.equal(outcome.verdict, "green", "the gate ran against the worktree tree");
  assert.equal(gitFact(workspace, ["rev-parse", "HEAD"]), base, "the project root never moved");
  assert.equal(gitFact(workspace, ["status", "--porcelain"]), "", "the project root stayed clean");
  assert.equal(gitFact(worktree, ["rev-parse", "HEAD"]), claimed);

  // A spawn without a worktree (the legacy spelling) records no field, and
  // worktreeFor stays undefined — the claim falls back to the contract workspace.
  const dir2 = makeTempDir();
  disposeDir(t, dir2);
  const { workspace: ws2, artifact: artifact2, sha: base2 } = makeWorkspace(dir2);
  factory.setContract({ task: "WTB", workspace: ws2, gate: "true", artifact: artifact2 });
  const legacy = factory.requestSpawn({ task: "WTB", provider: "claude", arity: 1 });
  assert.equal(legacy.outcome, "dispatched");
  if (legacy.outcome === "dispatched") assert.equal("worktree" in legacy.event, false);
  assert.equal(factory.worktreeFor("WTB"), undefined);
  const legacyOutcome = await factory.claim({ task: "WTB", sha: base2 });
  assert.equal(legacyOutcome.verdict, "green", "no worktree — the claim runs at the contract workspace, v0.0.5's law");
});

test("acceptance retires the worktree binding too — the choke does not outlive the task", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha: base } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });
  const worktree = makeTaskWorktree(dir, workspace, "WTC", base);
  factory.setContract({ task: "WTC", workspace, gate: "true", artifact });
  factory.requestSpawn({ task: "WTC", provider: "claude", arity: 1, worktree });
  assert.equal(factory.liveContractFor(worktree)?.task, "WTC");
  factory.ledger.append({ event: "attempt_accepted", task: "WTC", attempt: 1 });
  assert.equal(factory.liveContractFor(worktree), undefined, "accepted — the worktree binds no live contract either");
});

// ---- same-Project parallel Tasks (v0.0.14, ADR 0010 §4): the worktree exemption of the H1/H2 guard ----

test("two Tasks of one Project contract and run concurrently when their scopes are disjoint", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // Same <project-root>, disjoint scope globs: both contracts land, both
  // spawns dispatch — each Task executes in its own worktree, so the
  // single-checkout collision the H1/H2 guard exists for cannot happen.
  factory.setContract({ task: "PP1", workspace, gate: "true", artifact, scope: ["src/"] });
  factory.setContract({ task: "PP2", workspace, gate: "true", artifact, scope: ["docs/"] });
  assert.equal(factory.requestSpawn({ task: "PP1", provider: "claude", arity: 1 }).outcome, "dispatched");
  assert.equal(factory.requestSpawn({ task: "PP2", provider: "claude", arity: 1 }).outcome, "dispatched");
});

test("the exemption is the declared boundary: overlapping scopes, an unscoped sibling, and nesting still refuse", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task: "PO1", workspace, gate: "true", artifact, scope: ["src"] });

  // Overlap: src/format.ts sits inside src — one boundary, two owners, refused.
  assert.throws(
    () => factory.setContract({ task: "PO2", workspace, gate: "true", artifact, scope: ["src/format.ts"] }),
    (err: unknown) => err instanceof FactoryError && err.code === "workspace-conflict" && /overlap/.test(err.message),
    "overlapping scopes refuse, naming the overlap",
  );
  // Unrestricted scope means "everywhere" — it overlaps everything, refused.
  assert.throws(
    () => factory.setContract({ task: "PO3", workspace, gate: "true", artifact }),
    factoryErrorCode("workspace-conflict"),
    "an unscoped sibling cannot declare disjointness",
  );
  // A scoped contract against an unscoped incumbent: same refusal, other side.
  const dir2 = makeTempDir();
  disposeDir(t, dir2);
  const { workspace: ws2, artifact: artifact2 } = makeWorkspace(dir2);
  const factory2 = createFactory({ stateDir: join(dir2, "state") });
  factory2.setContract({ task: "PO4", workspace: ws2, gate: "true", artifact: artifact2 });
  assert.throws(
    () => factory2.setContract({ task: "PO5", workspace: ws2, gate: "true", artifact: artifact2, scope: ["docs/"] }),
    factoryErrorCode("workspace-conflict"),
    "a scoped sibling of an unscoped incumbent refuses too",
  );
  // Nesting never rides the exemption — only the SAME tree does.
  const deep = join(workspace, "deep");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "x.ts"), "x\n");
  gitCommitChanges(workspace, "add deep dir");
  assert.throws(
    () => factory.setContract({ task: "PO6", workspace: deep, gate: "true", artifact, scope: ["deep/"] }),
    (err: unknown) => err instanceof FactoryError && err.code === "workspace-conflict" && /sits inside/.test(err.message),
  );
  // And the spawn-time arm carries the same exemption: two disjoint scoped
  // siblings of one tree both dispatch (the single-checkout collision the
  // arm exists for cannot happen when each runs in its own worktree).
  const factory3 = createFactory({ stateDir: join(dir2, "state3") });
  factory3.setContract({ task: "PO7", workspace: ws2, gate: "true", artifact: artifact2, scope: ["src"] });
  factory3.setContract({ task: "PO8", workspace: ws2, gate: "true", artifact: artifact2, scope: ["docs"] });
  assert.equal(factory3.requestSpawn({ task: "PO7", provider: "claude", arity: 1 }).outcome, "dispatched");
  assert.equal(factory3.requestSpawn({ task: "PO8", provider: "claude", arity: 1 }).outcome, "dispatched");
});

// ---- accept authority (v0.0.14, ADR 0010 §3): the Lead accepts green + CLEAR, never CONCERN or Needs-human ----

/** A green attempt on a fresh contract, the lead-rule tests' shared setup. */
async function greenAttempt(dir: string, task: string): Promise<{ factory: ReturnType<typeof createFactory>; workspace: string; artifact: string }> {
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task, workspace, gate: "true", artifact });
  writeFileSync(join(workspace, artifact), "export function pad(input: string, width: number): string {\n  return input.padEnd(width).slice(0, width);\n}\n");
  const sha = gitCommitChanges(workspace, `green ${task}`);
  const outcome = await factory.claim({ task, sha });
  assert.equal(outcome.verdict, "green");
  return { factory, workspace, artifact };
}

test("accept authority: the Lead accepts a green attempt with no fresh-eyes CONCERN", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { factory } = await greenAttempt(dir, "LA1");

  const accepted = await factory.accept({ task: "LA1", attempt: 1, accepted_by: "lead" });
  assert.equal(accepted.event, "attempt_accepted");
  assert.equal(accepted.accepted_by, "lead");
});

test("a fresh-eyes CONCERN on the attempt refuses the Lead — the Owner's and Supervisor's word still land", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { factory } = await greenAttempt(dir, "LA2");
  factory.ledger.append({ event: "fresh_eyes_written", task: "LA2", attempt: 1, model: "fake-eye", outcome: "concern", finding: "the fix does not match the contract", durationMs: 5 });

  await assert.rejects(
    factory.accept({ task: "LA2", attempt: 1, accepted_by: "lead" }),
    (err: unknown) => err instanceof FactoryError && err.code === "lead-accept-refused" && /CONCERN/.test(err.message),
    "the eye's concern is the Lead's hard stop",
  );
  // Nothing landed for the refused act.
  assert.equal(factory.ledger.eventsFor("LA2").some((e) => e.event === "attempt_accepted"), false);
  // The override seats are unconditional on the same evidence.
  const bySupervisor = await factory.accept({ task: "LA2", attempt: 1, accepted_by: "supervisor" });
  assert.equal(bySupervisor.accepted_by, "supervisor");

  // A CLEAR eye on the attempt does NOT refuse the Lead — and a CONCERN on a
  // DIFFERENT attempt is not this attempt's business.
  const dir2 = makeTempDir();
  disposeDir(t, dir2);
  const { factory: f2 } = await greenAttempt(dir2, "LA3");
  f2.ledger.append({ event: "fresh_eyes_written", task: "LA3", attempt: 1, model: "fake-eye", outcome: "clear", finding: "nothing to add", durationMs: 5 });
  assert.equal((await f2.accept({ task: "LA3", attempt: 1, accepted_by: "lead" })).accepted_by, "lead");
});

test("a task in needs_human refuses the Lead until activity displaces the marker", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { factory } = await greenAttempt(dir, "LA4");

  // The stall's named end after the green verdict: a denial that survived its poke.
  factory.repoke("LA4", "ag-1");
  const repoke = factory.ledger.eventsFor("LA4").findLast((e) => e.event === "repoke_dispatched");
  const denial = factory.ledger.append({ event: "permit_denied", task: "LA4", agent: "ag-1", name: "Bash", kind: "tool", command: "rm -rf /", rule: "policy:S2-outside-writable", reason: "r" });
  factory.needsHuman({ task: "LA4", reason: "denied-again", evidence: { denial: denial.seq, repoke: repoke?.seq ?? 0 } });

  await assert.rejects(
    factory.accept({ task: "LA4", attempt: 1, accepted_by: "lead" }),
    (err: unknown) => err instanceof FactoryError && err.code === "lead-accept-refused" && /needs_human/.test(err.message),
  );
  assert.equal(factory.ledger.eventsFor("LA4").some((e) => e.event === "attempt_accepted"), false);
  // The Owner's override stands over the escalation too.
  assert.equal((await factory.accept({ task: "LA4", attempt: 1, accepted_by: "owner" })).accepted_by, "owner");

  // Displacement: an Owner answer wakes the task, a new green attempt lands,
  // and the Lead may accept THAT attempt (ADR 0010 §3 — corrective work within the ceiling).
  const dir2 = makeTempDir();
  disposeDir(t, dir2);
  const { factory: f2, workspace } = await greenAttempt(dir2, "LA5");
  const denial2 = f2.ledger.append({ event: "permit_denied", task: "LA5", agent: "ag-1", name: "Bash", kind: "tool", command: "x", rule: "policy:S2-outside-writable", reason: "r" });
  const poke2 = f2.repoke("LA5", "ag-1");
  assert.equal(poke2.outcome, "dispatched");
  const repoke2 = f2.ledger.eventsFor("LA5").findLast((e) => e.event === "repoke_dispatched");
  f2.needsHuman({ task: "LA5", reason: "denied-again", evidence: { denial: denial2.seq, repoke: repoke2?.seq ?? 0 } });
  await assert.rejects(f2.accept({ task: "LA5", attempt: 1, accepted_by: "lead" }), factoryErrorCode("lead-accept-refused"));
  // Wake-up: new spawn, new attempt, green again — the marker is displaced.
  f2.requestSpawn({ task: "LA5", provider: "claude", arity: 1 });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad(input: string, width: number): string {\n  return input.padEnd(width, \"0\").slice(0, width);\n}\n");
  const sha2 = gitCommitChanges(workspace, "corrective work");
  const second = await f2.claim({ task: "LA5", sha: sha2 });
  assert.equal(second.verdict, "green");
  assert.equal((await f2.accept({ task: "LA5", attempt: second.attempt, accepted_by: "lead" })).accepted_by, "lead");
});

test("accepted_by stays the submitting shell's verbatim stamp outside the seat names (the v0.0.9 law)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { factory } = await greenAttempt(dir, "LA6");

  // A delegated agent's id is not one of the three seats — it records
  // verbatim, with no Lead privileges attached to an unnamed seat.
  const stamped = await factory.accept({ task: "LA6", attempt: 1, accepted_by: "agent-supervisor-1" });
  assert.equal(stamped.accepted_by, "agent-supervisor-1");
});

// ---- landing on Accept (v0.0.14, ADR 0010 §4): claimedCommit into <project-root>, worktree removed ----

test("landing: a green worktree attempt fast-forwards into <project-root>, the worktree goes, factory/<task> survives", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha: base } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const worktree = makeTaskWorktree(dir, workspace, "LW1", base);
  factory.setContract({ task: "LW1", workspace, gate: "true", artifact });
  factory.requestSpawn({ task: "LW1", provider: "claude", arity: 1, worktree });

  writeFileSync(join(worktree, artifact), "export function pad(input: string, width: number): string {\n  return input.padEnd(width).slice(0, width);\n}\n");
  const claimed = gitCommitChanges(worktree, "the verified work");
  const outcome = await factory.claim({ task: "LW1", sha: claimed });
  assert.equal(outcome.verdict, "green");

  const accepted = await factory.accept({ task: "LW1", attempt: 1, accepted_by: "lead" });
  assert.equal(accepted.landing, "landed");
  assert.equal(accepted.landingNote, undefined);
  assert.equal(gitFact(workspace, ["rev-parse", "HEAD"]), claimed, "the root's branch fast-forwarded to the verified commit");
  assert.equal(gitFact(workspace, ["status", "--porcelain"]), "", "landing left the root clean");
  assert.equal(existsSync(worktree), false, "the temporary worktree is removed");
  assert.equal(gitFact(workspace, ["rev-parse", "--verify", "factory/LW1"]), claimed, "branch factory/<task> survives the landing");
});

test("landing on a root that advanced: merge --no-ff brings the attempt's whole range in", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha: base } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const worktree = makeTaskWorktree(dir, workspace, "LW2", base);
  factory.setContract({ task: "LW2", workspace, gate: "true", artifact });
  factory.requestSpawn({ task: "LW2", provider: "claude", arity: 1, worktree });

  writeFileSync(join(worktree, artifact), "export function pad(input: string, width: number): string {\n  return input.padEnd(width).slice(0, width);\n}\n");
  const claimed = gitCommitChanges(worktree, "the verified work");
  // Meanwhile the project root advanced on its own.
  writeFileSync(join(workspace, "other.txt"), "root work\n");
  const rootMoved = gitCommitChanges(workspace, "the root advanced");
  assert.equal(await factory.claim({ task: "LW2", sha: claimed }).then((o) => o.verdict), "green");

  const accepted = await factory.accept({ task: "LW2", attempt: 1 });
  assert.equal(accepted.landing, "landed");
  assert.notEqual(gitFact(workspace, ["rev-parse", "HEAD"]), claimed, "a merge commit sits on top, not a fast-forward");
  assert.notEqual(gitFact(workspace, ["rev-parse", "HEAD"]), rootMoved);
  assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", claimed, "HEAD"], { cwd: workspace }).status, 0, "the verified range is in the root's history");
  assert.ok(existsSync(join(workspace, "other.txt")), "the root's own work is intact");
  assert.match(readFileSync(join(workspace, artifact), "utf8"), /padEnd/, "the attempt's work landed too");
  assert.equal(gitFact(workspace, ["status", "--porcelain"]), "");
  assert.equal(existsSync(worktree), false);
});

test("a dirty root lands pending-conflict: the acceptance records, the branch and the worktree survive", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha: base } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const worktree = makeTaskWorktree(dir, workspace, "LW3", base);
  factory.setContract({ task: "LW3", workspace, gate: "true", artifact });
  factory.requestSpawn({ task: "LW3", provider: "claude", arity: 1, worktree });

  writeFileSync(join(worktree, artifact), "export function pad(input: string, width: number): string {\n  return input.padEnd(width).slice(0, width);\n}\n");
  const claimed = gitCommitChanges(worktree, "the verified work");
  assert.equal((await factory.claim({ task: "LW3", sha: claimed })).verdict, "green");
  // The Owner has uncommitted edits at the root — landing must not touch them.
  writeFileSync(join(workspace, "dirt.txt"), "uncommitted\n");

  const accepted = await factory.accept({ task: "LW3", attempt: 1, accepted_by: "owner" });
  assert.equal(accepted.landing, "pending-conflict");
  assert.match(accepted.landingNote ?? "", /not clean/);
  assert.equal(gitFact(workspace, ["rev-parse", "HEAD"]), base, "the root never moved");
  assert.ok(readFileSync(join(workspace, "dirt.txt"), "utf8") === "uncommitted\n", "the dirty edit is untouched");
  assert.equal(existsSync(worktree), true, "the worktree survives a pending-conflict landing");
  assert.equal(gitFact(workspace, ["rev-parse", "--verify", "factory/LW3"]), claimed, "the verified work is never lost");
});

test("a merge conflict lands pending-conflict with the root left clean — the conflict is named, never lived in", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha: base } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const worktree = makeTaskWorktree(dir, workspace, "LW4", base);
  factory.setContract({ task: "LW4", workspace, gate: "true", artifact });
  factory.requestSpawn({ task: "LW4", provider: "claude", arity: 1, worktree });

  writeFileSync(join(worktree, artifact), "export const worktreeSide = 1;\n");
  const claimed = gitCommitChanges(worktree, "the verified work");
  // The root edits the SAME file differently and commits — a true merge conflict.
  writeFileSync(join(workspace, artifact), "export const rootSide = 2;\n");
  const rootMoved = gitCommitChanges(workspace, "the root advanced conflicting");
  assert.equal((await factory.claim({ task: "LW4", sha: claimed })).verdict, "green");

  const accepted = await factory.accept({ task: "LW4", attempt: 1 });
  assert.equal(accepted.landing, "pending-conflict");
  assert.match(accepted.landingNote ?? "", /conflict/i, "the reason names the conflict");
  assert.equal(gitFact(workspace, ["rev-parse", "HEAD"]), rootMoved, "the root stays at its own commit — the failed merge is aborted");
  assert.equal(gitFact(workspace, ["status", "--porcelain"]), "", "the root is left clean, not mid-merge");
  assert.equal(readFileSync(join(workspace, artifact), "utf8"), "export const rootSide = 2;\n", "the root's own edit is untouched");
  assert.equal(existsSync(worktree), true);
  assert.equal(gitFact(workspace, ["rev-parse", "--verify", "factory/LW4"]), claimed, "the verified work waits on its branch for the Lead to resolve");
});

test("two same-Project Tasks run their claims concurrently in sibling worktrees — no collision, root untouched", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, sha: base } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  const wtA = makeTaskWorktree(dir, workspace, "PR1", base);
  const wtB = makeTaskWorktree(dir, workspace, "PR2", base);
  factory.setContract({ task: "PR1", workspace, gate: "true", artifact: "src/format.ts", scope: ["src/one"] });
  factory.setContract({ task: "PR2", workspace, gate: "true", artifact: "src/format.ts", scope: ["src/two"] });
  for (const [task, wt] of [["PR1", wtA], ["PR2", wtB]] as const) {
    const spawn = factory.requestSpawn({ task, provider: "claude", arity: 1, worktree: wt });
    assert.equal(spawn.outcome, "dispatched", `${task} dispatched in its own worktree`);
  }
  // Both agents work in their own trees; the claims run interleaved.
  mkdirSync(join(wtA, "src", "one"), { recursive: true });
  writeFileSync(join(wtA, "src", "one", "a.ts"), "export const a = 1;\n");
  mkdirSync(join(wtB, "src", "two"), { recursive: true });
  writeFileSync(join(wtB, "src", "two", "b.ts"), "export const b = 2;\n");
  const shaA = gitCommitChanges(wtA, "task one");
  const shaB = gitCommitChanges(wtB, "task two");
  const [first, second] = await Promise.all([factory.claim({ task: "PR1", sha: shaA }), factory.claim({ task: "PR2", sha: shaB })]);
  assert.equal(first.verdict, "green");
  assert.equal(second.verdict, "green");
  assert.equal(gitFact(workspace, ["rev-parse", "HEAD"]), base, "the root sat at base through both runs");
  assert.equal(gitFact(workspace, ["status", "--porcelain"]), "");
  // And both land independently: accept PR1, its work shows in the root; PR2's branch waits untouched.
  const accepted = await factory.accept({ task: "PR1", attempt: 1, accepted_by: "lead" });
  assert.equal(accepted.landing, "landed");
  assert.ok(existsSync(join(workspace, "src", "one", "a.ts")), "PR1's verified work is in the root");
  assert.equal(gitFact(workspace, ["rev-parse", "--verify", "factory/PR2"]), shaB, "PR2's verified work waits on its branch");
});

test("re-contracting an unaccepted task after MAX_ATTEMPTS and needs_human opens a fresh Contract epoch, resetting attempts and needs_human while preserving prior ledger events (v0.0.24)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // Epoch 1: contract T-01 with a failing gate, spawn, exhaust 3 attempts, and record needs_human.
  const c1 = factory.setContract({ task: "T-01", workspace, gate: "false", artifact });
  const sp1 = factory.requestSpawn({ task: "T-01", provider: "opencode/nemotron", arity: 1 });
  assert.equal(sp1.outcome, "dispatched");
  const a1 = await factory.claim({ task: "T-01", sha });
  const a2 = await factory.claim({ task: "T-01", sha });
  const a3 = await factory.claim({ task: "T-01", sha });
  assert.equal(a1.attempt, 1);
  assert.equal(a2.attempt, 2);
  assert.equal(a3.attempt, 3);
  assert.equal(a3.verdict, "red");
  factory.needsHuman({ task: "T-01", reason: "attempt-ceiling", evidence: { attempt: 3, gate: a3.gate.seq } });

  assert.equal(factory.attemptsOf("T-01").length, 3);
  assert.equal(factory.isNeedsHuman("T-01"), true);
  assert.equal(factory.activeSpawnOf("T-01")?.seq, sp1.event.seq);
  assert.equal(factory.lastProgressSeq("T-01"), a3.gate.seq);

  const epoch1EventCount = factory.ledger.eventsFor("T-01").length;
  const epoch1Seqs = factory.ledger.eventsFor("T-01").map((e) => e.seq);

  // Epoch 2: re-contract T-01 with a passing gate.
  const c2 = factory.setContract({ task: "T-01", workspace, gate: "true", artifact, description: "Fresh wave" });
  assert.ok(c2.seq > c1.seq);
  assert.equal(factory.contractFor("T-01")?.seq, c2.seq);
  assert.equal(factory.contractFor("T-01")?.gate, "true");
  assert.deepEqual(factory.attemptsOf("T-01"), []);
  assert.equal(factory.isNeedsHuman("T-01"), false);
  assert.equal(factory.activeSpawnOf("T-01"), undefined);
  assert.equal(factory.lastProgressSeq("T-01"), 0);

  // Spawn and claim in the new epoch start fresh at attempt 1, and Lead can accept.
  const sp2 = factory.requestSpawn({ task: "T-01", provider: "opencode/nemotron", arity: 1 });
  assert.equal(sp2.outcome, "dispatched");
  assert.equal(factory.activeSpawnOf("T-01")?.seq, sp2.event.seq);
  assert.equal(factory.lastProgressSeq("T-01"), sp2.event.seq);

  const epoch2Attempt1 = await factory.claim({ task: "T-01", sha });
  assert.equal(epoch2Attempt1.attempt, 1);
  assert.equal(epoch2Attempt1.verdict, "green");
  assert.equal(factory.attemptsOf("T-01").length, 1);
  assert.equal(factory.attemptsOf("T-01")[0]?.attempt, 1);
  assert.equal(factory.attemptsOf("T-01")[0]?.verdict, "green");

  const report = readFileSync(epoch2Attempt1.reportPath, "utf8");
  assert.ok(report.includes("- Attempt: 1 of 1"), "report in epoch 2 counts only epoch 2's attempts");
  assert.ok(report.includes("- Contract: `true` green"), "report in epoch 2 uses epoch 2's contract");

  const accepted = await factory.accept({ task: "T-01", attempt: 1, accepted_by: "lead" });
  assert.equal(accepted.event, "attempt_accepted");
  assert.equal(accepted.attempt, 1);

  // All historical events from epoch 1 remain untouched in the append-only ledger.
  const allForTask = factory.ledger.eventsFor("T-01");
  assert.deepEqual(allForTask.slice(0, epoch1EventCount).map((e) => e.seq), epoch1Seqs);
});
