import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startSpool, handleSpoolRequest } from "../plugin/server/spool.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import { writeProjectRegistration } from "../src/project.ts";
import { readLocalWriterIdentity } from "../src/writer-identity.ts";
import { createFactory as createPluginFactory } from "../plugin/server/core/factory.ts";
import { createFactory } from "../src/factory.ts";
import { preflightUpgrade, upgradeFactory } from "../src/history-upgrade.ts";
import { disposeDir, gitCommitAll, writeLanes, makeTempDir } from "./helpers.ts";

function snapshot(path: string): unknown {
  if (!existsSync(path)) return null;
  return readdirSync(path).sort().map((name) => { const file = join(path, name); const stat = statSync(file); return [name, stat.mode & 0o7777, stat.isDirectory() ? snapshot(file) : readFileSync(file).toString("base64")]; });
}

test("upgrade preflight reads unsupported history without creating or repairing any state", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const raw = '{"seq":1,"ts":"now","event":"contract_set","task":"T","schema_version":99}\n';
  writeFileSync(join(stateDir, "ledger.jsonl"), raw); chmodSync(join(stateDir, "ledger.jsonl"), 0o640);
  const before = snapshot(dir);
  const result = preflightUpgrade(stateDir);
  assert.equal(result.ok, false);
  assert.equal(result.sourceVersion, 99);
  assert.deepEqual(result.sourceVersions, [99]);
  assert.match(result.conflicts.join("\n"), /valid ledger event/);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(preflightUpgrade(join(dir, "missing")).ok, true);
  assert.deepEqual(snapshot(dir), before);
});

test("Owner upgrade backs up exact associated bytes/modes, preserves seqs, refreshes writer and restores", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
  factory.ledger.append({ event: "contract_set", task: "T", workspace: "/workspace", gate: "true", artifact: "out", by: "old-delegate" });
  writeFileSync(join(stateDir, "retro-old.md"), Buffer.from([0, 1, 255, 10])); chmodSync(join(stateDir, "retro-old.md"), 0o640);
  const original = readFileSync(factory.ledger.path); const originalMode = statSync(factory.ledger.path).mode & 0o7777;
  const result = await upgradeFactory(factory, { action: "apply" }); assert.ok("id" in result);
  assert.equal(result.status, "applied");
  assert.equal(factory.ledger.events[0]!.seq, 1);
  assert.ok(factory.ledger.events[0]!.event_id);
  assert.equal(factory.ledger.events[0]!.provenance?.writer_id, null);
  const journal = JSON.parse(readFileSync(join(result.backupDir, "manifest.json"), "utf8"));
  const saved = journal.before.find((entry: {path:string}) => entry.path === "retro-old.md");
  assert.equal(saved.mode, 0o640);
  assert.equal(readFileSync(join(result.backupDir, "backup", saved.blob)).toString("hex"), "0001ff0a");
  const restored = await upgradeFactory(factory, { action: "restore", transactionId: result.id }); assert.ok("id" in restored);
  assert.equal(restored.status, "restored");
  assert.deepEqual(readFileSync(factory.ledger.path), original);
  assert.equal(statSync(factory.ledger.path).mode & 0o7777, originalMode);
  assert.equal(factory.ledger.writerId, undefined);
  assert.equal(factory.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" }).seq, 2);
});

