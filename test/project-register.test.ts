import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createFactoryRegistry, listProjectRegistrations, readProjectRegistration, resolveProject, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SpoolReply } from "../plugin/server/spool.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * Ticket 02 of the CLI Project onboarding spec: `factory project register`.
 * Two seams, external behaviour only —
 *  1. the spool handler seam: a dropped `project_register` request against the
 *     real surface handlers (the registration writer the seat/surface path
 *     uses), asserting the files the plugin writes and the reply shape;
 *  2. the CLI subprocess seam: the real `factory.mjs` against that spool.
 */

const POLL_MS = 20;
const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");

// ---- fixtures ------------------------------------------------------------------------------

function makeRegisterSpool(t: TestContext, hooks: {
  projectDelete?: (request: { id: string; project?: string; workspace?: string }) => Promise<SpoolReply>;
  projectReset?: (request: { id: string; project?: string; workspace?: string }) => Promise<SpoolReply>;
} = {}) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());
  const opened: string[] = [];
  const surface = createSurfaceHandlers({
    factory: registry.root,
    registry,
    stateDir,
    home,
    daemon: {
      workspaces: {
        open: async ({ cwd }: { cwd: string }) => {
          opened.push(cwd);
          return { id: `ws-${opened.length}`, projectId: `proj-${opened.length}` };
        },
      },
    } as never,
  });
  const events: string[] = [];
  const spool = startSpool(stateDir, registry.root, {
    pollMs: POLL_MS,
    registry,
    projectRegister: async (request) => {
      events.push("register:start");
      const reply = await surface.projectRegister({ workspace: request.workspace }, { ...(request.seat === undefined ? {} : { seat: request.seat }) });
      events.push("register:end");
      return reply.ok
        ? {
            id: request.id,
            ok: true as const,
            summary: reply.summary,
            project: reply.slug,
            projectRoot: reply.root,
            bootstrapped: reply.bootstrapped,
            alreadyRegistered: reply.alreadyRegistered,
          }
        : { id: request.id, ok: false as const, code: reply.code, message: reply.error };
    },
    ...(hooks.projectDelete === undefined ? {} : { projectDelete: (request) => hooks.projectDelete!(request) }),
    ...(hooks.projectReset === undefined ? {} : { projectReset: (request) => hooks.projectReset!(request) }),
  });
  t.after(() => spool.stop());
  return { dir, home, stateDir, registry, surface, spool, opened, events };
}

function dropRequest(spoolRoot: string, body: Record<string, unknown> & { id: string }): void {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${body.id}.json`);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(body)}\n`);
  renameSync(`${path}.tmp`, path);
}

async function until(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

async function replyOf(spoolRoot: string, id: string): Promise<Record<string, unknown>> {
  const path = join(spoolRoot, "replies", `${id}.json`);
  await until(() => assert.ok(existsSync(path), `reply ${id} landed`));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function makeRepo(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n");
  gitCommitAll(root);
  return realpathSync(root);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// ---- Seam 1: the spool handler ---------------------------------------------------------------

test("parseSpoolRequest admits the project_register shape — a workspace is required, nothing around it", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "project_register", workspace: "/tmp/x", submitter: "owner" }), {
    id: "r1",
    kind: "project_register",
    workspace: "/tmp/x",
    submitter: "owner",
  });
  assert.equal(parseSpoolRequest({ id: "r2", kind: "project_register" }), undefined, "no workspace");
  assert.equal(parseSpoolRequest({ id: "r3", kind: "project_register", workspace: "  " }), undefined, "blank workspace");
  assert.equal(parseSpoolRequest({ id: "r4", kind: "project_register", workspace: 7 }), undefined, "non-string workspace");
});

test("project_register without a wired handler is refused by name, never a silent pass", async (t) => {
  const { registry } = makeRegisterSpool(t);
  const reply = await handleSpoolRequest(registry.root, { id: "r0", kind: "project_register", workspace: "/tmp/x" });
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.code, "project-register-unavailable");
});

test("registering a git repository writes exactly one registration — slug, root and name — and replies with them", async (t) => {
  const { dir, stateDir } = makeRegisterSpool(t);
  const root = makeRepo(dir, "demo");
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);

  dropRequest(spoolRootFor(stateDir), { id: "reg-1", kind: "project_register", workspace: root, submitter: "owner" });
  const reply = await replyOf(spoolRootFor(stateDir), "reg-1");

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.project, resolved.slug);
  assert.equal(reply.projectRoot, root);
  assert.equal(reply.alreadyRegistered, false);
  assert.equal(reply.bootstrapped, false);
  const registrations = listProjectRegistrations(stateDir);
  assert.equal(registrations.length, 1, "exactly one registration");
  assert.equal(registrations[0]?.slug, resolved.slug);
  assert.equal(registrations[0]?.root, root);
  assert.equal(registrations[0]?.name, "demo");
});

