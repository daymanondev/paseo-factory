/** Actual plugin-entry fixture; its process HOME/PASEO_HOME are disposable. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import contribute from "../../plugin/index.server.ts";
import { createFactory } from "../../plugin/server/core/factory.ts";
import { upgradeFactory } from "../../plugin/server/core/history-upgrade.ts";
import { listProjectRegistrations, writeProjectRegistration } from "../../plugin/server/core/project.ts";
import { enqueueLeadMail, deliverLeadMail, readLeadMailbox } from "../../plugin/server/core/mailbox.ts";
import { planLegacyIdentity } from "../../plugin/server/core/history-identity.ts";

const home = process.env.PASEO_HOME!, stateDir = join(home, "plugin-state/paseo-factory");
const action = process.env.RECOVERY_ACTION as "resume" | "restore";
const noSpool = process.env.RECOVERY_NO_SPOOL === "yes";
const projectSlug = process.env.RECOVERY_PROJECT === "yes" ? "project" : undefined;
// RECOVERY_LEGACY_SERVER=yes serves a 0.13.x-era host (or minimal double)
// whose server object has no addHook — the registration adapter must fall
// back to the legacy on/before names for the whole flow to still pass.
const legacyServer = process.env.RECOVERY_LEGACY_SERVER === "yes";
const handlers = new Map<string, (input: any, context: any) => any>();
const events = new Map<string, (event: any, context: any) => any>();
const beforeHooks = new Map<string, (event: any, context: any) => any>();
const hooks = new Map<string, (payload: any, context: any) => any>();
const server = {
  on: (name: string, handler: (event: any, context: any) => any) => { events.set(name, handler); return () => { events.delete(name); }; },
  before: (name: string, handler: (event: any, context: any) => any) => { beforeHooks.set(name, handler); return () => { beforeHooks.delete(name); }; },
  ...(legacyServer ? {} : { addHook: (name: string, handler: (payload: any, context: any) => any) => { hooks.set(name, handler); return () => { hooks.delete(name); }; } }),
  handle: (contract: {name:string}, handler: (input:any, context:any) => any) => { handlers.set(contract.name, handler); },
} as unknown as Parameters<typeof contribute>[0];
const initialStop = contribute(server); initialStop(); handlers.clear();
if (noSpool) rmSync(join(stateDir, "spool"), { recursive: true });
const workspace = join(home, "workspace"); mkdirSync(workspace); execFileSync("git", ["init", "-q", workspace]);
execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: workspace });
let factory = createFactory({ stateDir });
factory.setContract({ task: "LOCAL", workspace, gate: "true", artifact: "out", scope: ["local"] });
writeProjectRegistration(stateDir, "project", { root: workspace, lead: "lead" });
const projectPath = join(stateDir, "projects/project/ledger.jsonl");
writeFileSync(projectPath, JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00Z", event: "contract_set", task: "COPY", workspace, gate: "true", artifact: "out", scope: ["copy"] }) + "\n");
const mailbox = join(stateDir, "projects/project/mailbox.jsonl");
const queued = enqueueLeadMail(mailbox, { from: "owner", kind: "directive", text: "retained directive" });
deliverLeadMail(mailbox, { mailIds: [queued.mailId], toAgentId: "lead" });
const ordinary = { id: "ordinary", kind: "meter", task: "LOCAL", agent: "peer", provider: "fixture", usage: {} };
const requestPath = join(stateDir, "spool/requests/ordinary.json"); if (!noSpool) writeFileSync(requestPath, JSON.stringify(ordinary) + "\n");
writeFileSync(join(stateDir, "git-blocked.log"), JSON.stringify({ id: "blocked-before-upgrade", command: "git push", rule: "push", reason: "blocked", cwd: workspace }) + "\n");
const target = projectSlug === undefined ? factory.ledger.path : projectPath;
if (action === "resume") writeFileSync(target, readFileSync(target, "utf8") + '{"unfinished":');
const originalTarget = readFileSync(target, "utf8");
const id = "11111111-2222-4333-8444-555555555555";
if (action === "resume") await assert.rejects(upgradeFactory(factory, { action: "apply", transactionId: id, projectSlug }, { fault: (at) => { if (at === "backed-up") throw new Error("interrupted"); } }), /interrupted/);
else {
  await upgradeFactory(factory, { action: "apply", transactionId: id, projectSlug });
  await assert.rejects(upgradeFactory(factory, { action: "restore", transactionId: id, projectSlug }, { fault: (at) => { if (at === `restore-renamed:${target.slice(stateDir.length + 1)}`) throw new Error("interrupted"); } }), /interrupted/);
}
factory.history.stop();
function stateSnapshot(path: string): unknown { return readdirSync(path).sort().filter((name) => !["ledger-owner.json", "ledger-owner-acquire"].includes(name)).map((name) => { const file = join(path, name), st = statSync(file); return [name, st.mode & 0o7777, st.isDirectory() ? stateSnapshot(file) : readFileSync(file).toString("base64")]; }); }
const before = stateSnapshot(stateDir);
let stop = contribute(server);
try {
  assert.ok(handlers.has("factory.history.upgrade")); assert.ok(handlers.has("factory.history.imports"));
  // The dual registration adapter (v0.0.91, ticket 01): an addHook-capable
  // host (Paseo 0.14+/0.15.0) receives all four lifecycle hooks under their
  // unified names — and nothing through the deprecated on/before — while a
  // legacy-only host (0.13.x daemon or minimal double) receives exactly the
  // legacy four.
  if (legacyServer) {
    assert.deepEqual([...hooks.keys()], []);
    assert.deepEqual([...events.keys()].sort(), ["agent.permission_requested", "agent.turn_ended"]);
    assert.deepEqual([...beforeHooks.keys()].sort(), ["agent.create", "agent.session_open"]);
  } else {
    assert.deepEqual([...events.keys(), ...beforeHooks.keys()], []);
    assert.deepEqual([...hooks.keys()].sort(), ["agent.create.before", "agent.open.before", "agent.permission.before", "agent.turn.after"]);
  }
  await new Promise((done) => setTimeout(done, 550));
  assert.deepEqual(stateSnapshot(stateDir), before, "ordinary startup/timer work stays deferred during incomplete maintenance");
  assert.equal(existsSync(join(stateDir, "spool/replies/ordinary.json")), false);
  assert.equal(readFileSync(target, "utf8"), originalTarget);
  assert.equal(existsSync(`${target}.quarantine`), false);
  stop(); // Cleanup must be available while ordinary writes are still fenced.
  stop = contribute(server);
  const sent: string[] = [];
  const daemon = { agents: { list: async ({filter}: any) => ({ entries: filter?.labels?.seat === "supervisor" ? [] : [{ agent: { id: "lead", archivedAt: null, status: "idle", labels: { seat: "lead", project: "project" }, cwd: workspace } }] }), ref: () => ({ send: async (text: string) => { sent.push(text); } }) } };
  // Hook payloads are shape-identical across arms: event hooks take the
  // event object, request hooks take { request } — only the lookup map and
  // key differ between the addHook and legacy registrations.
  const permissionHook = legacyServer ? events.get("agent.permission_requested")! : hooks.get("agent.permission.before")!;
  const turnEndedHook = legacyServer ? events.get("agent.turn_ended")! : hooks.get("agent.turn.after")!;
  const agentCreateHook = legacyServer ? beforeHooks.get("agent.create")! : hooks.get("agent.create.before")!;
  const sessionOpenHook = legacyServer ? beforeHooks.get("agent.session_open")! : hooks.get("agent.open.before")!;
  permissionHook({ agent: { id: "peer" }, request: {} }, { paseo: daemon });
  turnEndedHook({ agent: { id: "lead" }, outcome: { kind: "completed" }, timeline: [] }, { paseo: daemon });
  await assert.rejects(agentCreateHook({ request: {} }, { paseo: daemon }), /incomplete/);
  await assert.rejects(sessionOpenHook({ request: {} }, { paseo: daemon }), /incomplete/);
  await new Promise(setImmediate);
  assert.deepEqual(stateSnapshot(stateDir), before, "captured daemon context and ordinary hook events do not mutate incomplete maintenance or leak rejections");
  const until = async (check: () => boolean) => { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, "deferred runtime work resumes"); await new Promise((done) => setTimeout(done, 20)); } };
  let reply: any;
  if ((projectSlug !== undefined || noSpool) && action === "resume") {
    await handlers.get("factory.history.upgrade")!({ action: "preflight", projectSlug }, { paseo: daemon });
    if (noSpool) {
      mkdirSync(join(stateDir, "spool/requests"), { recursive: true });
      writeFileSync(join(stateDir, "spool/requests/unknown.json"), JSON.stringify({ id: "unknown", kind: "upgrade", action: "restore", transactionId: "22222222-2222-4333-8444-555555555555" }) + "\n");
      await until(() => existsSync(join(stateDir, "spool/replies/unknown.json")));
      assert.equal(JSON.parse(readFileSync(join(stateDir, "spool/replies/unknown.json"), "utf8")).ok, false);
      assert.ok(existsSync(join(stateDir, "spool/processed/unknown.json")));
    }
    writeFileSync(join(stateDir, "spool/requests/recovery.json"), JSON.stringify({ id: "recovery", kind: "upgrade", action, transactionId: id, projectSlug }) + "\n");
    await until(() => existsSync(join(stateDir, "spool/replies/recovery.json")));
    reply = JSON.parse(readFileSync(join(stateDir, "spool/replies/recovery.json"), "utf8"));
  } else reply = await handlers.get("factory.history.upgrade")!({ action, transactionId: id, projectSlug }, { paseo: daemon });
  assert.ok(reply.ok, JSON.stringify(reply));
  await until(() => (noSpool || existsSync(join(stateDir, "spool/replies/ordinary.json"))) && sent.length === 1 && readFileSync(join(stateDir, "ledger.jsonl"), "utf8").includes("blocked-before-upgrade"));
  if (!noSpool) assert.equal(JSON.parse(readFileSync(join(stateDir, "spool/replies/ordinary.json"), "utf8")).ok, true);
  assert.ok(readLeadMailbox(mailbox).inFlight);
  // The sweep history gate (v0.0.91, ticket 02 / spec.md:88): a supervisor
  // session open that BINDS the seat (purpose !== "history") fires the
  // orphaned-workspace sweep — observed through the "session-open sweep" log
  // the trigger emits — while the same session opened to READ an old
  // conversation (purpose: "history") is recognized just the same (seat env
  // re-carried) but never sweeps. The markers bracket the two drives so the
  // test can attribute the (single) sweep line to the interactive arm alone.
  console.log("SWEEP_ARM_INTERACTIVE");
  const supervisorOpen = (purpose: string) => ({
    request: {
      agentId: "sup-open", cwd: workspace, env: {}, provider: "factory-supervisor",
      purpose, workspaceId: "ws-open",
    },
  });
  const interactiveEnv = await sessionOpenHook(supervisorOpen("interactive"), { paseo: daemon });
  await new Promise((done) => setTimeout(done, 150)); // let the fire-and-forget sweep settle
  assert.equal(interactiveEnv?.env?.PASEO_FACTORY_SEAT, "supervisor", "the interactive supervisor open is recognized");
  assert.ok(listProjectRegistrations(stateDir).some((r) => r.supervisor === "sup-open"), "the interactive open binds the supervisor seat");
  console.log("SWEEP_ARM_HISTORY");
  const historyEnv = await sessionOpenHook(supervisorOpen("history"), { paseo: daemon });
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(historyEnv?.env?.PASEO_FACTORY_SEAT, "supervisor", "the history open still re-carries the seat env");
  if (action === "resume") {
    const source = planLegacyIdentity(JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00Z", event: "contract_set", task: "REMOTE", workspace, gate: "true", artifact: "out", scope: ["remote"] }) + "\n", { writerId: "remote" });
    const imported = await handlers.get("factory.history.import")!({ project: projectSlug, sources: [{ nodeId: "holder", lines: source.events.map((event) => JSON.stringify(event) + "\n").join("") }] }, {});
    assert.ok(imported.imports.some((item: any) => item.status === "applied"), JSON.stringify(imported));
  }
  console.log("RECOVERY_OK");
} finally { stop(); }
