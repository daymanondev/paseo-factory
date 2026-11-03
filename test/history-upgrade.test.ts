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
import { migrateLegacyRootState } from "../src/ledger-migration.ts";
import { parseLedgerJsonl } from "../src/ledger-validation.ts";
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
  writeFileSync(join(stateDir, "projects", "disposable", "ledger.jsonl"), JSON.stringify({ seq: 9, ts: "2026-10-23T00:00:00.000Z", event: "contract_set", task: "COPY", workspace: "/project-work", gate: "true", artifact: "out" }) + "\n");
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
    ]) records.push({ ...event, seq: records.length + 1, ts: "2026-10-23T00:00:00.000Z" });
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

test("upgrade preflight refuses an invalid legacy time fact without rewriting the readable original", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const raw = JSON.stringify({ seq: 1, ts: "not-a-time", event: "retro_written", model: "fixture", outcome: "failed", durationMs: 1, error: "unavailable" }) + "\n";
  const path = join(stateDir, "ledger.jsonl"); writeFileSync(path, raw);
  const before = snapshot(stateDir);
  const result = preflightUpgrade(stateDir);
  assert.equal(result.ok, false);
  assert.match(result.conflicts.join("\n"), /timestamp|ISO 8601|UTC/i);
  assert.deepEqual(snapshot(stateDir), before);
  assert.equal(readFileSync(path, "utf8"), raw);
});

// ---- one-time root → per-Project split & compact migration (v0.0.89 spec, Seam 2 / ADR 0045 §2) ----

function readProjectLedger(path: string) {
  const parsed = parseLedgerJsonl(readFileSync(path, "utf8"));
  assert.equal(parsed.corrupt, undefined, `migrated ledger must parse: ${parsed.corrupt}`);
  return parsed.events;
}