test("registering a subdirectory of a repository registers the repository root, not the subfolder", async (t) => {
  const { dir, stateDir } = makeRegisterSpool(t);
  const root = makeRepo(dir, "mono");
  mkdirSync(join(root, "packages", "foo"), { recursive: true });

  dropRequest(spoolRootFor(stateDir), { id: "reg-sub", kind: "project_register", workspace: join(root, "packages", "foo") });
  const reply = await replyOf(spoolRootFor(stateDir), "reg-sub");

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.projectRoot, root);
  assert.deepEqual(listProjectRegistrations(stateDir).map((reg) => reg.root), [root]);
});

test("registering an already-registered Project reports the existing registration and writes nothing new", async (t) => {
  const { dir, stateDir, opened } = makeRegisterSpool(t);
  const root = makeRepo(dir, "demo");

  dropRequest(spoolRootFor(stateDir), { id: "reg-a", kind: "project_register", workspace: root });
  const first = await replyOf(spoolRootFor(stateDir), "reg-a");
  assert.equal(first.ok, true);
  const slug = first.project as string;
  const path = join(stateDir, "projects", slug, "project.json");
  const bytes = readFileSync(path, "utf8");
  const openedBefore = opened.length;

  dropRequest(spoolRootFor(stateDir), { id: "reg-b", kind: "project_register", workspace: root });
  const second = await replyOf(spoolRootFor(stateDir), "reg-b");

  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.alreadyRegistered, true);
  assert.equal(second.project, slug);
  assert.equal(second.projectRoot, root);
  assert.match(String(second.summary), /already registered/);
  assert.equal(readFileSync(path, "utf8"), bytes, "project.json is byte-for-byte untouched");
  assert.equal(listProjectRegistrations(stateDir).length, 1);
  assert.equal(opened.length, openedBefore, "no second Paseo workspace is opened");
  assert.deepEqual(readdirSync(join(stateDir, "projects")), [slug], "no second project directory");
});

test("a non-git folder is bootstrapped (git init + one empty initial commit) before it registers — greenfield, ADR 0024 parity", async (t) => {
  const { dir, stateDir } = makeRegisterSpool(t);
  const folder = join(dir, "greenfield");
  mkdirSync(folder, { recursive: true });
  const root = realpathSync(folder);
  assert.equal(existsSync(join(root, ".git")), false, "the fixture starts non-git");

  dropRequest(spoolRootFor(stateDir), { id: "reg-gf", kind: "project_register", workspace: root });
  const reply = await replyOf(spoolRootFor(stateDir), "reg-gf");

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.bootstrapped, true);
  assert.equal(reply.alreadyRegistered, false);
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "1", "exactly one initial commit");
  assert.equal(git(root, ["show", "--stat", "--format=%s", "HEAD"]), "chore: initialize repository", "and it is empty");
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  assert.equal(reply.project, resolved.slug, "the slug resolves after the bootstrap");
  assert.equal(readProjectRegistration(stateDir, resolved.slug)?.root, root);
});

test("greenfield registration refuses the filesystem root and the user home — a named failure, nothing written", async (t) => {
  const { dir, stateDir } = makeRegisterSpool(t);
  // `homedir()` honours $HOME, so the refusal is proven against a throwaway home, never the real one.
  const fakeHome = join(dir, "fake-user-home");
  mkdirSync(fakeHome, { recursive: true });
  const priorHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });

  dropRequest(spoolRootFor(stateDir), { id: "reg-home", kind: "project_register", workspace: fakeHome });
  const home = await replyOf(spoolRootFor(stateDir), "reg-home");
  assert.equal(home.ok, false);
  assert.equal(home.code, "unsafe-directory");
  assert.match(String(home.message), /home directory/);
  assert.equal(existsSync(join(fakeHome, ".git")), false, "git was never initialised in the home");

  dropRequest(spoolRootFor(stateDir), { id: "reg-root", kind: "project_register", workspace: "/" });
  const fsRoot = await replyOf(spoolRootFor(stateDir), "reg-root");
  assert.equal(fsRoot.ok, false);
  assert.equal(fsRoot.code, "unsafe-directory");
  assert.match(String(fsRoot.message), /filesystem root/);

  assert.deepEqual(listProjectRegistrations(stateDir), [], "no registration was written");
});

test("a missing workspace directory is a named refusal and writes nothing", async (t) => {
  const { dir, stateDir } = makeRegisterSpool(t);
  dropRequest(spoolRootFor(stateDir), { id: "reg-miss", kind: "project_register", workspace: join(dir, "nope") });
  const reply = await replyOf(spoolRootFor(stateDir), "reg-miss");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "missing-directory");
  assert.deepEqual(listProjectRegistrations(stateDir), []);
});

