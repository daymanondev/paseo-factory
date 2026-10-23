import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import type { FactoryOptions } from "../plugin/server/core/factory.ts";
import { handleSpoolRequest, startSpool } from "../plugin/server/spool.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { writeLanes } from "./helpers.ts";
import { planLegacyIdentity } from "../src/history-identity.ts";
import { Ledger } from "../src/ledger.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

function fixture(t: TestContext, options: Partial<FactoryOptions> = {}) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "artifact.txt"), "evidence\n");
  const sha = gitCommitAll(workspace);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  const identity = planLegacyIdentity("", { writerId: "local" });
  const fence = identity.events.map((event) => `${JSON.stringify(event)}\n`).join("");
  writeFileSync(join(stateDir, "ledger.jsonl"), fence);
  const factory = createFactory({ ...options, stateDir, writerId: "local" });
  factory.setContract({ task: "LOCAL", workspace, gate: "true", artifact: "artifact.txt", scope: ["local"] });
  const sourcePath = join(dir, "source.jsonl");
  writeFileSync(sourcePath, planLegacyIdentity("", { writerId: "remote" }).events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const remote = Ledger.open(sourcePath, { writerId: "remote" });
  remote.append({ event: "contract_set", task: "REMOTE", workspace, gate: "true", artifact: "artifact.txt", base: sha, scope: ["remote"] });
  const sources = [{ nodeId: "holder", lines: readFileSync(sourcePath, "utf8") }];
  return { dir, workspace, sha, stateDir, factory, sources };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const station of ["Fresh-eyes", "Watch", "Retro"] as const) {
  test(`imports wait for the complete ${station} pipeline and drain automatically across entrances`, { timeout: 15_000 }, async (t) => {
    const entered = deferred();
    const resume = deferred();
    const runner = async () => {
      entered.resolve();
      await resume.promise;
      const stdout = station === "Fresh-eyes" ? "CLEAR\nReviewed."
        : station === "Retro" ? '{"proposals":[]}'
        : "destructive-writes: 0\ntest-weakened: 0\nstuck-loop: 0\nscope-creep: 0\nsecret-leak: 0";
      return { code: 0, stdout, stderr: "", timedOut: false };
    };
    const { factory, sources, workspace, sha, stateDir, dir } = fixture(t, {
      eyeCliProbe: () => true, eyeCliRunner: runner,
      watchCopilotProbe: () => true, watchCopilotRunner: runner,
      retroCopilotProbe: () => true, retroCopilotRunner: runner,
      fetchTimeline: async () => ({ ok: true, entries: [{ seq: 1, item: { type: "message", text: "Agent investigated the Task." } }] }),
    });
    writeLanes(stateDir, { freshEyes: "claude/example", watch: "claude/example", retro: "claude/example" });
    factory.setContract({ task: "LOCAL", workspace, gate: "true", artifact: "artifact.txt", scope: ["local"], ...(station === "Fresh-eyes" ? { freshEyes: true } : station === "Watch" ? { watch: true } : {}) });
    const handlers = createSurfaceHandlers({ factory, stateDir, home: dir, daemon: {} as SurfaceDaemonApi });
    const operation = station === "Retro" ? handlers.retro({}) : handleSpoolRequest(factory, { id: "claim", kind: "claim", task: "LOCAL", sha, agent: "peer" });
    try {
      await entered.promise;
      const reply = await handlers.historyImport({ sources });
      assert.equal(reply.imports[0]?.status, "pending");
      assert.equal(factory.contractFor("REMOTE"), undefined);
    } finally { resume.resolve(); await operation; }
    assert.equal(factory.history.status()[0]?.status, "applied");
    assert.equal(factory.contractFor("REMOTE")?.workspace, workspace);
    const names = factory.ledger.events.map((event) => event.event);
    const importedAt = factory.ledger.events.findIndex((event) => event.event === "contract_set" && event.task === "REMOTE");
    assert.ok(importedAt > names.lastIndexOf(station === "Retro" ? "retro_written" : "report_written"));
  });
}