test("startup migration splits and compacts a legacy root ledger into per-Project ledgers and archives the original", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const alphaRoot = join(dir, "alpha-root");
  const betaRoot = join(dir, "beta-root");
  // the Lead seat's correlation binding — attribution path (d) for taskless seat events
  mkdirSync(join(stateDir, "projects", "alpha"), { recursive: true });
  mkdirSync(join(stateDir, "projects", "beta"), { recursive: true });
  writeFileSync(join(stateDir, "correlations.json"), JSON.stringify({
    version: 1,
    records: [{ correlationId: "cor-alpha-lead", role: "lead", projectSlug: "alpha", projectRoot: alphaRoot, agentId: "agent-lead-alpha", issuedAt: "2026-11-01T00:00:00.000Z" }],
  }) + "\n");
  // an existing-but-empty per-Project Ledger is still a migration target
  writeFileSync(join(stateDir, "projects", "beta", "ledger.jsonl"), "");
  chmodSync(join(stateDir, "projects", "beta", "ledger.jsonl"), 0o640);

  const longCommand = `python3 -c ${'"print(' + "x".repeat(400) + ')"'}`;
  const records: Record<string, unknown>[] = [];
  const line = (event: Record<string, unknown>): number => { records.push({ ...event, seq: records.length + 1, ts: `2026-11-01T0${records.length % 10}:00:00.000Z` }); return records.at(-1)!.seq as number; };
  line({ event: "permit_allowed", task: "supervisor", agent: "agent-sup", name: "shell", kind: "tool" });                       // 1 seat spam — pruned
  line({ event: "permit_allowed", task: "lead", agent: "agent-lead-alpha", name: "shell", kind: "tool", command: longCommand }); // 2 seat spam — pruned
  line({ event: "permit_allowed", task: "A-01", agent: "agent-lead-alpha", name: "shell", kind: "tool", command: "git status" }); // 3 Lead session on a real Task — pruned by agent binding
  line({ event: "permit_denied", task: "lead", agent: "agent-lead-alpha", name: "shell", kind: "tool", command: "npm install", rule: "seat-write-fence", reason: "Seat write fence" }); // 4 KEPT → alpha via (d)
  line({ event: "contract_set", task: "A-01", workspace: alphaRoot, gate: "true", artifact: "out.txt", base: "e5b52cc", scope: ["src/"], skills: ["tdd"], description: `DRAFT-1 ${"brief prose ".repeat(60)}` }); // 5 superseded
  line({ event: "permit_allowed", task: "A-01", agent: "agent-peer-1", name: "Bash", kind: "tool", command: longCommand });      // 6 Peer — KEPT, command trimmed
  line({ event: "contract_set", task: "A-01", workspace: alphaRoot, gate: "true", artifact: "out.txt", base: "e5b52cc", scope: ["src/"], skills: ["tdd"], description: `DRAFT-2 ${"brief prose ".repeat(60)}` }); // 7 superseded
  const denialSeq = line({ event: "permit_denied", task: "A-01", agent: "agent-peer-1", name: "Bash", kind: "tool", command: "git push --force origin main", rule: "policy:S1-git-vocabulary", reason: "force push" }); // 8 KEPT with command
  line({ event: "contract_set", task: "A-01", workspace: alphaRoot, gate: "true", artifact: "out.txt", base: "e5b52cc", scope: ["src/"], skills: ["tdd"], description: `FINAL ${"the accepted 4-Part Brief ".repeat(80)}` }); // 9 latest — in full
  const repokeSeq = line({ event: "repoke_dispatched", task: "A-01", agent: "agent-peer-1" });                                    // 10
  line({ event: "needs_human", task: "A-01", reason: "denied-again", evidence: { denial: denialSeq, repoke: repokeSeq } });        // 11
  line({ event: "claim_reported", task: "A-01", attempt: 1, sha: "abc123", agent: "agent-peer-1" });                              // 12
  line({ event: "gate_started", task: "A-01", attempt: 1, cmd: "true" });                                                        // 13
  line({ event: "gate_finished", task: "A-01", attempt: 1, verdict: "red", exit: 1, note: "failed", outputPath: join(stateDir, "gate-A-01-1.log") }); // 14
  line({ event: "report_written", task: "A-01", attempt: 1, path: join(stateDir, "report-A-01-1.md") });                          // 15
  line({ event: "contract_set", task: "B-01", workspace: betaRoot, gate: "true", artifact: "out.txt", description: `B-DRAFT ${"brief prose ".repeat(40)}` }); // 16 superseded
  line({ event: "contract_set", task: "B-01", workspace: betaRoot, gate: "true", artifact: "out.txt", description: `B-FINAL ${"the accepted brief ".repeat(40)}` }); // 17 latest
  line({ event: "permit_allowed", task: "B-01", agent: "agent-peer-2", name: "Bash", kind: "tool", command: longCommand });      // 18 Peer — KEPT, trimmed
  line({ event: "claim_reported", task: "B-01", attempt: 1, sha: "def456", agent: "agent-peer-2" });                              // 19
  line({ event: "gate_started", task: "B-01", attempt: 1, cmd: "true" });                                                        // 20
  line({ event: "gate_finished", task: "B-01", attempt: 1, verdict: "green", exit: 0, note: "passed", sha: "def456abc", outputPath: join(stateDir, "gate-B-01-1.log") }); // 21
  line({ event: "report_written", task: "B-01", attempt: 1, path: join(stateDir, "report-B-01-1.md") });                          // 22
  line({ event: "attempt_accepted", task: "B-01", attempt: 1, accepted_by: "owner", evidenceSeqs: [17, 21, 22, 999] });          // 23 forward seq reference list
  line({ event: "retro_written", model: "copilot/gpt", outcome: "written", durationMs: 1000, proposalsPath: join(stateDir, "retro-2026-11-02.md"), proposalCount: 1, projectSlug: "beta", proposals: [{ class: "observation", evidence: [16, 21], pattern: "p", text: "t" }] }); // 24
  line({ event: "git_blocked", agent: "agent-peer-2", command: "git reset --hard factory/B-01", rule: "git:reset-hard", reason: "reset --hard", cwd: join(stateDir, "projects", "beta", "worktrees", "B-01"), blockId: "blk-1" }); // 25 taskless → beta via worktree path
  line({ event: "permit_allowed", task: "GHOST-9", agent: "agent-unknown", name: "Bash", kind: "tool", command: "ls" });         // 26 unattributable — archived only
  line({ event: "meter_written", task: "A-01", provider: "claude/x", usage: { inputTokens: 10 }, agent: "agent-peer-1" });       // 27 → alpha via Task map

  const raw = records.map((event) => JSON.stringify(event) + "\n").join("");
  writeFileSync(join(stateDir, "ledger.jsonl"), raw);
  for (const name of ["report-A-01-1.md", "gate-A-01-1.log", "report-B-01-1.md", "gate-B-01-1.log", "retro-2026-11-02.md", "report-GHOST-9-1.md"]) {
    writeFileSync(join(stateDir, name), `${name} evidence\n`);
  }

  const fixedClock = new Date("2026-11-03T00:00:00.000Z");
  const result = migrateLegacyRootState(stateDir, { projects: [{ slug: "alpha", gitRoot: alphaRoot }, { slug: "beta", gitRoot: betaRoot }] }, { now: () => fixedClock });
  assert.deepEqual(result, { migrated: true, projects: ["alpha", "beta"], archiveDir: join(stateDir, "archive", `legacy-root-${fixedClock.toISOString().replace(/[:.]/g, "")}`) });
  assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false, "the processed root Ledger leaves the state root");

  const alpha = readProjectLedger(join(stateDir, "projects", "alpha", "ledger.jsonl"));
  assert.deepEqual(alpha.map((event) => event.seq), alpha.map((_, index) => index + 1), "alpha seq is contiguous 1..N");
  assert.deepEqual(alpha.map((event) => event.event), [
    "permit_denied", "contract_set", "permit_allowed", "contract_set", "permit_denied", "contract_set", "repoke_dispatched",
    "needs_human", "claim_reported", "gate_started", "gate_finished", "report_written", "meter_written",
  ]);
  assert.equal(alpha.filter((event) => event.event === "permit_allowed").length, 1, "exactly the Peer allow survives");
  const peerAllow = alpha.find((event) => event.event === "permit_allowed") as unknown as Record<string, unknown>;
  assert.equal(peerAllow.task, "A-01"); assert.equal(peerAllow.agent, "agent-peer-1"); assert.equal(peerAllow.name, "Bash"); assert.equal(peerAllow.kind, "tool");
  assert.equal("command" in peerAllow, false, "Peer allow command is trimmed");
  for (const denied of alpha.filter((event) => event.event === "permit_denied")) {
    assert.equal(typeof (denied as unknown as Record<string, unknown>).command, "string", "every denial keeps its full command");
  }
  const stub = `[Compacted superseded contract draft — see latest contract_set for task A-01]`;
  assert.equal((alpha[1] as unknown as Record<string, unknown>).description, stub);
  assert.equal((alpha[3] as unknown as Record<string, unknown>).description, stub);
  assert.match(String((alpha[5] as unknown as Record<string, unknown>).description), /^FINAL /, "the latest contract_set description stays in full");
  for (const at of [1, 3, 5]) {
    const contract = alpha[at] as unknown as Record<string, unknown>;
    assert.equal(contract.workspace, alphaRoot); assert.equal(contract.gate, "true"); assert.equal(contract.artifact, "out.txt");
    assert.equal(contract.base, "e5b52cc"); assert.deepEqual(contract.scope, ["src/"]); assert.deepEqual(contract.skills, ["tdd"]); assert.equal(contract.task, "A-01");
  }
  const needsHuman = alpha.find((event) => event.event === "needs_human") as unknown as { evidence: Record<string, number> };
  const remappedDenial = alpha.findIndex((event) => event.event === "permit_denied" && (event as unknown as Record<string, unknown>).agent === "agent-peer-1") + 1;
  const remappedRepoke = alpha.findIndex((event) => event.event === "repoke_dispatched") + 1;
  assert.deepEqual(needsHuman.evidence, { denial: remappedDenial, repoke: remappedRepoke }, "needs_human evidence seqs remap to the Project's new addresses");
  assert.equal((alpha.find((event) => event.event === "report_written") as unknown as Record<string, unknown>).path, join(stateDir, "projects", "alpha", "report-A-01-1.md"));
  assert.equal((alpha.find((event) => event.event === "gate_finished") as unknown as Record<string, unknown>).outputPath, join(stateDir, "projects", "alpha", "gate-A-01-1.log"));
  assert.equal(readFileSync(join(stateDir, "projects", "alpha", "report-A-01-1.md"), "utf8"), "report-A-01-1.md evidence\n");
  assert.equal(readFileSync(join(stateDir, "projects", "alpha", "gate-A-01-1.log"), "utf8"), "gate-A-01-1.log evidence\n");
  assert.equal(alpha.some((event) => (event as unknown as Record<string, unknown>).task === "GHOST-9"), false);

  const beta = readProjectLedger(join(stateDir, "projects", "beta", "ledger.jsonl"));
  assert.deepEqual(beta.map((event) => event.seq), beta.map((_, index) => index + 1), "beta seq is contiguous 1..N");
  const betaAccepted = beta.find((event) => event.event === "attempt_accepted") as unknown as Record<string, unknown>;
  assert.deepEqual(betaAccepted.evidenceSeqs, [beta[1]!.seq, beta[5]!.seq, beta[6]!.seq], "evidenceSeqs remap and the unmappable 999 drops");
  const betaRetro = beta.find((event) => event.event === "retro_written") as unknown as Record<string, unknown>;
  assert.equal(betaRetro.proposalsPath, join(stateDir, "projects", "beta", "retro-2026-11-02.md"));
  assert.deepEqual((betaRetro.proposals as Record<string, unknown>[])[0]!.evidence, [beta[0]!.seq, beta[5]!.seq], "retro proposal evidence remaps");
  const betaBlock = beta.find((event) => event.event === "git_blocked") as unknown as Record<string, unknown>;
  assert.equal(betaBlock.cwd, join(stateDir, "projects", "beta", "worktrees", "B-01"));
  assert.equal(betaBlock.command, "git reset --hard factory/B-01", "git_blocked keeps its full command");
  assert.equal("command" in (beta.find((event) => event.event === "permit_allowed") as unknown as Record<string, unknown>), false);
  for (const name of ["report-B-01-1.md", "gate-B-01-1.log", "retro-2026-11-02.md"]) {
    assert.equal(existsSync(join(stateDir, name)), false, `${name} leaves the state root`);
    assert.equal(readFileSync(join(stateDir, "projects", "beta", name), "utf8"), `${name} evidence\n`);
  }
  assert.equal(statSync(join(stateDir, "projects", "beta", "ledger.jsonl")).mode & 0o777, 0o640, "an existing empty Ledger's mode survives migration");

  const archiveDir = join(stateDir, "archive", `legacy-root-${fixedClock.toISOString().replace(/[:.]/g, "")}`);
  assert.equal(readFileSync(join(archiveDir, "ledger.jsonl"), "utf8"), raw, "the archived root keeps the original bytes verbatim");
  assert.match(raw, /GHOST-9/, "sanity: the orphan event was seeded");
  assert.equal(readFileSync(join(archiveDir, "report-GHOST-9-1.md"), "utf8"), "report-GHOST-9-1.md evidence\n", "unattributed artifacts archive");

  const second = migrateLegacyRootState(stateDir, { projects: [{ slug: "alpha", gitRoot: alphaRoot }, { slug: "beta", gitRoot: betaRoot }] }, { now: () => fixedClock });
  assert.deepEqual(second, { migrated: false, projects: [] }, "a second boot is an immediate no-op");
  assert.equal(existsSync(join(stateDir, "ledger.jsonl")), false);
  assert.equal(readProjectLedger(join(stateDir, "projects", "alpha", "ledger.jsonl")).length, alpha.length, "alpha ledger is untouched by the second run");
});

