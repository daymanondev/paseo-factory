import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { ensureProjectRegistered, resolveProject, writeProjectRegistration } from "../src/project.ts";
import {
  projectLedgerPath,
  projectLedgerStreams,
  readProjectLedgerEvents,
  resolveProjectLedger,
} from "../src/ledger-project.ts";

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-project-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "factory@example.com"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

interface ProjectFixture {
  slug: string;
  root: string;
  ledgerPath: string;
}

/** One registered Project with one contracted Task — the v0.0.89 on-disk shape. */
function makeProject(stateDir: string, task: string): ProjectFixture {
  const root = makeGitRepo();
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  assert.ok(ensureProjectRegistered(stateDir, root).ok);
  const factory = createFactory({ stateDir, projectSlug: resolved.slug });
  factory.setContract({ task, workspace: root, gate: "true", artifact: "README.md" });
  return { slug: resolved.slug, root, ledgerPath: join(stateDir, "projects", resolved.slug, "ledger.jsonl") };
}

test("resolveProjectLedger resolves the explicit slug, its workspace, a unique Task, and the single-Project fallback — root only when no per-Project ledger exists", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-project-resolve-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  // Zero registered Projects: the legacy root ledger is the only stream.
  const rootResolved = resolveProjectLedger(stateDir, {});
  assert.equal(rootResolved.mode, "root");
  assert.equal(rootResolved.path, join(stateDir, "ledger.jsonl"));

  // One registered Project with a contracted Task — no root ledger anywhere.
  const project = makeProject(stateDir, "T-01");
  const { slug, root: repo } = project;
  assert.ok(existsSync(join(stateDir, "projects", slug!, "ledger.jsonl")), "the ledger lives under projects/<slug>/");
  assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false, "no root ledger exists");

  // 1. explicit slug
  assert.deepEqual(resolveProjectLedger(stateDir, { project: slug }), { mode: "project", slug, path: join(stateDir, "projects", slug, "ledger.jsonl"), via: "explicit" });
  // 2. workspace (the project root itself)
  assert.deepEqual(resolveProjectLedger(stateDir, { workspace: repo }), { mode: "project", slug, path: join(stateDir, "projects", slug, "ledger.jsonl"), via: "workspace" });
  // 2b. a managed Task worktree path names its Project directly
  const worktree = join(stateDir, "projects", slug, "worktrees", "T-01");
  assert.deepEqual(resolveProjectLedger(stateDir, { workspace: worktree }), { mode: "project", slug, path: join(stateDir, "projects", slug, "ledger.jsonl"), via: "workspace" });
  // 3. unique Task id
  assert.deepEqual(resolveProjectLedger(stateDir, { task: "T-01" }), { mode: "project", slug, path: join(stateDir, "projects", slug, "ledger.jsonl"), via: "task" });
  // 4. single-registered-Project fallback (no context at all)
  assert.deepEqual(resolveProjectLedger(stateDir, {}), { mode: "project", slug, path: join(stateDir, "projects", slug, "ledger.jsonl"), via: "single" });
  // 5. an unregistered explicit slug is never guessed — falls through to the arms below
  assert.equal(resolveProjectLedger(stateDir, { project: "ghost-slug" }).mode, "project");

  // The scoped read carries the Project's events even though the root ledger is absent.
  const read = readProjectLedgerEvents(stateDir, { task: "T-01" });
  assert.ok(read.events.some((e) => e.event === "contract_set" && e.task === "T-01"));

  rmSync(repo, { recursive: true, force: true });
});

test("readProjectLedgerEvents resolves across two Projects by Task and workspace, never guessing an ambiguous Task", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-project-multi-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const alpha = makeProject(stateDir, "A-01");
  const beta = makeProject(stateDir, "B-01");
  assert.notEqual(alpha.slug, beta.slug);

  const streams = projectLedgerStreams(stateDir);
  assert.deepEqual(new Set(streams.map((stream) => stream.slug)), new Set([alpha.slug, beta.slug]));
  assert.ok(streams.every((stream) => stream.path === projectLedgerPath(stateDir, stream.slug)));

  // unique Task lookup
  const projectSlugOf = (context: Parameters<typeof resolveProjectLedger>[1]): string => {
    const resolved = resolveProjectLedger(stateDir, context);
    assert.equal(resolved.mode, "project", JSON.stringify(resolved));
    return resolved.slug;
  };
  assert.equal(projectSlugOf({ task: "A-01" }), alpha.slug);
  assert.equal(projectSlugOf({ task: "B-01" }), beta.slug);
  // workspace beats Task when both name different Projects
  assert.equal(projectSlugOf({ task: "A-01", workspace: beta.root }), beta.slug);

  // The SAME Task id in both Projects is ambiguous — no guess, and no silent
  // cross-Project stream: with two registered Projects the reader falls to the
  // legacy root path (absent on a migrated machine, so an empty read).
  const betaFactory = createFactory({ stateDir, projectSlug: beta.slug });
  betaFactory.setContract({ task: "A-01", workspace: beta.root, gate: "true", artifact: "README.md" });
  const ambiguous = resolveProjectLedger(stateDir, { task: "A-01" });
  assert.equal(ambiguous.mode, "root");
});

test("readProjectLedgerEvents throws on a corrupt per-Project ledger instead of silently falling back to root", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-project-corrupt-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const repo = makeGitRepo();
  const resolved = resolveProject(repo);
  assert.ok(resolved.ok);
  ensureProjectRegistered(stateDir, repo);
  const factory = createFactory({ stateDir, projectSlug: resolved.slug });
  factory.setContract({ task: "T-01", workspace: repo, gate: "true", artifact: "README.md" });
  const slug = resolved.slug;

  const ledgerPath = join(stateDir, "projects", slug, "ledger.jsonl");
  writeFileSync(ledgerPath, "not json at all\n");
  assert.throws(() => readProjectLedgerEvents(stateDir, { project: slug }), /is not a readable ledger/);

  rmSync(repo, { recursive: true, force: true });
});

test("an unregistered workspace never binds — the git-root arm only answers for registered Projects", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-project-unregistered-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const stranger = makeGitRepo();
  const other = makeGitRepo();
  // Two registered Projects (so the single-Project fallback cannot fire), but
  // neither registration names the stranger repo's canonical slug — the
  // workspace arm must not bind it to either.
  writeProjectRegistration(stateDir, "alpha-proj-111111", { root: other });
  writeProjectRegistration(stateDir, "beta-proj-222222", { root: `${other}-beta` });
  const resolved = resolveProjectLedger(stateDir, { workspace: stranger, task: "T-99" });
  assert.equal(resolved.mode, "root");
  rmSync(stranger, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});