for (const boundary of ["journaled", "backup:ledger.jsonl", "backed-up", "prepared:@writer", "prepared", "renamed:@writer", "activated:@writer", "renamed:ledger.jsonl", "activated:ledger.jsonl", "refreshed", "applied"]) {
  test(`upgrade resumes deterministically after ${boundary}`, async (t) => {
    const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state");
    let factory = createFactory({ stateDir });
    factory.ledger.append({ event: "contract_set", task: "T", workspace: "/workspace", gate: "true", artifact: "out" });
    const id = "11111111-2222-4333-8444-555555555555";
    await assert.rejects(upgradeFactory(factory, { action: "apply", transactionId: id }, { fault: (at) => { if (at === boundary) throw new Error(`crash:${at}`); } }), /crash:/);
    if (boundary !== "applied") assert.throws(() => factory.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" }), /incomplete/);
    const journalBefore = JSON.parse(readFileSync(join(dir, "state-upgrades", id, "manifest.json"), "utf8"));
    factory.history.stop(); factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
    const resumed = await upgradeFactory(factory, { action: "resume", transactionId: id }); assert.ok("id" in resumed);
    assert.equal(resumed.status, "applied");
    const journalAfter = JSON.parse(readFileSync(join(resumed.backupDir, "manifest.json"), "utf8"));
    assert.deepEqual(journalAfter.mapping, journalBefore.mapping);
    const ids = factory.ledger.events.map((event) => event.event_id);
    await upgradeFactory(factory, { action: "resume", transactionId: id });
    assert.deepEqual(factory.ledger.events.map((event) => event.event_id), ids);
    assert.equal(factory.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" }).seq, 3);
  });
}

for (const change of ["ledger", "queue", "reply", "mailbox", "config", "evidence", "mode"]) {
  test(`restore refuses intervening ${change} work`, async (t) => {
    const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state");
    const factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
    factory.ledger.append({ event: "contract_set", task: "T", workspace: "/workspace", gate: "true", artifact: "out" });
    const result = await upgradeFactory(factory, { action: "apply" }); assert.ok("id" in result);
    if (change === "ledger") factory.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" });
    else if (change === "mode") chmodSync(factory.ledger.path, 0o640);
    else {
      const relative = change === "queue" ? "spool/requests/new.json" : change === "reply" ? "spool/replies/new.json" : change === "mailbox" ? "mailbox.jsonl" : change === "config" ? "lanes.json" : "report-new.md";
      const path = join(stateDir, relative); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "new work\n");
    }
    const before = snapshot(stateDir);
    await assert.rejects(upgradeFactory(factory, { action: "restore", transactionId: result.id }), /State changed outside/);
    assert.deepEqual(snapshot(stateDir), before);
  });
}


test("registered Project upgrade backs up a torn tail before recovery and restores exact bytes", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
  factory.ledger.append({ event: "contract_set", task: "ROOT", workspace: "/root-work", gate: "true", artifact: "out" });
  const rootBytes = readFileSync(factory.ledger.path);
  writeProjectRegistration(stateDir, "disposable", { root: "/project-work" });
  const path = join(stateDir, "projects", "disposable", "ledger.jsonl");
  const raw = JSON.stringify({ seq: 7, ts: "2026-10-23T00:00:00.000Z", event: "contract_set", task: "COPY", workspace: "/project-work", gate: "true", artifact: "out" }) + "\n" + '{"seq":8,"unfinished":';
  writeFileSync(path, raw); chmodSync(path, 0o640);
  const before = snapshot(stateDir);
  const dry = preflightUpgrade(stateDir, { projectSlug: "disposable" }); assert.equal(dry.ok, true);
  assert.deepEqual(snapshot(stateDir), before);
  const applied = await upgradeFactory(factory, { action: "apply", projectSlug: "disposable" }); assert.ok("id" in applied);
  const journal = JSON.parse(readFileSync(join(applied.backupDir, "manifest.json"), "utf8"));
  const backed = journal.before.find((entry: {path:string}) => entry.path === "projects/disposable/ledger.jsonl");
  assert.equal(readFileSync(join(applied.backupDir, "backup", backed.blob), "utf8"), raw);
  assert.equal(existsSync(`${path}.quarantine`), false, "maintenance acquisition must not quarantine original evidence before backup");
  await upgradeFactory(factory, { action: "restore", projectSlug: "disposable", transactionId: applied.id });
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(statSync(path).mode & 0o7777, 0o640);
  assert.deepEqual(readFileSync(factory.ledger.path), rootBytes);
  await factory.history.withExclusiveMaintenance((ledger) => {
    assert.throws(() => ledger.append({ event: "repoke_dispatched", task: "COPY", agent: "peer" }), /reconciled|unterminated|unacknowledged/i);
  }, { projectSlug: "disposable" });
});