test("startup migration is a no-op without a root ledger and never rewrites a populated per-Project Ledger", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const alphaRoot = join(dir, "alpha-root");
  const betaRoot = join(dir, "beta-root");
  mkdirSync(join(stateDir, "projects", "beta"), { recursive: true });
  const betaLedger = JSON.stringify({ seq: 1, ts: "2026-11-01T00:00:00.000Z", event: "contract_set", task: "B-01", workspace: betaRoot, gate: "true", artifact: "out.txt" }) + "\n";
  writeFileSync(join(stateDir, "projects", "beta", "ledger.jsonl"), betaLedger);

  const noRoot = migrateLegacyRootState(stateDir, { projects: [{ slug: "alpha", gitRoot: alphaRoot }, { slug: "beta", gitRoot: betaRoot }] });
  assert.deepEqual(noRoot, { migrated: false, projects: [] }, "no root ledger — immediate no-op");
  assert.equal(existsSync(join(stateDir, "archive")), false, "a no-op run archives nothing");

  const records = [
    { seq: 1, ts: "2026-11-01T00:00:00.000Z", event: "contract_set", task: "B-01", workspace: betaRoot, gate: "true", artifact: "out.txt", description: "beta work" },
    { seq: 2, ts: "2026-11-01T01:00:00.000Z", event: "permit_allowed", task: "lead", agent: "agent-lead-beta", name: "shell", kind: "tool" },
    { seq: 3, ts: "2026-11-01T02:00:00.000Z", event: "contract_set", task: "A-01", workspace: alphaRoot, gate: "true", artifact: "out.txt", description: "alpha work" },
  ];
  const raw = records.map((event) => JSON.stringify(event) + "\n").join("");
  writeFileSync(join(stateDir, "ledger.jsonl"), raw);
  const result = migrateLegacyRootState(stateDir, { projects: [{ slug: "alpha", gitRoot: alphaRoot }, { slug: "beta", gitRoot: betaRoot }] });
  assert.deepEqual(result.projects, ["alpha"], "only Projects whose Ledger is missing or empty receive history");
  assert.equal(result.migrated, true);
  assert.deepEqual(readProjectLedger(join(stateDir, "projects", "alpha", "ledger.jsonl")).map((event) => event.event), ["contract_set"], "alpha receives exactly its attributable events");
  assert.equal(readFileSync(join(stateDir, "projects", "beta", "ledger.jsonl"), "utf8"), betaLedger, "a populated per-Project Ledger is never rewritten");
  const archives = readdirSync(join(stateDir, "archive"));
  assert.equal(archives.length, 1);
  assert.equal(readFileSync(join(stateDir, "archive", archives[0]!, "ledger.jsonl"), "utf8"), raw, "beta's already-migrated events stay recoverable in the archive");
});

