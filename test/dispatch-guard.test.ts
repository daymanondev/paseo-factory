import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { resolveProject } from "../plugin/bin/project.mjs";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * Ticket 03 of factory-cli-project-onboarding: the dispatch guard. External
 * behavior only — the real CLI as a subprocess against a fake daemon home;
 * where a plugin reply matters, a spool handler stands in for the plugin.
 */

const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: the in-test spool poll lives in this process's event loop. */
function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.PASEO_HOME;
    delete env.PASEO_AGENT_ID;
    delete env.PASEO_FACTORY_SEAT;
    Object.assign(env, opts.env);
    const child = spawn(process.execPath, [ownerCli, ...args], { cwd: opts.cwd, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

function fakeHome(t: Parameters<typeof disposeDir>[0]): { dir: string; home: string; stateDir: string } {
  const dir = realpathSync(makeTempDir("paseo-factory-guard-"));
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  mkdirSync(home, { recursive: true });
  return { dir, home, stateDir: join(home, "plugin-state", "paseo-factory") };
}

function gitRepo(dir: string, name: string): { root: string; slug: string } {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  return { root: resolved.root, slug: resolved.slug };
}

/** Seeds a registration the way the plugin's single writer leaves it. */
function seedRegistration(stateDir: string, slug: string, root: string): void {
  const projectDir = join(stateDir, "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "project.json"), `${JSON.stringify({ slug, root }, null, 2)}\n`);
}

/** Every file under `dir`, relative — the "no side effects" probe. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

/** A spool that records supervisor_dispatch requests and replies the way a no-live-Supervisor plugin does. */
function startRecordingSpool(t: Parameters<typeof disposeDir>[0], stateDir: string) {
  const dispatched: Record<string, unknown>[] = [];
  const spool = startSpool(stateDir, createFactory({ stateDir }), {
    pollMs: 20,
    supervisorDispatch: async (request) => {
      dispatched.push({ ...request });
      return { id: request.id, ok: true, summary: "directive held for Supervisor — none is live", project: "x", mailId: "mail-1" };
    },
  });
  t.after(() => spool.stop());
  return dispatched;
}

test("dispatch to an unregistered git workspace is refused (exit 2) with the exact next commands and the seat-opening step, and nothing is written", async (t) => {
  const { dir, home } = fakeHome(t);
  const repo = gitRepo(dir, "fresh-repo");
  const r = await run(["--home", home, "supervisor", "dispatch", "--workspace", repo.root, "--message", "Build 2048", "--wait-secs", "2"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.includes(`project register --workspace "${repo.root}"`), r.stderr);
  assert.match(r.stderr, /project list/);
  assert.ok(r.stderr.includes(home), "the refusal names the home it checked");
  assert.ok(r.stderr.includes(repo.slug), "the refusal names the slug");
  assert.match(r.stderr, /New Chat/);
  assert.match(r.stderr, /`Supervisor \(Factory\)`/);
  assert.ok(r.stderr.includes("--allow-unregistered"), "the refusal names the opt-in flag");
  assert.deepEqual(filesUnder(home), [], "no spool request, mailbox, or registration was written");
});

test("the refusal resolves a subdirectory up to the git root", async (t) => {
  const { dir, home } = fakeHome(t);
  const repo = gitRepo(dir, "mono");
  const sub = join(repo.root, "packages", "foo");
  mkdirSync(sub, { recursive: true });
  const r = await run(["--home", home, "supervisor", "dispatch", "--workspace", sub, "--message", "x", "--wait-secs", "1"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(`project register --workspace "${repo.root}"`), r.stderr);
});

test("the copy-pasteable commands carry --home only when the Owner passed it", async (t) => {
  const { dir, home } = fakeHome(t);
  const repo = gitRepo(dir, "homeless");
  const withFlag = await run(["--home", home, "supervisor", "dispatch", "--workspace", repo.root, "--message", "x", "--wait-secs", "1"]);
  assert.ok(withFlag.stderr.includes(`factory --home "${home}" project register --workspace "${repo.root}"`), withFlag.stderr);
  assert.ok(withFlag.stderr.includes(`factory --home "${home}" project list`), withFlag.stderr);
  const viaEnv = await run(["supervisor", "dispatch", "--workspace", repo.root, "--message", "x", "--wait-secs", "1"], { env: { PASEO_HOME: home } });
  assert.equal(viaEnv.status, 2);
  assert.ok(viaEnv.stderr.includes(`factory project register --workspace "${repo.root}"`), viaEnv.stderr);
  assert.ok(!viaEnv.stderr.includes("--home"), "no --home when the home came from PASEO_HOME");
});

test("--allow-unregistered restores the legacy held dispatch: the request reaches the plugin", async (t) => {
  const { dir, home, stateDir } = fakeHome(t);
  const repo = gitRepo(dir, "legacy-repo");
  const dispatched = startRecordingSpool(t, stateDir);
  const r = await run(["--home", home, "supervisor", "dispatch", "--workspace", repo.root, "--message", "Dispatch first", "--allow-unregistered", "--wait-secs", "10"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /directive held for Supervisor/);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.kind, "supervisor_dispatch");
  assert.equal(dispatched[0]?.workspace, repo.root);
  assert.equal(dispatched[0]?.message, "Dispatch first");
  assert.equal("allowUnregistered" in (dispatched[0] ?? {}), false, "the opt-in is CLI-local; the wire shape is unchanged");
});

test("dispatch to a registered Project is unchanged: no guard output, the request reaches the plugin", async (t) => {
  const { dir, home, stateDir } = fakeHome(t);
  const repo = gitRepo(dir, "known-repo");
  seedRegistration(stateDir, repo.slug, repo.root);
  const dispatched = startRecordingSpool(t, stateDir);
  const r = await run(["--home", home, "supervisor", "dispatch", "--workspace", repo.root, "--message", "Ship it", "--wait-secs", "10"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.workspace, repo.root);
  // A subdirectory of a registered Project routes the same way.
  const sub = join(repo.root, "src");
  mkdirSync(sub, { recursive: true });
  const fromSub = await run(["--home", home, "supervisor", "dispatch", "--workspace", sub, "--message", "From sub", "--wait-secs", "10"]);
  assert.equal(fromSub.status, 0, fromSub.stderr);
  assert.equal(dispatched.length, 2);
});

test("a non-git workspace keeps the unknown-project shape and now names the next commands", async (t) => {
  const { dir, home } = fakeHome(t);
  const plain = join(dir, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  for (const extra of [[], ["--allow-unregistered"]]) {
    const r = await run(["--home", home, "supervisor", "dispatch", "--workspace", plain, "--message", "x", "--wait-secs", "2", ...extra]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^factory: unknown-project: /);
    assert.ok(r.stderr.includes(plain));
    assert.ok(r.stderr.includes(`project register --workspace "${plain}"`), r.stderr);
    assert.match(r.stderr, /project list/);
  }
  assert.deepEqual(filesUnder(home), [], "nothing was written for a non-git workspace either");
});

test("a Supervisor seat is never guarded: its dispatch (to Lead) reaches the plugin even from an unregistered-looking workspace", async (t) => {
  const { dir, home, stateDir } = fakeHome(t);
  const repo = gitRepo(dir, "seat-repo");
  const dispatched = startRecordingSpool(t, stateDir);
  const r = await run(
    ["--home", home, "supervisor", "dispatch", "--workspace", repo.root, "--message", "Wave 1", "--wait-secs", "10"],
    { env: { PASEO_FACTORY_SEAT: "supervisor", PASEO_AGENT_ID: "agent-sup-1" } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.seat, "supervisor");
});

test("--project dispatch and supervisor report are unaffected by the guard", async (t) => {
  const { home } = fakeHome(t);
  const r = await run(["--home", home, "supervisor", "dispatch", "--project", "ghost-slug", "--message", "x", "--wait-secs", "1"]);
  // No plugin runs here: the request is submitted (not refused locally) and times out.
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No reply from the factory plugin/);
});