test("unsupported or invalid UTF8 Project history is refused before owner acquisition or file repair", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
  writeProjectRegistration(stateDir, "disposable", { root: "/project-work" });
  const path = join(stateDir, "projects", "disposable", "ledger.jsonl");
  for (const bytes of [Buffer.from('{"seq":1,"ts":"now","event":"contract_set","task":"T","schema_version":99}\n{"tail":'), Buffer.concat([Buffer.from('{"seq":1,"ts":"'), Buffer.from([255]), Buffer.from('","event":"contract_set","task":"T"}\n')])]) {
    writeFileSync(path, bytes); const before = snapshot(stateDir);
    await assert.rejects(upgradeFactory(factory, { action: "apply", projectSlug: "disposable" }), /valid ledger event|UTF-8/);
    assert.deepEqual(snapshot(stateDir), before);
  }
});

test("disposable Project writer identity reloads independently while root remains legacy", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state");
  let factory = createFactory({ stateDir });
  factory.ledger.append({ event: "contract_set", task: "ROOT", workspace: "/root-work", gate: "true", artifact: "out" });
  const original = readFileSync(factory.ledger.path);
  writeProjectRegistration(stateDir, "disposable", { root: "/project-work" });
  writeFileSync(join(stateDir, "projects", "disposable", "ledger.jsonl"), JSON.stringify({ seq: 9, ts: "now", event: "contract_set", task: "COPY", workspace: "/project-work", gate: "true", artifact: "out" }) + "\n");
  await upgradeFactory(factory, { action: "apply", projectSlug: "disposable" });
  const writer = readLocalWriterIdentity(stateDir, "disposable"); assert.ok(writer);
  assert.equal(readLocalWriterIdentity(stateDir), undefined);
  factory.history.stop(); factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
  await factory.history.withExclusiveMaintenance((ledger) => { const event = ledger.append({ event: "repoke_dispatched", task: "COPY", agent: "peer" }); assert.equal(event.provenance?.writer_id, writer); assert.equal(event.seq, 11); }, { projectSlug: "disposable" });
  assert.equal(factory.ledger.writerId, undefined); assert.deepEqual(readFileSync(factory.ledger.path), original);
});

for (const boundary of ["restore-renamed:ledger.jsonl", "restored:ledger.jsonl", "restore-removed:@writer", "restored:@writer"]) {
  test(`restore interruption ${boundary} blocks ordinary writes and resumes safely`, async (t) => {
    const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state");
    let factory = createFactory({ stateDir }); factory.ledger.append({ event: "contract_set", task: "T", workspace: "/work", gate: "true", artifact: "out" });
    const original = readFileSync(factory.ledger.path);
    const applied = await upgradeFactory(factory, { action: "apply" }); assert.ok("id" in applied);
    await assert.rejects(upgradeFactory(factory, { action: "restore", transactionId: applied.id }, { fault: (at) => { if (at === boundary) throw new Error("interrupted restore"); } }), /interrupted restore/);
    assert.throws(() => factory.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" }), /incomplete/);
    factory.history.stop(); factory = createFactory({ stateDir }); t.after(() => factory.history.stop());
    assert.throws(() => factory.repoke("T", "peer"), /incomplete/);
    await upgradeFactory(factory, { action: "restore", transactionId: applied.id });
    assert.deepEqual(readFileSync(factory.ledger.path), original);
    assert.equal(factory.ledger.append({ event: "repoke_dispatched", task: "T", agent: "peer" }).seq, 2);
  });
}


function cli(home: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [new URL("../plugin/bin/factory.mjs", import.meta.url).pathname, "--home", home, "upgrade", ...args], { env: { ...process.env, PASEO_AGENT_ID: "", PASEO_FACTORY_CORRELATION: "", PASEO_FACTORY_SEAT: "" } });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.on("close", (code) => { clearTimeout(timeout); done({ code, stdout, stderr }); });
  });
}

