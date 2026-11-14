import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createFactoryRegistry, resolveProject, writeProjectRegistration } from "../plugin/server/projects.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SpoolReply, SpoolProjectRotateRequest } from "../plugin/server/spool.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * Ticket 02 of the Rotate-seats spec (ADR 0060): `factory project rotate`.
 * Two seams, external behaviour only —
 *  1. the Spool seam: a dropped `project_rotate` request (parse, seat refusal, handler
 *     routing, the exclusive-maintenance lane) against `startSpool`;
 *  2. the CLI subprocess seam: the real `factory.mjs` against that spool.
 * The `projectRotate` handler's own behaviour is ticket 01's seam
 * (`test/surface-rpc.test.ts`); here a stub stands in for it except where a
 * test names the real surface.
 */

const POLL_MS = 20;
const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");
const NEXT_STEP = "Next: open a New Chat with the `Supervisor (Factory)` profile at";

// ---- fixtures ------------------------------------------------------------------------------

type RotateHook = (request: SpoolProjectRotateRequest) => Promise<SpoolReply>;

function makeRotateSpool(t: TestContext, hooks: {
  /** Replaces the real-surface handler wiring. */
  projectRotate?: RotateHook;
  /** `false` leaves the spool without any rotate handler at all. */
  wired?: boolean;
  projectReset?: (request: { id: string; project?: string; workspace?: string }) => Promise<SpoolReply>;
  projectRegister?: (request: { id: string; workspace: string }) => Promise<SpoolReply>;
} = {}) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());
  const surface = createSurfaceHandlers({
    factory: registry.root,
    registry,
    stateDir,
    home,
    daemon: { agents: { list: async () => ({ entries: [] }) } } as never,
    rotateProjectMailbox: (slug) => leadMail.rotateProjectMailbox(slug),
  });
  const leadMail = createLeadMailRuntime({
    factory: registry.root,
    registry,
    stateDir,
    daemon: { agents: { list: async () => ({ entries: [] }) } } as never,
    ensureLead: (input) => surface.leadEnsure(input),
    retireLead: (input) => surface.leadRotate(input),
  });
  t.after(() => leadMail.stop());
  const requests: SpoolProjectRotateRequest[] = [];
  const realRotate: RotateHook = async (request) => {
    const reply = await surface.projectRotate({
      ...(request.workspace !== undefined ? { projectRoot: request.workspace } : {}),
      ...(request.project !== undefined ? { project: request.project } : {}),
    });
    return reply.ok
      ? { id: request.id, ok: true as const, summary: reply.summary, project: reply.project, projectRoot: reply.projectRoot, archivedSeats: reply.archivedSeats }
      : { id: request.id, ok: false as const, code: reply.code, message: reply.error };
  };
  const rotate = hooks.projectRotate ?? realRotate;
  const spool = startSpool(stateDir, registry.root, {
    pollMs: POLL_MS,
    registry,
    ...(hooks.wired === false ? {} : { projectRotate: async (request: SpoolProjectRotateRequest) => { requests.push({ ...request }); return rotate(request); } }),
    ...(hooks.projectReset === undefined ? {} : { projectReset: (request) => hooks.projectReset!(request) }),
    ...(hooks.projectRegister === undefined ? {} : { projectRegister: (request) => hooks.projectRegister!(request) }),
  });
  t.after(() => spool.stop());
  return { dir, home, stateDir, registry, surface, spool, requests };
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

/** A registered Project under the spool's state dir. */
function registerProject(ctx: { dir: string; stateDir: string }, name = "demo"): { root: string; slug: string } {
  const root = makeRepo(ctx.dir, name);
  const resolved = resolveProject(root);
  assert.ok(resolved.ok);
  writeProjectRegistration(ctx.stateDir, resolved.slug, { root });
  return { root, slug: resolved.slug };
}

/** The request files still queued or processed under the spool — `startSpool` itself creates the directories. */
function submittedRequestFiles(stateDir: string): string[] {
  const root = spoolRootFor(stateDir);
  return ["requests", "processed"].flatMap((name) => (existsSync(join(root, name)) ? readdirSync(join(root, name)) : []));
}

const okReply = (request: SpoolProjectRotateRequest, archivedSeats: string[] = ["agent-lead-1", "agent-sup-1"]): SpoolReply => ({
  id: request.id,
  ok: true,
  summary: `Rotated seats of project demo: archived Lead and Supervisor (2 seat agents). ${NEXT_STEP} /work/demo.`,
  project: "demo",
  projectRoot: "/work/demo",
  archivedSeats,
});

