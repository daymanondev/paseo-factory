import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "../plugin/bin/project.mjs";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * Ticket 01 of factory-cli-project-onboarding: the local read verbs
 * `factory project list` and `factory doctor`. External behavior only — the
 * real CLI as a subprocess against a fake daemon home, never the plugin.
 */

const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): CliResult {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  delete env.PASEO_HOME;
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_FACTORY_SEAT;
  Object.assign(env, opts.env);
  const r = spawnSync(process.execPath, [ownerCli, ...args], { cwd: opts.cwd, env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fakeHome(t: Parameters<typeof disposeDir>[0]): { home: string; stateDir: string } {
  const home = realpathSync(makeTempDir("paseo-factory-home-"));
  disposeDir(t, home);
  return { home, stateDir: join(home, "plugin-state", "paseo-factory") };
}

/** Seeds a registration the way the plugin's single writer leaves it. */
function seedRegistration(stateDir: string, slug: string, registration: unknown): void {
  const dir = join(stateDir, "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), `${JSON.stringify(registration, null, 2)}\n`);
}

test("project list: a home with zero registrations prints a friendly empty state naming the home and exits 0", (t) => {
  const { home } = fakeHome(t);
  const r = cli(["--home", home, "project", "list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no registered Projects/i);
  assert.ok(r.stdout.includes(home), "the empty state names the home it looked in");
  assert.match(r.stdout, /project register --workspace/, "names the next command");
});

test("project list --json: an empty home prints the machine-readable empty shape", (t) => {
  const { home } = fakeHome(t);
  const r = cli(["--home", home, "project", "list", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { home, projects: [] });
});

test("project list: seeded registrations print slug + root + home, human and --json, with no plugin running", (t) => {
  const { home, stateDir } = fakeHome(t);
  seedRegistration(stateDir, "beta-222222", { root: "/work/beta", slug: "beta-222222", supervisor: "agent-1" });
  seedRegistration(stateDir, "alpha-111111", { root: "/work/alpha" });

  const human = cli(["--home", home, "project", "list"]);
  assert.equal(human.status, 0, human.stderr);
  const lines = human.stdout.split("\n").filter((line) => line.includes("-111111") || line.includes("-222222"));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("alpha-111111") && lines[0].includes("/work/alpha") && lines[0].includes(home), "slug order; slug, root and home on the row");
  assert.ok(lines[1].includes("beta-222222") && lines[1].includes("/work/beta") && lines[1].includes(home));

  const json = cli(["--home", home, "project", "list", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    home,
    projects: [
      { slug: "alpha-111111", root: "/work/alpha", home },
      { slug: "beta-222222", root: "/work/beta", home },
    ],
  });
});

test("project list: only a well-formed registration counts", (t) => {
  const { home, stateDir } = fakeHome(t);
  seedRegistration(stateDir, "good-aaaaaa", { root: "/work/good" });
  seedRegistration(stateDir, "noroot-bbbbbb", { slug: "noroot-bbbbbb" });
  seedRegistration(stateDir, "emptyroot-cccccc", { root: "" });
  seedRegistration(stateDir, "array-dddddd", []);
  mkdirSync(join(stateDir, "projects", "corrupt-eeeeee"), { recursive: true });
  writeFileSync(join(stateDir, "projects", "corrupt-eeeeee", "project.json"), "{not json");
  mkdirSync(join(stateDir, "projects", "bare-ffffff"), { recursive: true }); // ledger-only dir, no project.json

  const r = cli(["--home", home, "project", "list", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).projects.map((p: { slug: string }) => p.slug), ["good-aaaaaa"]);
});

test("project list: home precedence is --home > $PASEO_HOME > ~/.paseo, and the home is named", (t) => {
  const flagHome = fakeHome(t);
  const envHome = fakeHome(t);
  const userHome = realpathSync(makeTempDir("paseo-factory-userhome-"));
  disposeDir(t, userHome);
  seedRegistration(flagHome.stateDir, "flag-aaaaaa", { root: "/work/flag" });
  seedRegistration(envHome.stateDir, "env-bbbbbb", { root: "/work/env" });
  seedRegistration(join(userHome, ".paseo", "plugin-state", "paseo-factory"), "default-cccccc", { root: "/work/default" });

  const slugs = (r: CliResult): string[] => JSON.parse(r.stdout).projects.map((p: { slug: string }) => p.slug);
  const viaFlag = cli(["--home", flagHome.home, "project", "list", "--json"], { env: { PASEO_HOME: envHome.home, HOME: userHome } });
  assert.deepEqual(slugs(viaFlag), ["flag-aaaaaa"]);
  const viaEnv = cli(["project", "list", "--json"], { env: { PASEO_HOME: envHome.home, HOME: userHome } });
  assert.deepEqual(slugs(viaEnv), ["env-bbbbbb"]);
  const viaDefault = cli(["project", "list", "--json"], { env: { HOME: userHome } });
  assert.deepEqual(slugs(viaDefault), ["default-cccccc"]);
  assert.equal(JSON.parse(viaDefault.stdout).home, join(userHome, ".paseo"));
});

test("project list: an unknown flag fails closed with exit 2 instead of prompting", (t) => {
  const { home } = fakeHome(t);
  const r = cli(["--home", home, "project", "list", "--bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bogus/);
});

/** Makes `dir` a git repo with one commit and returns its canonical Project slug. */
function gitProject(t: Parameters<typeof disposeDir>[0], name: string): { root: string; slug: string } {
  const parent = realpathSync(makeTempDir("paseo-factory-ws-"));
  disposeDir(t, parent);
  const root = join(parent, name);
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "hi\n");
  gitCommitAll(root);
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  return { root: resolved.root, slug: resolved.slug };
}

test("doctor: in a registered Project reports the CLI door, home, slug and registration", (t) => {
  const { home, stateDir } = fakeHome(t);
  const project = gitProject(t, "reg-proj");
  seedRegistration(stateDir, project.slug, { root: project.root });

  const r = cli(["--home", home, "doctor"], { cwd: project.root });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(ownerCli), "the CLI door path is named");
  assert.ok(r.stdout.includes(home), "the home in use is named");
  assert.ok(r.stdout.includes(project.slug), "the cwd's slug is named");
  assert.match(r.stdout, /registered:\s+yes/i);

  const json = JSON.parse(cli(["--home", home, "doctor", "--json"], { cwd: project.root }).stdout);
  assert.equal(json.home, home);
  assert.equal(json.homeSource, "--home");
  assert.deepEqual(json.cli, { path: ownerCli, exists: true });
  assert.equal(json.workspace.root, project.root);
  assert.equal(json.workspace.slug, project.slug);
  assert.equal(json.registered, true);
});

test("doctor: from a subdirectory the cwd resolves up to the git root", (t) => {
  const { home, stateDir } = fakeHome(t);
  const project = gitProject(t, "sub-proj");
  seedRegistration(stateDir, project.slug, { root: project.root });
  const sub = join(project.root, "packages", "foo");
  mkdirSync(sub, { recursive: true });

  const json = JSON.parse(cli(["--home", home, "doctor", "--json"], { cwd: sub }).stdout);
  assert.equal(json.workspace.root, project.root);
  assert.equal(json.registered, true);
});

test("doctor: in an unregistered git repo reports unregistered with a copy-pasteable next command naming the home", (t) => {
  const { home } = fakeHome(t);
  const project = gitProject(t, "unreg-proj");

  const r = cli(["--home", home, "doctor"], { cwd: project.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /registered:\s+no/i);
  assert.ok(r.stdout.includes(`--home "${home}" project register --workspace "${project.root}"`), r.stdout);

  const json = JSON.parse(cli(["--home", home, "doctor", "--json"], { cwd: project.root }).stdout);
  assert.equal(json.registered, false);
  assert.ok(json.next.includes("project register"));
});

test("doctor: in a non-git folder reports that the cwd resolves to no Project", (t) => {
  const { home } = fakeHome(t);
  const bare = realpathSync(makeTempDir("paseo-factory-bare-"));
  disposeDir(t, bare);

  const r = cli(["--home", home, "doctor"], { cwd: bare });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /resolves to no Project/i);

  const json = JSON.parse(cli(["--home", home, "doctor", "--json"], { cwd: bare }).stdout);
  assert.equal(json.workspace.resolved, false);
  assert.equal(json.registered, false);
});

test("doctor: a stale CLI door (pointed at a non-existent install) is detected and named", (t) => {
  const { home } = fakeHome(t);
  const gone = join(home, "plugins", "paseo-factory", "dead-uuid", "checkout", "plugin");
  writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { "paseo-factory": { source: "directory", path: gone } } }));

  const r = cli(["--home", home, "doctor"]);
  assert.equal(r.status, 2, "a stale install is a failing diagnosis");
  assert.match(r.stdout, /stale/i);
  assert.ok(r.stdout.includes(gone), "names the missing install path");
  assert.match(r.stdout, /paseo plugin update paseo-factory/, "names the repair command");

  const json = JSON.parse(cli(["--home", home, "doctor", "--json"]).stdout);
  assert.deepEqual(json.install, { path: gone, exists: false });
  assert.equal(json.ok, false);
});

test("doctor --door: a CLI path baked into a skill that no longer exists is reported stale", (t) => {
  const { home } = fakeHome(t);
  const dead = join(home, "plugins", "gone-uuid", "bin", "factory.mjs");
  const r = cli(["--home", home, "doctor", "--door", dead, "--json"]);
  assert.equal(r.status, 2);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.cli, { path: dead, exists: false });
  assert.equal(json.ok, false);
});

test("doctor: home precedence is --home > $PASEO_HOME > ~/.paseo and the source is named", (t) => {
  const envHome = fakeHome(t);
  const userHome = realpathSync(makeTempDir("paseo-factory-userhome-"));
  disposeDir(t, userHome);
  const flagHome = fakeHome(t);

  const viaFlag = JSON.parse(cli(["--home", flagHome.home, "doctor", "--json"], { env: { PASEO_HOME: envHome.home, HOME: userHome } }).stdout);
  assert.deepEqual([viaFlag.home, viaFlag.homeSource], [flagHome.home, "--home"]);
  const viaEnv = JSON.parse(cli(["doctor", "--json"], { env: { PASEO_HOME: envHome.home, HOME: userHome } }).stdout);
  assert.deepEqual([viaEnv.home, viaEnv.homeSource], [envHome.home, "PASEO_HOME"]);
  const viaDefault = JSON.parse(cli(["doctor", "--json"], { env: { HOME: userHome } }).stdout);
  assert.deepEqual([viaDefault.home, viaDefault.homeSource], [join(userHome, ".paseo"), "default"]);
});

test("doctor: --workspace targets another folder; a bogus flag fails closed with exit 2", (t) => {
  const { home } = fakeHome(t);
  const project = gitProject(t, "ws-proj");
  const json = JSON.parse(cli(["--home", home, "doctor", "--workspace", project.root, "--json"]).stdout);
  assert.equal(json.workspace.root, project.root);
  assert.equal(cli(["--home", home, "doctor", "--bogus"]).status, 2);
});