test("real CLI preflight stays read-only and Owner apply/restore traverses Spool with exact control accounting", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const home = join(dir, "home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createPluginFactory({ stateDir }); t.after(() => factory.history.stop());
  const old = factory.ledger.append({ event: "contract_set", task: "T", workspace: "/work", gate: "true", artifact: "out" });
  const spool = startSpool(stateDir, factory, { pollMs: 10 }); t.after(() => spool.stop());
  writeFileSync(join(stateDir, "spool", "replies", "old.json"), JSON.stringify({ id: "old", ok: true, event: old, key: `T-spawn-${old.seq}` }) + "\n");
  writeFileSync(join(stateDir, "mailbox.jsonl"), '{"seq":41,"mailId":"unchanged-delivery-id"}\n');
  const before = snapshot(stateDir); const original = readFileSync(factory.ledger.path);
  const dry = await cli(home, ["preflight"]); assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(snapshot(stateDir), before);
  const apply = await cli(home, ["apply", "--wait-secs", "5"]); assert.equal(apply.code, 0, apply.stderr);
  const result = JSON.parse(apply.stdout); assert.equal(result.status, "applied");
  const restore = await cli(home, ["restore", "--transaction", result.id, "--wait-secs", "5"]); assert.equal(restore.code, 0, restore.stderr);
  assert.equal(JSON.parse(restore.stdout).status, "restored");
  assert.deepEqual(readFileSync(factory.ledger.path), original);
  assert.equal(JSON.parse(readFileSync(join(stateDir, "spool", "replies", "old.json"), "utf8")).key, "T-spawn-1");
  assert.equal(readFileSync(join(stateDir, "mailbox.jsonl"), "utf8"), '{"seq":41,"mailId":"unchanged-delivery-id"}\n');
});

test("Spool refuses seat upgrades and surface uses the same Owner maintenance executor", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const factory = createPluginFactory({ stateDir: dir }); t.after(() => factory.history.stop());
  for (const seat of ["lead", "supervisor", "agent"] as const) {
    const reply = await handleSpoolRequest(factory, { id: seat, kind: "upgrade", action: "apply", submitter: seat, seat });
    assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.code, "seat-cannot-upgrade");
  }
  const handlers = createSurfaceHandlers({ factory, stateDir: dir, home: dir, daemon: {} as never });
  const applied = await handlers.historyUpgrade({ action: "apply" }); assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.ok("id" in applied.result);
    const restored = await handlers.historyUpgrade({ action: "restore", transactionId: applied.result.id });
    assert.equal(restored.ok, true);
  }
});

test("corrupt backup hash refuses restore before changing active bytes", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const factory = createFactory({ stateDir: join(dir, "state") }); t.after(() => factory.history.stop());
  factory.ledger.append({ event: "contract_set", task: "T", workspace: "/work", gate: "true", artifact: "out" });
  const applied = await upgradeFactory(factory, { action: "apply" }); assert.ok("id" in applied);
  const journal = JSON.parse(readFileSync(join(applied.backupDir, "manifest.json"), "utf8"));
  const ledger = journal.before.find((entry: {path:string}) => entry.path === "ledger.jsonl");
  writeFileSync(join(applied.backupDir, "backup", ledger.blob), "damaged backup");
  const before = snapshot(factory.stateDir);
  await assert.rejects(upgradeFactory(factory, { action: "restore", transactionId: applied.id }), /Backup hash mismatch/);
  assert.deepEqual(snapshot(factory.stateDir), before);
});


test("upgrade waits for the full required review and Report before taking its backup", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state"); const workspace = join(dir, "repo"); mkdirSync(workspace);
  writeFileSync(join(workspace, "out"), "artifact"); const sha = gitCommitAll(workspace);
  writeLanes(stateDir, { freshEyes: "claude/model" });
  let entered!: () => void, release!: () => void;
  const reviewing = new Promise<void>((resolve) => { entered = resolve; }); const pause = new Promise<void>((resolve) => { release = resolve; });
  const factory = createFactory({ stateDir, eyeCliProbe: () => true, eyeCliRunner: async () => { entered(); await pause; return { code: 0, stdout: "CLEAR\nNothing to add.", stderr: "", timedOut: false }; } }); t.after(() => factory.history.stop());
  factory.setContract({ task: "T", workspace, artifact: "out", gate: "true", freshEyes: true });
  const claiming = factory.claim({ task: "T", sha }); await reviewing;
  const upgrading = upgradeFactory(factory, { action: "apply" });
  try { assert.equal(readLocalWriterIdentity(stateDir), undefined); assert.equal(existsSync(join(dir, "state-upgrades")), false); }
  finally { release(); await claiming; }
  const applied = await upgrading; assert.ok("id" in applied);
  const journal = JSON.parse(readFileSync(join(applied.backupDir, "manifest.json"), "utf8")); const saved = journal.before.find((entry: {path:string}) => entry.path === "ledger.jsonl");
  const before = readFileSync(join(applied.backupDir, "backup", saved.blob), "utf8");
  assert.match(before, /fresh_eyes_written/); assert.match(before, /report_written/);
});

