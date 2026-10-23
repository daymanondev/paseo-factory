import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger } from "../src/ledger.ts";
import { planLegacyIdentity } from "../src/history-identity.ts";
import { readDriverLedger } from "../plugin/bin/driver.mjs";
import { disposeDir, factoryErrorCode, makeTempDir, repoRoot } from "./helpers.ts";

const ts = "2026-10-23T00:00:00.000Z";
const contract = { seq: 1, ts, event: "contract_set", task: "T1" };

function mcpStatus(stateDir: string, bridge = join(repoRoot, "plugin/bin/bridge.mjs")): Record<string, any> {
  const result = spawnSync(process.execPath, [bridge, "--state-dir", stateDir, "--role", "supervisor", "--workspace", stateDir], {
    encoding: "utf8", timeout: 10_000,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "factory_status", arguments: {} } })}\n`,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("CLI status refuses duplicate Ledger sequences without mutating the live file", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state/paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "ledger.jsonl");
  const bytes = `${JSON.stringify(contract)}\n${JSON.stringify({ ...contract, task: "T2" })}\n`;
  writeFileSync(path, bytes);

  const result = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });

  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /line 2.*valid ledger event/);
  assert.equal(readFileSync(path, "utf8"), bytes);
});

test("CLI, copied-alone MCP bridge, driver and startup agree on the Ledger integrity corpus", async (t) => {
  const good = `${JSON.stringify(contract)}\n`;
  const event = (extra: Record<string, unknown>) => `${JSON.stringify({ ...contract, ...extra })}\n`;
  const cases: Array<{ name: string; raw: string; corrupt?: RegExp; tail?: string }> = [
    { name: "valid legacy record", raw: good },
    { name: "explicit supported version", raw: event({ schema_version: 1 }) },
    { name: "sequence gaps remain valid", raw: good + event({ seq: 8, task: "T2" }) },
    { name: "blank complete line", raw: good + "\n", corrupt: /blank line at line 2/ },
    { name: "whitespace complete line", raw: good + "  \n", corrupt: /line 2 is not valid JSON/ },
    { name: "malformed complete JSON", raw: good + "broken\n", corrupt: /line 2 is not valid JSON/ },
    { name: "non-record JSON", raw: "null\n", corrupt: /line 1 is not a valid ledger event/ },
    { name: "duplicate sequence", raw: good + event({ task: "T2" }), corrupt: /line 2 is not a valid ledger event/ },
    { name: "decreasing sequence", raw: event({ seq: 3 }) + event({ seq: 2 }), corrupt: /line 2 is not a valid ledger event/ },
    { name: "missing sequence", raw: event({ seq: undefined }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "zero sequence", raw: event({ seq: 0 }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "fractional sequence", raw: event({ seq: 1.5 }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "unsafe sequence", raw: event({ seq: Number.MAX_SAFE_INTEGER + 1 }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "unsupported version", raw: event({ schema_version: 999 }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "unknown event", raw: event({ event: "teleported" }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "missing timestamp", raw: event({ ts: undefined }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "invalid legacy shape", raw: event({ event: "spawn_dispatched", arity: 0 }), corrupt: /line 1 is not a valid ledger event/ },
    { name: "unterminated broken tail", raw: good + '{"seq":2', tail: '{"seq":2' },
    { name: "unterminated green record", raw: good + JSON.stringify({ seq: 2, ts, event: "gate_finished", task: "T1", attempt: 1, verdict: "green" }), tail: JSON.stringify({ seq: 2, ts, event: "gate_finished", task: "T1", attempt: 1, verdict: "green" }) },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, (t) => {
      const dir = makeTempDir();
      disposeDir(t, dir);
      const stateDir = join(dir, "plugin-state/paseo-factory");
      mkdirSync(stateDir, { recursive: true });
      const path = join(stateDir, "ledger.jsonl");
      writeFileSync(path, fixture.raw);
      const bridge = join(dir, "bridge.mjs");
      copyFileSync(join(repoRoot, "plugin/bin/bridge.mjs"), bridge);
      const cli = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });
      const mcp = mcpStatus(stateDir, bridge);

      if (fixture.corrupt) {
        assert.equal(cli.status, 2, cli.stdout);
        assert.match(cli.stderr, fixture.corrupt);
        assert.match(mcp.error?.message ?? "", fixture.corrupt);
        assert.throws(() => readDriverLedger(stateDir), fixture.corrupt);
      } else {
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(mcp.error, undefined);
        assert.match(mcp.result.content[0].text, /T1 attempts=0 verdict=-/);
        assert.doesNotThrow(() => readDriverLedger(stateDir));
      }
      assert.equal(readFileSync(path, "utf8"), fixture.raw, "read-only entrances preserve live bytes");
      assert.equal(existsSync(`${path}.quarantine`), false, "read-only entrances never quarantine a tail");
      if (fixture.corrupt) assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
      else {
        const opened = Ledger.open(path);
        assert.equal(opened.events.length, fixture.name === "sequence gaps remain valid" ? 2 : 1);
        if (fixture.tail !== undefined) {
          assert.equal(readFileSync(path, "utf8"), good);
          assert.equal(readFileSync(`${path}.quarantine`, "utf8"), `${fixture.tail}\n`);
        }
      }
    });
  }
});

test("all read entrances surface a non-ENOENT filesystem failure", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state/paseo-factory");
  mkdirSync(join(stateDir, "ledger.jsonl"), { recursive: true });
  const cli = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });
  assert.equal(cli.status, 2, cli.stdout);
  assert.match(cli.stderr, /cannot read|EISDIR/);
  assert.match(mcpStatus(stateDir).error?.message ?? "", /cannot read|EISDIR/);
  assert.throws(() => readDriverLedger(stateDir), /EISDIR/);
  assert.throws(() => Ledger.open(join(stateDir, "ledger.jsonl")), /EISDIR/);
});

test("missing and empty Ledgers remain successful empty reads across entrances", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state/paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  for (const empty of [false, true]) {
    const path = join(stateDir, "ledger.jsonl");
    if (empty) writeFileSync(path, "");
    const cli = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /no tasks yet/);
    const mcp = mcpStatus(stateDir);
    assert.equal(mcp.error, undefined);
    assert.match(mcp.result.content[0].text, /no tasks yet/);
    assert.deepEqual(readDriverLedger(stateDir), []);
    assert.equal(existsSync(path), empty);
  }
});

test("Vault plans legacy refusal without filesystem writes and retains the original source", () => {
  const moduleUrl = pathToFileURL(join(repoRoot, "src/vault.ts")).href;
  const raw = `${JSON.stringify({ ...contract, workspace: "/fixture/project", gate: "true", artifact: "out" })}\n`;
  const script = `import { reconcileVaultLedgers } from ${JSON.stringify(moduleUrl)}; try { reconcileVaultLedgers("", [{ nodeId: "remote", lines: ${JSON.stringify(raw)} }]); throw new Error("legacy history unexpectedly activated"); } catch(error) { if (!error.plan) throw error; console.log(JSON.stringify({code:error.code,status:error.plan.status,lines:error.plan.lines,source:error.plan.sources[0].lines,reasons:error.plan.conflicts.map(conflict=>conflict.reason)})); }`;
  const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${repoRoot}`, "--input-type=module", "-e", script], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.code, "history-import-conflict");
  assert.equal(refusal.status, "conflicted");
  assert.equal(refusal.lines, "");
  assert.equal(refusal.source, raw);
  assert.match(refusal.reasons.join("\n"), /explicit legacy migration/);
});