// ---- Seam 1: the Spool ---------------------------------------------------------------------------

test("parseSpoolRequest admits the rotate shape — an optional workspace or project, nothing else carried", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "project_rotate", workspace: "/tmp/x", submitter: "owner" }), {
    id: "r1",
    kind: "project_rotate",
    workspace: "/tmp/x",
    submitter: "owner",
  });
  assert.deepEqual(parseSpoolRequest({ id: "r2", kind: "project_rotate", project: "demo", seat: "lead", keepSeats: true }), {
    id: "r2",
    kind: "project_rotate",
    project: "demo",
    seat: "lead",
  }, "a reset-only field is dropped, a seat stamp is kept");
  assert.deepEqual(parseSpoolRequest({ id: "r3", kind: "project_rotate" }), { id: "r3", kind: "project_rotate" }, "no target is a valid shape — the handler resolves the single registered Project");
  assert.equal(parseSpoolRequest({ id: "r4", kind: "project_rotate", workspace: "  " }), undefined, "blank workspace");
  assert.equal(parseSpoolRequest({ id: "r5", kind: "project_rotate", project: "" }), undefined, "blank project");
  assert.equal(parseSpoolRequest({ id: "r6", kind: "project_rotate", workspace: 7 }), undefined, "non-string workspace");
  assert.equal(parseSpoolRequest({ id: "r7", kind: "project_rotate", project: ["demo"] }), undefined, "non-string project");
});

test("rotate is its own kind — `lead_rotate` still parses as the legacy Lead handoff request", () => {
  const legacy = parseSpoolRequest({ id: "l1", kind: "lead_rotate", projectRoot: "/tmp/x" });
  assert.equal(legacy?.kind, "lead_rotate");
});

test("rotate without a wired handler is refused by name, never a silent pass", async (t) => {
  const { registry } = makeRotateSpool(t, { wired: false });
  const reply = await handleSpoolRequest(registry.root, { id: "r0", kind: "project_rotate", workspace: "/tmp/x" });
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.code, "project-rotate-unavailable");
});

test("only the Owner rotates — a supervisor, lead or agent seat is refused seat-cannot-rotate and the handler never runs", async (t) => {
  const { stateDir, requests } = makeRotateSpool(t, { projectRotate: async (request) => okReply(request) });
  for (const seat of ["supervisor", "lead", "agent"] as const) {
    dropRequest(spoolRootFor(stateDir), { id: `rot-${seat}`, kind: "project_rotate", project: "demo", submitter: `agent-${seat}-1`, seat });
    const reply = await replyOf(spoolRootFor(stateDir), `rot-${seat}`);
    assert.equal(reply.ok, false, `${seat} must be refused`);
    assert.equal(reply.code, "seat-cannot-rotate");
    assert.match(String(reply.message), new RegExp(`Seat ${seat} cannot call factory project rotate`));
  }
  assert.deepEqual(requests, [], "the handler was never reached");
});

test("the Owner's rotate reaches the handler with submitter owner and the named Project, and its reply rides back", async (t) => {
  const ctx = makeRotateSpool(t, { projectRotate: async (request) => okReply(request) });
  const spoolRoot = spoolRootFor(ctx.stateDir);
  dropRequest(spoolRoot, { id: "own-rot", kind: "project_rotate", project: "demo", workspace: "/work/demo", submitter: "owner" });
  const reply = await replyOf(spoolRoot, "own-rot");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(reply.archivedSeats, ["agent-lead-1", "agent-sup-1"]);
  assert.equal(reply.project, "demo");
  assert.match(String(reply.summary), /Supervisor \(Factory\)/);
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0]?.kind, "project_rotate");
  assert.equal(ctx.requests[0]?.project, "demo");
  assert.equal(ctx.requests[0]?.workspace, "/work/demo");
  assert.equal(ctx.requests[0]?.submitter, "owner");
});

test("a handler failure — peers-live — reaches the requester as a normal refusal with its code and message", async (t) => {
  const ctx = makeRotateSpool(t, {
    projectRotate: async (request) => ({ id: request.id, ok: false, code: "peers-live", message: "Project demo has live Peers: T-1 (agent-peer-1)." }),
  });
  dropRequest(spoolRootFor(ctx.stateDir), { id: "pl", kind: "project_rotate", project: "demo", submitter: "owner" });
  const reply = await replyOf(spoolRootFor(ctx.stateDir), "pl");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "peers-live");
  assert.match(String(reply.message), /T-1/);
});