test("new external requests during activation remain retained and block unsafe continuation", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const factory = createFactory({ stateDir: join(dir, "state") }); t.after(() => factory.history.stop());
  const id = "11111111-2222-4333-8444-555555555555";
  await assert.rejects(upgradeFactory(factory, { action: "apply", transactionId: id }, { fault: (at) => {
    if (at === "activated:@writer") { const path = join(factory.stateDir, "spool", "requests"); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "foreign.json"), JSON.stringify({ id: "foreign", kind: "upgrade", action: "apply", transactionId: id })); }
  } }), /State changed outside/);
  const queued = readFileSync(join(factory.stateDir, "spool", "requests", "foreign.json"));
  assert.throws(() => factory.repoke("T", "peer"), /incomplete/);
  await assert.rejects(upgradeFactory(factory, { action: "resume", transactionId: id }), /State changed outside/);
  assert.deepEqual(readFileSync(join(factory.stateDir, "spool", "requests", "foreign.json")), queued);
});

test("ambiguous reused legacy Report paths refuse activation without repair", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir); const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const path = join(stateDir, "ledger.jsonl"), report = join(stateDir, "report-T-1.md");
  const records: Record<string, unknown>[] = [];
  for (const sha of ["first", "second"]) {
    for (const event of [
      { event: "contract_set", task: "T", workspace: "/work", gate: "true", artifact: "out" },
      { event: "claim_reported", task: "T", attempt: 1, sha },
      { event: "gate_started", task: "T", attempt: 1, cmd: "true" },
      { event: "gate_finished", task: "T", attempt: 1, verdict: "green", exit: 0, note: "", sha },
      { event: "report_written", task: "T", attempt: 1, path: report },
    ]) records.push({ ...event, seq: records.length + 1, ts: "now" });
  }
  writeFileSync(path, records.map((event) => JSON.stringify(event) + "\n").join("")); writeFileSync(report, "only later bytes survived\n");
  const before = snapshot(stateDir), checked = preflightUpgrade(stateDir);
  assert.equal(checked.ok, false); assert.match(checked.conflicts.join("\n"), /different Contract epochs/); assert.deepEqual(snapshot(stateDir), before);
});

test("CLI preflight flushes a large inventory through pipes with success and refusal exit codes", async (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const home = join(dir, "home"), stateDir = join(home, "plugin-state/paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  for (let index = 0; index < 600; index++) writeFileSync(join(stateDir, `retained-${index.toString().padStart(4, "0")}.txt`), "evidence\n");
  const before = snapshot(stateDir);
  const good = await cli(home, ["preflight"]);
  assert.equal(good.code, 0, good.stderr);
  const output = JSON.parse(good.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.inventory.filter((entry: { kind: string }) => entry.kind === "file").length, 600);
  assert.deepEqual(snapshot(stateDir), before);
  writeFileSync(join(stateDir, "ledger.jsonl"), '{"seq":1,"ts":"now","event":"unknown"}\n');
  const damaged = snapshot(stateDir);
  const refused = await cli(home, ["preflight"]);
  assert.equal(refused.code, 2, refused.stderr);
  const failure = JSON.parse(refused.stdout);
  assert.equal(failure.ok, false);
  assert.match(failure.conflicts.join("\n"), /valid ledger event/);
  assert.deepEqual(snapshot(stateDir), damaged);
});
