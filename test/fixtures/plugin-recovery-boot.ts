/** Actual plugin-entry fixture; its process HOME/PASEO_HOME are disposable. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import contribute from "../../plugin/index.server.ts";
import { createFactory } from "../../plugin/server/core/factory.ts";
import { upgradeFactory } from "../../plugin/server/core/history-upgrade.ts";
import { writeProjectRegistration } from "../../plugin/server/core/project.ts";
import { enqueueLeadMail, deliverLeadMail, readLeadMailbox } from "../../plugin/server/core/mailbox.ts";
import { planLegacyIdentity } from "../../plugin/server/core/history-identity.ts";

const home = process.env.PASEO_HOME!, stateDir = join(home, "plugin-state/paseo-factory");
const action = process.env.RECOVERY_ACTION as "resume" | "restore";
const noSpool = process.env.RECOVERY_NO_SPOOL === "yes";
const projectSlug = process.env.RECOVERY_PROJECT === "yes" ? "project" : undefined;
const handlers = new Map<string, (input: any, context: any) => any>();
const events = new Map<string, (event: any, context: any) => any>();
const beforeHooks = new Map<string, (event: any, context: any) => any>();
const server = { on: (name: string, handler: (event: any, context: any) => any) => { events.set(name, handler); return () => { events.delete(name); }; }, before: (name: string, handler: (event: any, context: any) => any) => { beforeHooks.set(name, handler); return () => { beforeHooks.delete(name); }; }, handle: (contract: {name:string}, handler: (input:any, context:any) => any) => { handlers.set(contract.name, handler); } } as unknown as Parameters<typeof contribute>[0];
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
  await new Promise((done) => setTimeout(done, 550));
  assert.deepEqual(stateSnapshot(stateDir), before, "ordinary startup/timer work stays deferred during incomplete maintenance");
  assert.equal(existsSync(join(stateDir, "spool/replies/ordinary.json")), false);
  assert.equal(readFileSync(target, "utf8"), originalTarget);
  assert.equal(existsSync(`${target}.quarantine`), false);
  stop(); // Cleanup must be available while ordinary writes are still fenced.
  stop = contribute(server);
  const sent: string[] = [];
  const daemon = { agents: { list: async ({filter}: any) => ({ entries: filter?.labels?.seat === "supervisor" ? [] : [{ agent: { id: "lead", archivedAt: null, status: "idle", labels: { seat: "lead", project: "project" }, cwd: workspace } }] }), ref: () => ({ send: async (text: string) => { sent.push(text); } }) } };
  events.get("agent.permission_requested")!({ agent: { id: "peer" }, request: {} }, { paseo: daemon });
  events.get("agent.turn_ended")!({ agent: { id: "lead" }, outcome: { kind: "completed" }, timeline: [] }, { paseo: daemon });
  await assert.rejects(beforeHooks.get("agent.create")!({ request: {} }, { paseo: daemon }), /incomplete/);
  await assert.rejects(beforeHooks.get("agent.session_open")!({ request: {} }, { paseo: daemon }), /incomplete/);
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
  if (action === "resume") {
    const source = planLegacyIdentity(JSON.stringify({ seq: 1, ts: "2026-10-23T00:00:00Z", event: "contract_set", task: "REMOTE", workspace, gate: "true", artifact: "out", scope: ["remote"] }) + "\n", { writerId: "remote" });
    const imported = await handlers.get("factory.history.import")!({ project: projectSlug, sources: [{ nodeId: "holder", lines: source.events.map((event) => JSON.stringify(event) + "\n").join("") }] }, {});
    assert.ok(imported.imports.some((item: any) => item.status === "applied"), JSON.stringify(imported));
  }
  console.log("RECOVERY_OK");
} finally { stop(); }