test("against the real surface: rotating a registered Project with no seats replies ok, archivedSeats empty, and names the next step", async (t) => {
  const ctx = makeRotateSpool(t);
  const project = registerProject(ctx);
  dropRequest(spoolRootFor(ctx.stateDir), { id: "real-1", kind: "project_rotate", workspace: project.root, submitter: "owner" });
  const reply = await replyOf(spoolRootFor(ctx.stateDir), "real-1");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.project, project.slug);
  assert.equal(reply.projectRoot, project.root);
  assert.deepEqual(reply.archivedSeats, []);
  assert.ok(String(reply.summary).includes("Supervisor (Factory)"));

  dropRequest(spoolRootFor(ctx.stateDir), { id: "real-2", kind: "project_rotate", project: "no-such-project", submitter: "owner" });
  const unknown = await replyOf(spoolRootFor(ctx.stateDir), "real-2");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "unknown-project");
});

test("rotate is serialized with Project reset: it never starts while a reset on the same Project is in flight", async (t) => {
  let releaseReset: () => void = () => {};
  const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
  const trace: string[] = [];
  const ctx = makeRotateSpool(t, {
    projectReset: async (request) => {
      trace.push("reset:start");
      await resetGate;
      trace.push("reset:end");
      return { id: request.id, ok: true, summary: "reset" };
    },
    projectRotate: async (request) => {
      trace.push("rotate:start");
      trace.push("rotate:end");
      return okReply(request);
    },
  });
  const project = registerProject(ctx);
  const spoolRoot = spoolRootFor(ctx.stateDir);

  dropRequest(spoolRoot, { id: "a-rst", kind: "reset", project: project.slug });
  await until(() => assert.deepEqual(trace, ["reset:start"]));
  dropRequest(spoolRoot, { id: "b-rot", kind: "project_rotate", project: project.slug, submitter: "owner" });
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 8));
  assert.deepEqual(trace, ["reset:start"], "rotate has not started while the reset holds the Project");

  releaseReset();
  const reply = await replyOf(spoolRoot, "b-rot");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(trace, ["reset:start", "reset:end", "rotate:start", "rotate:end"]);
});

test("rotate is serialized with project_register and with another rotate on the same Project", async (t) => {
  let releaseRotate: () => void = () => {};
  const rotateGate = new Promise<void>((resolve) => { releaseRotate = resolve; });
  const trace: string[] = [];
  let first = true;
  const ctx = makeRotateSpool(t, {
    projectRotate: async (request) => {
      trace.push(`${request.id}:start`);
      if (first) {
        first = false;
        await rotateGate;
      }
      trace.push(`${request.id}:end`);
      return okReply(request);
    },
    projectRegister: async (request) => {
      trace.push("register:start");
      trace.push("register:end");
      return { id: request.id, ok: true, summary: "registered" };
    },
  });
  const project = registerProject(ctx);
  const spoolRoot = spoolRootFor(ctx.stateDir);

  dropRequest(spoolRoot, { id: "rot-a", kind: "project_rotate", project: project.slug, submitter: "owner" });
  await until(() => assert.deepEqual(trace, ["rot-a:start"]));
  dropRequest(spoolRoot, { id: "reg-b", kind: "project_register", workspace: project.root });
  dropRequest(spoolRoot, { id: "rot-c", kind: "project_rotate", workspace: project.root, submitter: "owner" });
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 8));
  assert.deepEqual(trace, ["rot-a:start"], "neither the register nor the second rotate starts while the first holds the Project");

  releaseRotate();
  await replyOf(spoolRoot, "reg-b");
  await replyOf(spoolRoot, "rot-c");
  assert.equal(trace[1], "rot-a:end", "the first rotate finished before anything else began");
  assert.deepEqual([...trace].sort(), ["register:end", "register:start", "rot-a:end", "rot-a:start", "rot-c:end", "rot-c:start"]);
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