test("only the Owner registers a Project — a supervisor, lead or agent seat is refused seat-cannot-register", async (t) => {
  const { dir, stateDir } = makeRegisterSpool(t);
  const root = makeRepo(dir, "demo");
  for (const seat of ["supervisor", "lead", "agent"] as const) {
    dropRequest(spoolRootFor(stateDir), { id: `reg-${seat}`, kind: "project_register", workspace: root, submitter: `agent-${seat}-1`, seat });
    const reply = await replyOf(spoolRootFor(stateDir), `reg-${seat}`);
    assert.equal(reply.ok, false, `${seat} must be refused`);
    assert.equal(reply.code, "seat-cannot-register");
  }
  assert.deepEqual(listProjectRegistrations(stateDir), []);
});

test("project_register is serialized with Project delete: it never starts while a delete on the same Project is in flight", async (t) => {
  let releaseDelete: () => void = () => {};
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const trace: string[] = [];
  const ctx = makeRegisterSpool(t, {
    projectDelete: async (request) => {
      trace.push("delete:start");
      await deleteGate;
      trace.push("delete:end");
      return { id: request.id, ok: true, summary: "deleted" };
    },
  });
  const root = makeRepo(ctx.dir, "demo");
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  writeProjectRegistration(ctx.stateDir, resolved.slug, { root });
  const spoolRoot = spoolRootFor(ctx.stateDir);

  dropRequest(spoolRoot, { id: "a-del", kind: "project_delete", project: resolved.slug });
  await until(() => assert.deepEqual(trace, ["delete:start"]));
  dropRequest(spoolRoot, { id: "b-reg", kind: "project_register", workspace: root });
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 8));
  assert.deepEqual(ctx.events, [], "the register handler has not started while the delete holds the Project");

  releaseDelete();
  const reply = await replyOf(spoolRoot, "b-reg");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(trace, ["delete:start", "delete:end"]);
  assert.deepEqual(ctx.events, ["register:start", "register:end"], "register ran once, strictly after the delete finished");
});

test("project_register is serialized with Project reset: it never starts while a reset on the same Project is in flight", async (t) => {
  let releaseReset: () => void = () => {};
  const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
  const trace: string[] = [];
  const ctx = makeRegisterSpool(t, {
    projectReset: async (request) => {
      trace.push("reset:start");
      await resetGate;
      trace.push("reset:end");
      return { id: request.id, ok: true, summary: "reset" };
    },
  });
  const root = makeRepo(ctx.dir, "demo");
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  writeProjectRegistration(ctx.stateDir, resolved.slug, { root });
  const spoolRoot = spoolRootFor(ctx.stateDir);

  dropRequest(spoolRoot, { id: "a-rst", kind: "reset", project: resolved.slug });
  await until(() => assert.deepEqual(trace, ["reset:start"]));
  dropRequest(spoolRoot, { id: "b-reg", kind: "project_register", workspace: root });
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 8));
  assert.deepEqual(ctx.events, [], "the register handler has not started while the reset holds the Project");

  releaseReset();
  const reply = await replyOf(spoolRoot, "b-reg");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(trace, ["reset:start", "reset:end"]);
  assert.deepEqual(ctx.events, ["register:start", "register:end"], "register ran once, strictly after the reset finished");
});

// ---- Seam 2: the CLI subprocess ---------------------------------------------------------------

interface CliResult { status: number | null; stdout: string; stderr: string }

/** Async on purpose: a sync spawn would block this process's event loop, and the spool poll lives here. */
function run(args: string[], extraEnv: Record<string, string> = {}, cwd?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ownerCli, ...args], { env: { ...process.env, ...extraEnv }, ...(cwd === undefined ? {} : { cwd }) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("CLI: `project register --workspace <repo>` submits through the spool, prints the registration and the home it landed under", async (t) => {
  const { dir, home, stateDir } = makeRegisterSpool(t);
  const root = makeRepo(dir, "demo");
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);

  const result = await run(["--home", home, "project", "register", "--workspace", root, "--wait-secs", "10"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`registered Project ${resolved.slug}`));
  assert.ok(result.stdout.includes(root), "names the root");
  assert.ok(result.stdout.includes(home), "names the home the Project was registered under");
  assert.equal(readProjectRegistration(stateDir, resolved.slug)?.root, root, "the plugin wrote the registration");
});