test("Factory admits imported history through its writer and the next append remains unique", (t) => {
  const { factory, sources, workspace } = fixture(t);

  const imported = factory.history.stage(sources);

  assert.equal(imported.status, "applied");
  assert.equal(factory.contractFor("REMOTE")?.workspace, workspace);
  assert.equal(factory.setContract({ task: "NEXT", workspace, gate: "true", artifact: "artifact.txt", scope: ["next"] }).seq, 4);
  const disk = readFileSync(factory.ledger.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(disk.map((event) => event.seq), [1, 2, 3, 4]);
  assert.deepEqual(factory.ledger.events, disk);
  assert.equal(factory.ledger.events.at(-1)?.schema_version, 2);
  assert.equal(factory.ledger.events.at(-1)?.provenance?.writer_id, "local");
});

for (const boundary of ["prepared", "renamed", "activated", "applied"] as const) {
  test(`interrupted ${boundary} import is durable, cache-consistent and retry/restart idempotent`, async (t) => {
    let failed = false;
    const { factory, sources, stateDir, workspace } = fixture(t, { historyFault: (at) => { if (at === boundary && !failed) { failed = true; throw new Error(`interrupted-${at}`); } } });
    factory.history.stage(sources);
    assert.ok(failed);
    const disk = readFileSync(factory.ledger.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(factory.ledger.events, disk, "post-rename failure must refresh the live counter immediately");
    const committed = boundary !== "prepared";
    assert.equal(factory.contractFor("REMOTE") !== undefined, committed);
    factory.history.stop();
    const restarted = createFactory({ stateDir, writerId: "local" });
    assert.equal(restarted.history.status()[0]?.status, "applied");
    const bytes = readFileSync(restarted.ledger.path, "utf8");
    assert.equal(restarted.history.stage(sources).status, "applied");
    assert.equal(readFileSync(restarted.ledger.path, "utf8"), bytes);
    const next = restarted.setContract({ task: "AFTER", workspace, gate: "true", artifact: "artifact.txt", scope: ["after"] });
    assert.equal(next.seq, Math.max(...restarted.ledger.events.slice(0, -1).map((event) => event.seq)) + 1);
    assert.equal(new Set(restarted.ledger.events.map((event) => event.event_id)).size, restarted.ledger.events.length);
  });
}

test("standalone staging cannot replace an owned Ledger and direct Factory drains before its next command", async (t) => {
  const { factory, sources, workspace } = fixture(t);
  const before = readFileSync(factory.ledger.path, "utf8");
  const { execFileSync } = await import("node:child_process");
  const stageUrl = new URL("../plugin/bin/history-stage.mjs", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `import {stageLedgerImport} from ${JSON.stringify(stageUrl)}; console.log(JSON.stringify(stageLedgerImport(${JSON.stringify(factory.ledger.path)},${JSON.stringify(sources)})));`], { encoding: "utf8", timeout: 10_000 });
  assert.equal(JSON.parse(output).status, "pending");
  assert.equal(readFileSync(factory.ledger.path, "utf8"), before);
  assert.equal(factory.contractFor("REMOTE"), undefined);
  await factory.history.runOperation(() => factory.setContract({ task: "AFTER", workspace, gate: "true", artifact: "artifact.txt", scope: ["after"] }), { newWork: true });
  assert.equal(factory.history.status()[0]?.status, "applied");
  assert.equal(factory.ledger.events.at(-1)?.seq, 4);
  const factoryUrl = new URL("../src/factory.ts", import.meta.url).href;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", `import {createFactory} from ${JSON.stringify(factoryUrl)}; createFactory({stateDir:${JSON.stringify(factory.stateDir)},writerId:'other'});`], { timeout: 10_000, stdio: "pipe" }), /Command failed/);
});

test("maintenance fences associated work, invalidates detached authority and preserves restored modes and writer reset", async (t) => {
  const { factory, workspace } = fixture(t);
  const { chmodSync, statSync } = await import("node:fs");
  const entered = deferred(), resume = deferred(), detached = deferred(), runDetached = deferred();
  let detachedFailure: unknown;
  await factory.history.withExclusiveMaintenance(async (ledger) => {
    chmodSync(ledger.path, 0o660);
    ledger.activateHistory(readFileSync(ledger.path, "utf8"));
    assert.equal(statSync(ledger.path).mode & 0o777, 0o660);
    void (async () => { await runDetached.promise; try { factory.meter({ task: "LOCAL", agent: "peer", provider: "test", usage: {} }); } catch (error) { detachedFailure = error; } detached.resolve(); })();
  });
  const maintenance = factory.history.withExclusiveMaintenance(async (ledger) => {
    entered.resolve(); await resume.promise;
    const legacy = `${JSON.stringify({ event: "contract_set", seq: 1, ts: new Date().toISOString(), task: "RESTORED", workspace, gate: "true", artifact: "artifact.txt", scope: ["restored"] })}\n`;
    writeFileSync(ledger.path, legacy);
    ledger.refreshHistoryFromDisk({ writerId: null });
    assert.equal(ledger.writerId, undefined);
    assert.equal(statSync(ledger.path).mode & 0o777, 0o660);
  });
  await entered.promise;
  runDetached.resolve(); await detached.promise;
  assert.ok(detachedFailure instanceof Error);
  let began = false;
  const next = factory.history.runOperation(() => { began = true; }, { newWork: true });
  await Promise.resolve(); assert.equal(began, false);
  resume.resolve(); await maintenance; await next;
  assert.equal(began, true);
  factory.setContract({ task: "AFTER", workspace, gate: "true", artifact: "artifact.txt", scope: ["after"] });
  assert.equal(factory.ledger.events.at(-1)?.schema_version, undefined, "restoring legacy resets the active schema");
});

test("Spool ignores forged owner bindings and refuses overlapping current Contracts without changing history", async (t) => {
  const { factory, sources, workspace } = fixture(t);
  const before = readFileSync(factory.ledger.path, "utf8");
  const incoming = sources[0]!;
  const modified = incoming.lines.trim().split("\n").map((line) => JSON.parse(line));
  modified[1].scope = ["local/subtree"];
  const reply = await handleSpoolRequest(factory, { id: "forged", kind: "history_import", sources: [{ ...incoming, lines: modified.map((event) => JSON.stringify(event)).join("\n") + "\n" }], bindings: [{ workspace, landedCommits: ["forged"] }] } as never);
  assert.ok(reply.ok);
  assert.equal(reply.ok && reply.historyImports?.[0]?.status, "conflicted");
  assert.equal(readFileSync(factory.ledger.path, "utf8"), before);
});

test("independent Gates stay concurrent and their real external Spool continuations do not deadlock pending imports", { timeout: 15_000 }, async (t) => {
  const { factory, sources, workspace, sha, stateDir, dir } = fixture(t);
  const { createServer } = await import("node:http");
  const { createChoke } = await import("../plugin/server/choke.ts");
  const entered = deferred();
  const responses: import("node:http").ServerResponse[] = [];
  const server = createServer((_request, response) => { responses.push(response); if (responses.length === 2) entered.resolve(); });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  t.after(() => { for (const response of responses) response.end(); server.closeAllConnections(); server.close(); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const script = join(dir, "gate.mjs");
  const client = new URL("../plugin/bin/spool-client.mjs", import.meta.url).href;
  writeFileSync(script, `import {submit,awaitReply} from ${JSON.stringify(client)}; await fetch('http://127.0.0.1:${port}'); const root=${JSON.stringify(join(stateDir, "spool"))}; const id='ask-'+process.pid; submit(root,{id,kind:'ask',task:'OTHER',agent:String(process.pid),command:'echo allowed'}); const reply=await awaitReply(root,id,5000,10); if(!reply.ok||reply.decision!=='allowed') throw new Error(JSON.stringify(reply));`);
  const gate = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  for (const [task, scope] of [["LOCAL", "local"], ["OTHER", "other"]]) factory.setContract({ task: task!, workspace, gate, artifact: "artifact.txt", scope: [scope!] });
  const choke = createChoke({ factory, homeDir: dir });
  const spool = startSpool(stateDir, factory, { pollMs: 10, ask: choke.spoolAskHandler });
  t.after(() => spool.stop());
  const claims = Promise.all([handleSpoolRequest(factory, { id: "gate-one", kind: "claim", task: "LOCAL", sha }), factory.claim({ task: "OTHER", sha })]);
  await entered.promise;
  const staged = factory.history.stage(sources);
  assert.equal(staged.status, "pending");
  assert.equal(factory.history.activeOperations, 2, "both Gate pipelines acquired independent leases");
  for (const response of responses) response.end("resume");
  const outcomes = await claims;
  assert.ok("ok" in outcomes[0]! && outcomes[0].ok);
  assert.equal(outcomes[1]?.verdict, "green", JSON.stringify(outcomes));
  assert.equal(factory.history.status()[0]?.status, "applied");
  assert.equal(factory.ledger.events.filter((event) => event.event === "permit_allowed").length, 2);
  const ids = factory.ledger.events.map((event) => event.seq);
  assert.equal(new Set(ids).size, ids.length);
});

test("acceptance keeps its lease through shared executor workspace cleanup", { timeout: 10_000 }, async (t) => {
  const { factory, sources, sha, stateDir, workspace, dir } = fixture(t);
  const { resolveProject, writeProjectRegistration } = await import("../plugin/server/core/project.ts");
  const { executeAcceptance } = await import("../plugin/server/commands.ts");
  const project = resolveProject(workspace); assert.ok(project.ok); if (!project.ok) return;
  writeProjectRegistration(stateDir, project.slug, { root: workspace, taskWorkspaces: { LOCAL: "workspace-id" } });
  const claim = await factory.claim({ task: "LOCAL", sha });
  assert.equal(claim.verdict, "green");
  const entered = deferred(), resume = deferred();
  const operation = executeAcceptance(factory, { task: "LOCAL", attempt: claim.attempt }, { authority: "owner", daemon: { workspaces: { archive: async () => { entered.resolve(); await resume.promise; } } } as never, home: dir, cleanup: async () => ({}) as never });
  await entered.promise;
  const reply = await handleSpoolRequest(factory, { id: "during-cleanup", kind: "history_import", sources });
  assert.equal(reply.ok && reply.historyImports?.[0]?.status, "pending");
  assert.equal(factory.contractFor("REMOTE"), undefined);
  resume.resolve(); await operation;
  assert.equal(factory.history.status()[0]?.status, "applied");
});

test("registered disposable project admission leaves the legacy root history unchanged", async (t) => {
  const { factory: oldFactory, sources, workspace, stateDir, dir } = fixture(t);
  oldFactory.history.stop();
  const { resolveProject, writeProjectRegistration, projectStateDir } = await import("../plugin/server/core/project.ts");
  const project = resolveProject(workspace); assert.ok(project.ok); if (!project.ok) return;
  writeProjectRegistration(stateDir, project.slug, { root: workspace });
  const targetDir = projectStateDir(stateDir, project.slug);
  writeFileSync(join(targetDir, "ledger.jsonl"), planLegacyIdentity("", { writerId: "local" }).events.map((event) => JSON.stringify(event) + "\n").join(""));
  const rootBytes = `${JSON.stringify({ seq: 1, ts: new Date().toISOString(), event: "contract_set", task: "ROOT", workspace, gate: "true", artifact: "artifact.txt" })}\n`;
  writeFileSync(join(stateDir, "ledger.jsonl"), rootBytes);
  const factory = createFactory({ stateDir, writerId: "local" });
  const handlers = createSurfaceHandlers({ factory, stateDir, home: dir, daemon: {} as SurfaceDaemonApi });
  const reply = await handlers.historyImport({ project: project.slug, sources });
  assert.equal(reply.imports[0]?.status, "applied");
  assert.equal(readFileSync(join(stateDir, "ledger.jsonl"), "utf8"), rootBytes);
  assert.match(readFileSync(join(targetDir, "ledger.jsonl"), "utf8"), /REMOTE/);
  await factory.history.withExclusiveMaintenance((ledger) => { assert.equal(ledger.path, join(targetDir, "ledger.jsonl")); }, { projectSlug: project.slug });
});

for (const proof of ["foreign path", "remote landing"] as const) {
  test(`Spool cannot turn request-supplied ${proof} facts into owner authority`, async (t) => {
    const { factory, sources, sha, workspace, dir } = fixture(t);
    const sourcePath = join(dir, "forged.jsonl");
    writeFileSync(sourcePath, sources[0]!.lines);
    const remote = Ledger.open(sourcePath, { writerId: "remote" });
    if (proof === "remote landing") {
      remote.append({ event: "claim_reported", task: "REMOTE", attempt: 1, sha });
      remote.append({ event: "gate_finished", task: "REMOTE", attempt: 1, sha, verdict: "green", exit: 0, note: "claimed" });
      remote.append({ event: "attempt_accepted", task: "REMOTE", attempt: 1, accepted_by: "owner", landing: "landed" });
    } else {
      const foreign = join(dir, "foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "artifact.txt"), "foreign"); gitCommitAll(foreign);
      remote.append({ event: "contract_set", task: "REMOTE", workspace: foreign, gate: "true", artifact: "artifact.txt", scope: ["foreign"] });
    }
    const before = readFileSync(factory.ledger.path, "utf8");
    const reply = await handleSpoolRequest(factory, { id: "forged", kind: "history_import", sources: [{ nodeId: "forger", lines: readFileSync(sourcePath, "utf8") }], bindings: [{ workspace, artifactPresent: true, landedCommits: [sha], commits: [sha] }] } as never);
    assert.equal(reply.ok && reply.historyImports?.[0]?.status, "conflicted");
    assert.match(JSON.stringify(reply), proof === "remote landing" ? /verified local landing/ : /binding/);
    assert.equal(readFileSync(factory.ledger.path, "utf8"), before);
  });
}

test("pending import drains before newly arriving commands and exclusive maintenance callbacks never overlap", { timeout: 10_000 }, async (t) => {
  const entered = deferred(), resume = deferred();
  const { factory, sources, workspace } = fixture(t, { retroCopilotProbe: () => true, retroCopilotRunner: async () => { entered.resolve(); await resume.promise; return { code: 0, stdout: '{"proposals":[]}', stderr: "", timedOut: false }; } });
  writeLanes(factory.stateDir, { retro: "claude/example" });
  const retro = factory.retro(); await entered.promise;
  assert.throws(() => factory.resetProject(workspace), (error: unknown) => (error as { code: string }).code === "history-maintenance-busy");
  factory.history.stage(sources);
  const command = handleSpoolRequest(factory, { id: "new", kind: "contract", task: "NEXT", workspace, gate: "true", artifact: "artifact.txt", scope: ["next"], submitter: "owner" });
  await Promise.resolve(); assert.equal(factory.contractFor("NEXT"), undefined);
  resume.resolve(); await retro; assert.ok((await command).ok);
  const names = factory.ledger.events.filter((event) => event.event === "contract_set").map((event) => event.task);
  assert.ok(names.indexOf("REMOTE") < names.indexOf("NEXT"));
  const held = deferred(), release = deferred();
  let concurrent = 0, maximum = 0;
  const first = factory.history.withExclusiveMaintenance(async () => { concurrent++; maximum = Math.max(maximum, concurrent); held.resolve(); await release.promise; concurrent--; });
  const second = factory.history.withExclusiveMaintenance(() => { concurrent++; maximum = Math.max(maximum, concurrent); concurrent--; });
  await held.promise; release.resolve(); await Promise.all([first, second]);
  assert.equal(maximum, 1);
});

test("an interrupted owner acquisition fails closed before Ledger recovery or mutation", (t) => {
  const { factory, stateDir } = fixture(t);
  const bytes = readFileSync(factory.ledger.path, "utf8");
  factory.history.stop();
  writeFileSync(join(stateDir, "ledger-owner-acquire"), "");
  assert.throws(() => createFactory({ stateDir, writerId: "local" }), (error: unknown) => (error as { code: string }).code === "ledger-owner-acquisition-busy");
  assert.equal(readFileSync(join(stateDir, "ledger.jsonl"), "utf8"), bytes);
});