test("CLI: `project rotate --workspace <repo>` submits kind rotate as the Owner and prints the archived seats, the home and the seat-opening step", async (t) => {
  const ctx = makeRotateSpool(t, { projectRotate: async (request) => okReply(request) });

  const result = await run(["--home", ctx.home, "project", "rotate", "--workspace", ctx.dir, "--wait-secs", "10"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Rotated seats of project demo: archived Lead and Supervisor/);
  assert.ok(result.stdout.includes("Supervisor (Factory)"), "names the seat-opening step");
  assert.ok(result.stdout.includes("New Chat"), "names the seat-opening step");
  assert.ok(result.stdout.includes(ctx.home), "names the home the rotation ran under");
  assert.ok(result.stdout.includes("agent-lead-1") && result.stdout.includes("agent-sup-1"), "names the archived seat agents");
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0]?.kind, "project_rotate", "the Spool kind is project_rotate, not lead_rotate");
  assert.equal(ctx.requests[0]?.workspace, ctx.dir);
  assert.equal(ctx.requests[0]?.project, undefined);
  assert.equal(ctx.requests[0]?.submitter, "owner");
  assert.equal(ctx.requests[0]?.seat, undefined);
});

test("CLI: `project rotate --project <slug>` names the Project, not a folder", async (t) => {
  const ctx = makeRotateSpool(t, { projectRotate: async (request) => okReply(request) });
  const result = await run(["--home", ctx.home, "project", "rotate", "--project", "demo", "--wait-secs", "10"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.requests[0]?.project, "demo");
  assert.equal(ctx.requests[0]?.workspace, undefined);
});

test("CLI: with neither flag the request names no Project, so the plugin resolves the single registered one", async (t) => {
  const ctx = makeRotateSpool(t);
  const project = registerProject(ctx);
  const result = await run(["--home", ctx.home, "project", "rotate", "--wait-secs", "10"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.requests[0]?.workspace, undefined);
  assert.equal(ctx.requests[0]?.project, undefined);
  assert.ok(result.stdout.includes(project.slug));
});

test("CLI: `--json` prints exactly one structured object — slug, root, home, archivedSeats, summary", async (t) => {
  const ctx = makeRotateSpool(t, { projectRotate: async (request) => okReply(request) });
  const result = await run(["--home", ctx.home, "project", "rotate", "--project", "demo", "--json", "--wait-secs", "10"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(parsed.ok, true);
  assert.equal(parsed.project, "demo");
  assert.equal(parsed.root, "/work/demo");
  assert.equal(parsed.home, ctx.home);
  assert.deepEqual(parsed.archivedSeats, ["agent-lead-1", "agent-sup-1"]);
  assert.match(String(parsed.summary), /Supervisor \(Factory\)/);
});

test("CLI: rotating a seat-less Project says so and still names the next step", async (t) => {
  const ctx = makeRotateSpool(t);
  const project = registerProject(ctx);
  const result = await run(["--home", ctx.home, "project", "rotate", "--workspace", project.root, "--wait-secs", "10"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing archived/);
  assert.ok(result.stdout.includes("Supervisor (Factory)"));
});

test("CLI: a seat stamp is refused seat-cannot-rotate with exit 2 and nothing is submitted", async (t) => {
  const ctx = makeRotateSpool(t, { projectRotate: async (request) => okReply(request) });
  for (const seat of ["supervisor", "lead", "agent"] as const) {
    const refused = await run(
      ["--home", ctx.home, "project", "rotate", "--project", "demo", "--wait-secs", "5"],
      { PASEO_FACTORY_SEAT: seat, PASEO_AGENT_ID: `agent-${seat}-1` },
    );
    assert.equal(refused.status, 2, `expected ${seat} to exit 2`);
    assert.match(refused.stderr, /seat-cannot-rotate/);
  }
  assert.equal(ctx.requests.length, 0);
  assert.deepEqual(submittedRequestFiles(ctx.stateDir), [], "nothing was submitted");
});

test("CLI: peers-live exits 2 with the plugin's message and a copy-pasteable rotate command to run once the Tasks are settled", async (t) => {
  const ctx = makeRotateSpool(t, {
    projectRotate: async (request) => ({
      id: request.id,
      ok: false,
      code: "peers-live",
      message: "Project demo has live Peers: T-7 (agent-peer-9). Let it finish or close the Task, then rotate again; nothing was archived or deleted.",
    }),
  });
  const root = makeRepo(ctx.dir, "demo");
  const result = await run(["--home", ctx.home, "project", "rotate", "--workspace", root, "--wait-secs", "10"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /factory: peers-live: /);
  assert.ok(result.stderr.includes("T-7") && result.stderr.includes("agent-peer-9"), "names the Task and the Peer");
  assert.ok(result.stderr.includes(`factory --home "${ctx.home}" project rotate --workspace "${root}"`), "the same rotate command, quoted for paths with spaces");
  assert.match(result.stderr, /close|finish|wait/i, "says what to do before re-running");
  assert.equal(result.stdout, "");
});

test("CLI: peers-live next command names the --project it was given", async (t) => {
  const ctx = makeRotateSpool(t, {
    projectRotate: async (request) => ({ id: request.id, ok: false, code: "peers-live", message: "Project demo has live Peers: T-7 (agent-peer-9)." }),
  });
  const result = await run(["--home", ctx.home, "project", "rotate", "--project", "demo", "--wait-secs", "10"]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(`factory --home "${ctx.home}" project rotate --project "demo"`));
});

test("CLI: an unknown Project exits 2 with the plugin's code and `project list` / `project register` as the way forward", async (t) => {
  const ctx = makeRotateSpool(t);
  const result = await run(["--home", ctx.home, "project", "rotate", "--project", "nope", "--wait-secs", "10"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /factory: unknown-project: /);
  assert.ok(result.stderr.includes(`factory --home "${ctx.home}" project list`), "tells the Owner how to see what is registered");
  assert.ok(result.stderr.includes(`factory --home "${ctx.home}" project register`), "tells the Owner how to register a folder");
});

test("CLI: an ambiguous Project exits 2 and says to rerun with --project", async (t) => {
  const ctx = makeRotateSpool(t);
  registerProject(ctx, "alpha");
  registerProject(ctx, "beta");
  const result = await run(["--home", ctx.home, "project", "rotate", "--wait-secs", "10"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /factory: ambiguous-project: /);
  assert.ok(result.stderr.includes(`factory --home "${ctx.home}" project rotate --project <slug>`));
});

test("CLI: any other plugin failure exits 2 as `factory: <code>: <message>`", async (t) => {
  const ctx = makeRotateSpool(t, {
    projectRotate: async (request) => ({ id: request.id, ok: false, code: "daemon-unavailable", message: "could not list agents" }),
  });
  const result = await run(["--home", ctx.home, "project", "rotate", "--project", "demo", "--wait-secs", "10"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /factory: daemon-unavailable: could not list agents/);
});

test("CLI: with the plugin down it exits 2 naming the recovery step, writes no state, and leaves no queued request behind", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const root = makeRepo(dir, "demo");

  const result = await run(["--home", home, "project", "rotate", "--workspace", root, "--wait-secs", "1"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /plugin is not running/i);
  assert.ok(result.stderr.includes(home), "names the home it looked at");
  assert.ok(result.stderr.includes(`factory --home "${home}" project rotate --workspace "${root}"`), "a copy-pasteable retry command");
  assert.doesNotMatch(result.stderr, /nothing was (rotated|archived)/i, "the plugin may have picked the request up just before it was withdrawn — never claim nothing happened");
  assert.equal(existsSync(join(stateDir, "projects")), false, "the CLI never writes Project state itself");
  const requests = join(spoolRootFor(stateDir), "requests");
  assert.deepEqual(existsSync(requests) ? readdirSync(requests) : [], [], "the unanswered request is withdrawn, not left to surprise-apply later");
});

test("CLI: usage refusals exit 2 before anything is submitted — stray positionals, unknown flags, both targets, blank targets", async (t) => {
  const ctx = makeRotateSpool(t, { projectRotate: async (request) => okReply(request) });
  const refusals: [string[], RegExp][] = [
    [["extra"], /unexpected positional "extra"/],
    [["--keep-seats"], /keep-seats/],
    [["--bogus"], /bogus/],
    [["--workspace", ctx.dir, "--project", "demo"], /either/i],
    [["--project", "  "], /--project needs a slug/],
    [["--workspace", "  "], /--workspace needs a directory/],
  ];
  for (const [args, pattern] of refusals) {
    const result = await run(["--home", ctx.home, "project", "rotate", ...args]);
    assert.equal(result.status, 2, `${args.join(" ")} must exit 2`);
    assert.match(result.stderr, pattern);
  }
  assert.equal(ctx.requests.length, 0);
  assert.deepEqual(submittedRequestFiles(ctx.stateDir), [], "nothing was submitted");
});

test("CLI: help lists `project rotate`, and the subcommand error names it too", async (t) => {
  const ctx = makeRotateSpool(t);
  const help = await run(["--home", ctx.home, "help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /project rotate \[--workspace <dir> \| --project <slug>\]/);
  const unknown = await run(["--home", ctx.home, "project", "frobnicate"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /project rotate/);
});