test("pure record validation recognizes legacy and supported versions without filesystem writes", () => {
  const moduleUrl = pathToFileURL(join(repoRoot, "src/ledger-validation.ts")).href;
  const values = [contract, { ...contract, schema_version: 1 }, { ...contract, schema_version: 999 }, { ...contract, seq: 0 }];
  const script = `import { isValidLedgerEvent } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(${JSON.stringify(values)}.map(value => isValidLedgerEvent(value))));`;
  const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${repoRoot}`, "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, true, false, false]);
});

test("MCP status excludes a complete-looking unterminated green event and leaves it untouched", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const bytes = `${JSON.stringify(contract)}\n${JSON.stringify({ seq: 2, ts, event: "gate_finished", task: "T1", attempt: 1, verdict: "green", exit: 0, note: "" })}`;
  writeFileSync(path, bytes);

  const response = mcpStatus(dir);

  assert.equal(response.error, undefined);
  assert.match(response.result.content[0].text, /verdict=-/);
  assert.doesNotMatch(response.result.content[0].text, /verdict=green/);
  assert.equal(readFileSync(path, "utf8"), bytes);
});


test("v2 green Gate missing its exit is corrupt at CLI, copied MCP, driver and Ledger entrances", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state/paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  const rows = [
    { seq: 1, ts, event: "contract_set", task: "T", workspace: dir, gate: "true", artifact: "out" },
    { seq: 2, ts, event: "claim_reported", task: "T", attempt: 1, sha: "abc" },
    { seq: 3, ts, event: "gate_started", task: "T", attempt: 1, cmd: "true" },
    { seq: 4, ts, event: "gate_finished", task: "T", attempt: 1, exit: 0, verdict: "green", note: "passed", sha: "abc", outputPath: "gate.log" },
  ];
  const plan = planLegacyIdentity(rows.map(row => JSON.stringify(row) + "\n").join(""), { writerId: "local" });
  assert.equal(plan.ok, true);
  const gate = plan.events.find(event => event.event === "gate_finished")! as unknown as Record<string, unknown>;
  delete gate.exit;
  const raw = plan.events.map(row => JSON.stringify(row) + "\n").join("");
  const path = join(stateDir, "ledger.jsonl");
  writeFileSync(path, raw);
  const bridge = join(dir, "bridge.mjs");
  copyFileSync(join(repoRoot, "plugin/bin/bridge.mjs"), bridge);
  const cli = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });
  assert.equal(cli.status, 2, cli.stdout);
  assert.match(cli.stderr, /line 4.*valid ledger event/);
  assert.match(mcpStatus(stateDir, bridge).error?.message ?? "", /line 4.*valid ledger event/);
  assert.throws(() => readDriverLedger(stateDir), /line 4.*valid ledger event/);
  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
  assert.equal(readFileSync(path, "utf8"), raw);
});

test("identified readers enforce each event's typed payload while legacy records retain their historical read contract", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const base = { seq: 1, ts, event: "contract_set", task: "T", workspace: dir, gate: "true", artifact: "out" };
  const cases: Array<{ row: Record<string, unknown>; required: string[]; invalid?: Record<string, unknown>[] }> = [
    { row: { ...base, scope: ["src"], freshEyes: true, watch: true, skills: ["tdd"] }, required: ["workspace", "gate", "artifact"], invalid: [{ scope: "src" }, { freshEyes: "true" }, { watch: 1 }, { skills: [5] }, { base: 5 }, { description: null }, { by: [] }, { attempt: 1 }] },
    { row: { event: "claim_reported", attempt: 1, sha: "abc" }, required: ["sha"], invalid: [{ agent: 5 }, { attempt: Number.MAX_SAFE_INTEGER + 1 }] },
    { row: { event: "gate_started", attempt: 1, cmd: "true" }, required: ["cmd"] },
    { row: { event: "gate_finished", attempt: 1, exit: 0, verdict: "green", note: "passed", sha: "abc" }, required: ["exit", "verdict", "note"], invalid: [{ exit: "0" }, { exit: 0.5 }, { verdict: "yellow" }, { sha: 4 }, { outputPath: null }] },
    { row: { event: "fresh_eyes_written", attempt: 1, model: "eye", outcome: "clear", finding: "clear", durationMs: 1 }, required: ["model", "outcome", "finding", "durationMs"], invalid: [{ outcome: "green" }, { outcome: ["clear"] }, { durationMs: -1 }] },
    { row: { event: "watch_written", attempt: 1, model: "watch", outcome: "written", durationMs: 1, answers: { safe: 0.5 }, usage: { input_tokens: 1, cost: 0 } }, required: ["model", "outcome", "durationMs"], invalid: [{ answers: [] }, { answers: { safe: 2 } }, { usage: { input_tokens: "1", cost: 0 } }, { error: 5 }, { outcome: "clear" }] },
    { row: { event: "report_written", attempt: 1, path: "report.md" }, required: ["path"] },
    { row: { event: "attempt_accepted", attempt: 1, accepted_by: "owner", landing: "landed" }, required: [], invalid: [{ accepted_by: 5 }, { landing: "maybe" }, { landingNote: 1 }] },
    { row: { event: "permit_allowed", agent: "peer", name: "Write", kind: "tool" }, required: ["name", "kind"], invalid: [{ command: 2 }] },
    { row: { event: "permit_denied", agent: "peer", name: "Write", kind: "tool", rule: "scope", reason: "outside scope" }, required: ["name", "kind", "reason"] },
    { row: { event: "git_blocked", agent: "peer", command: "git push", rule: "push", reason: "forbidden", cwd: dir, blockId: "block" }, required: ["reason"] },
    { row: { event: "spawn_dispatched", provider: "model", arity: 1, worktree: dir }, required: [], invalid: [{ worktree: 2 }] },
    { row: { event: "retro_written", model: "retro", outcome: "written", durationMs: 1, proposalsPath: "retro.md", proposalCount: 0 }, required: ["proposalsPath", "proposalCount"], invalid: [{ proposalCount: -1 }, { error: 5 }] },
  ];
  for (const fixture of cases) {
    const source = fixture.row.event === "contract_set" ? [{ ...fixture.row, seq: 1, ts }] : [base, { ...fixture.row, seq: 2, ts, ...(fixture.row.event === "retro_written" ? {} : { task: "T" }) }];
    const plan = planLegacyIdentity(source.map(row => JSON.stringify(row) + "\n").join(""), { writerId: "local" });
    assert.equal(plan.ok, true, String(fixture.row.event));
    const valid = plan.events.map(row => JSON.stringify(row) + "\n").join("");
    writeFileSync(path, valid);
    assert.doesNotThrow(() => Ledger.open(path));
    for (const change of [...fixture.required.map(key => ({ [key]: undefined })), ...(fixture.invalid ?? [])]) {
      const mutated = structuredClone(plan.events);
      Object.assign(mutated.find(event => event.event === fixture.row.event)!, change);
      writeFileSync(path, mutated.map(row => JSON.stringify(row) + "\n").join(""));
      assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"), `${fixture.row.event}: ${Object.keys(change)}`);
    }
  }
  // A historical Claim's payload was not checked by the original reader.
  writeFileSync(path, JSON.stringify(base) + "\n" + JSON.stringify({ seq: 2, ts, event: "claim_reported", task: "T", attempt: 1 }) + "\n");
  assert.equal(Ledger.open(path).events.length, 2);
});

test("CLI and copied-alone MCP status share current-epoch review and acceptance eligibility without global Task rows", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state/paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "ledger.jsonl");
  const bridge = join(dir, "bridge.mjs");
  copyFileSync(join(repoRoot, "plugin/bin/bridge.mjs"), bridge);
  const contract = { event: "contract_set", task: "T", workspace: dir, gate: "true", artifact: "out", freshEyes: true };
  const attempt = [
    { event: "claim_reported", task: "T", attempt: 1, sha: "abc" },
    { event: "gate_started", task: "T", attempt: 1, cmd: "true" },
    { event: "gate_finished", task: "T", attempt: 1, exit: 0, verdict: "green", note: "passed", sha: "abc" },
  ];
  for (const outcome of [undefined, "failed", "concern", "clear"] as const) {
    const old = [contract, ...attempt, { event: "fresh_eyes_written", task: "T", attempt: 1, model: "eye", outcome: "clear", finding: "clear", durationMs: 1 }];
    const rows = [...old, contract, ...attempt, ...(outcome === undefined ? [] : [
      { event: "fresh_eyes_written", task: "T", attempt: 1, model: "eye", outcome, finding: "review", durationMs: 1 },
      { event: "report_written", task: "T", attempt: 1, path: "report.md" },
    ]), { event: "git_blocked", command: "git push", rule: "push", reason: "no", cwd: dir, blockId: "global-block" }];
    const plan = planLegacyIdentity(rows.map((row, index) => JSON.stringify({ ...row, seq: index + 1, ts }) + "\n").join(""), { writerId: "local" });
    assert.equal(plan.ok, true);
    writeFileSync(path, plan.events.map(row => JSON.stringify(row) + "\n").join(""));
    const cli = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const text = mcpStatus(stateDir, bridge).result.content[0].text;
    assert.equal(cli.stdout.trim(), text);
    assert.equal(text.split("\n").length, 1, "schema and unbound global facts cannot create Task rows");
    assert.match(text, new RegExp(`review=${outcome ?? "pending"}(?: |$)`));
    assert.match(text, /owner-eligible=1(?: |$)/);
    assert.match(text, new RegExp(`lead-eligible=${outcome === "clear" ? "1" : "-"}(?: |$)`));
  }
});

test("v2 status refuses contradictory green Gates while valid red and historical reads remain available", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state/paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "ledger.jsonl");
  const bridge = join(dir, "bridge.mjs");
  copyFileSync(join(repoRoot, "plugin/bin/bridge.mjs"), bridge);
  const rows = [
    { seq: 1, ts, event: "contract_set", task: "T", workspace: dir, gate: "true", artifact: "out" },
    { seq: 2, ts, event: "claim_reported", task: "T", attempt: 1, sha: "abc" },
    { seq: 3, ts, event: "gate_started", task: "T", attempt: 1, cmd: "true" },
    { seq: 4, ts, event: "gate_finished", task: "T", attempt: 1, exit: 0, verdict: "green", note: "passed", sha: "abc", outputPath: "gate.log" },
  ];
  const identified = planLegacyIdentity(rows.map(row => JSON.stringify(row) + "\n").join(""), { writerId: "local" });
  assert.equal(identified.ok, true);
  for (const change of [{ exit: 7 }, { exit: null }, { sha: undefined }, { sha: "" }, { sha: "  " }]) {
    await t.test(JSON.stringify(change), () => {
      const events = structuredClone(identified.events);
      Object.assign(events.find(event => event.event === "gate_finished")!, change);
      const raw = events.map(event => JSON.stringify(event) + "\n").join("");
      writeFileSync(path, raw);
      const cli = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });
      assert.equal(cli.status, 2, cli.stdout);
      assert.equal(cli.stdout, "");
      assert.match(mcpStatus(stateDir, bridge).error?.message ?? "", /line 4.*valid ledger event/);
      assert.throws(() => readDriverLedger(stateDir), /line 4.*valid ledger event/);
      assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
      assert.equal(readFileSync(path, "utf8"), raw);
    });
  }
  for (const exit of [null, 1]) {
    const events = structuredClone(identified.events);
    Object.assign(events.find(event => event.event === "gate_finished")!, { verdict: "red", exit, sha: undefined });
    writeFileSync(path, events.map(event => JSON.stringify(event) + "\n").join(""));
    const cli = spawnSync(process.execPath, [join(repoRoot, "plugin/bin/factory.mjs"), "status", "--home", dir], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /verdict=red.*owner-eligible=- lead-eligible=-/);
    assert.match(mcpStatus(stateDir, bridge).result.content[0].text, /verdict=red/);
    assert.equal(Ledger.open(path).events.length, 5);
  }
  // Read-only legacy compatibility does not invent a repaired v2 fact.
  rows[3]!.exit = 7;
  writeFileSync(path, rows.map(event => JSON.stringify(event) + "\n").join(""));
  assert.equal(Ledger.open(path).events.length, 4);
});