test("CLI: `project register --json` prints one machine-readable object; a re-run reports alreadyRegistered with exit 0", async (t) => {
  const { dir, home } = makeRegisterSpool(t);
  const root = makeRepo(dir, "demo");
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);

  const first = await run(["--home", home, "project", "register", "--workspace", root, "--json", "--wait-secs", "10"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { ok: true, slug: resolved.slug, root, home, alreadyRegistered: false, bootstrapped: false });

  const again = await run(["--home", home, "project", "register", "--workspace", root, "--json", "--wait-secs", "10"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), { ok: true, slug: resolved.slug, root, home, alreadyRegistered: true, bootstrapped: false });

  const human = await run(["--home", home, "project", "register", "--workspace", root, "--wait-secs", "10"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /already registered/);
  assert.ok(human.stdout.includes(home));
});

test("CLI: with no --workspace the current directory is the Project (resolved up to the git root)", async (t) => {
  const { dir, home, stateDir } = makeRegisterSpool(t);
  const root = makeRepo(dir, "demo");
  mkdirSync(join(root, "packages", "foo"), { recursive: true });

  const result = await run(["--home", home, "project", "register", "--json", "--wait-secs", "10"], {}, join(root, "packages", "foo"));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).root, root);
  assert.deepEqual(listProjectRegistrations(stateDir).map((reg) => reg.root), [root]);
});

test("CLI: a greenfield folder is bootstrapped and the reply says so", async (t) => {
  const { dir, home } = makeRegisterSpool(t);
  const folder = join(dir, "fresh");
  mkdirSync(folder, { recursive: true });
  const root = realpathSync(folder);

  const result = await run(["--home", home, "project", "register", "--workspace", root, "--json", "--wait-secs", "10"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bootstrapped, true);
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]), "1");
  const human = await run(["--home", home, "project", "register", "--workspace", root, "--wait-secs", "10"]);
  assert.match(human.stdout, /already registered/);
});

test("CLI: a refused register (the filesystem root) exits 2 with the plugin's code and message on stderr", async (t) => {
  const { home, stateDir } = makeRegisterSpool(t);
  const result = await run(["--home", home, "project", "register", "--workspace", "/", "--wait-secs", "10"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsafe-directory/);
  assert.match(result.stderr, /filesystem root/);
  assert.deepEqual(listProjectRegistrations(stateDir), []);
});

test("CLI: the home precedence is --home > $PASEO_HOME > ~/.paseo, and the reply names the home it used", async (t) => {
  const { dir, home } = makeRegisterSpool(t);
  const root = makeRepo(dir, "demo");

  const viaEnv = await run(["project", "register", "--workspace", root, "--json", "--wait-secs", "10"], { PASEO_HOME: home });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(JSON.parse(viaEnv.stdout).home, home, "$PASEO_HOME is honoured");

  const flagWins = await run(["--home", home, "project", "register", "--workspace", root, "--json", "--wait-secs", "10"], { PASEO_HOME: join(dir, "elsewhere") });
  assert.equal(flagWins.status, 0, flagWins.stderr);
  assert.equal(JSON.parse(flagWins.stdout).home, home, "--home beats $PASEO_HOME");
});

test("CLI: with the plugin down it exits 2 naming the recovery step, writes no state, and leaves no queued request behind", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const root = makeRepo(dir, "demo");

  const result = await run(["--home", home, "project", "register", "--workspace", root, "--wait-secs", "1"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /plugin is not running/i);
  assert.ok(result.stderr.includes(home), "names the home it looked at");
  assert.ok(result.stderr.includes(`factory --home "${home}" project register --workspace "${realpathSync(root)}"`), "a copy-pasteable retry command, quoted so a path with spaces survives");
  assert.doesNotMatch(result.stderr, /nothing was registered/i, "the plugin may have picked the request up just before it was withdrawn — never claim nothing happened");
  assert.ok(result.stderr.includes(`factory --home "${home}" project list`), "tells the Owner how to confirm whether the registration landed");
  assert.deepEqual(listProjectRegistrations(stateDir), [], "the CLI never writes Project state itself");
  assert.equal(existsSync(join(stateDir, "projects")), false);
  const requests = join(spoolRootFor(stateDir), "requests");
  assert.deepEqual(existsSync(requests) ? readdirSync(requests) : [], [], "the unanswered request is withdrawn, not left to surprise-apply later");
});

test("CLI: usage refusals exit 2 before anything is submitted — stray positionals, unknown flags, seat stamps", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const root = makeRepo(dir, "demo");

  const positional = await run(["--home", home, "project", "register", "extra", "--workspace", root]);
  assert.equal(positional.status, 2);
  assert.match(positional.stderr, /unexpected positional "extra"/);

  const badFlag = await run(["--home", home, "project", "register", "--bogus", "--workspace", root]);
  assert.equal(badFlag.status, 2);

  const seat = await run(["--home", home, "project", "register", "--workspace", root], { PASEO_FACTORY_SEAT: "lead", PASEO_AGENT_ID: "agent-lead-1" });
  assert.equal(seat.status, 2);
  assert.match(seat.stderr, /seat-cannot-register/);

  assert.equal(existsSync(join(spoolRootFor(stateDir), "requests")), false, "nothing was submitted");
});