test("startup migration drops a needs_human whose evidence seq did not survive into its Project — only validly mapped seq references remain (spec §2)", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const alphaRoot = join(dir, "alpha-root");
  const betaRoot = join(dir, "beta-root");
  // The denial resolves INSIDE the root ledger (a valid root), but its explicit
  // projectSlug attributes it to beta — so alpha's needs_human loses the very
  // line its evidence cites when the two Projects split.
  const records = [
    { seq: 1, ts: "2026-11-01T00:00:00.000Z", event: "contract_set", task: "A-01", workspace: alphaRoot, gate: "true", artifact: "out.txt" },
    { seq: 2, ts: "2026-11-01T01:00:00.000Z", event: "permit_denied", task: "A-01", agent: "agent-peer-1", name: "Bash", kind: "tool", command: "git push --force origin main", rule: "policy:S1-git-vocabulary", reason: "force push", projectSlug: "beta" },
    { seq: 3, ts: "2026-11-01T02:00:00.000Z", event: "repoke_dispatched", task: "A-01", agent: "agent-peer-1" },
    { seq: 4, ts: "2026-11-01T03:00:00.000Z", event: "needs_human", task: "A-01", reason: "denied-again", evidence: { denial: 2, repoke: 3 } },
  ];
  const raw = records.map((event) => JSON.stringify(event) + "\n").join("");
  writeFileSync(join(stateDir, "ledger.jsonl"), raw);

  const result = migrateLegacyRootState(stateDir, { projects: [{ slug: "alpha", gitRoot: alphaRoot }, { slug: "beta", gitRoot: betaRoot }] });
  assert.equal(result.migrated, true);
  assert.deepEqual(result.projects, ["alpha", "beta"]);

  const alpha = readProjectLedger(join(stateDir, "projects", "alpha", "ledger.jsonl"));
  assert.deepEqual(alpha.map((event) => event.event), ["contract_set", "repoke_dispatched"], "the needs_human whose denial left the Project drops — its evidence cannot remap");
  assert.equal(alpha.every((event) => event.event !== "needs_human"), true);
  const beta = readProjectLedger(join(stateDir, "projects", "beta", "ledger.jsonl"));
  assert.deepEqual(beta.map((event) => event.event), ["permit_denied"], "the explicitly-attributed denial lands in beta");
  assert.match(readFileSync(join(result.archiveDir!, "ledger.jsonl"), "utf8"), /needs_human/, "the dropped escalation stays recoverable in the archived root bytes");
});
