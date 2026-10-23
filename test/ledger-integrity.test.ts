import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger } from "../src/ledger.ts";
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

test("Vault validates imported records when filesystem writes are denied", () => {
  const moduleUrl = pathToFileURL(join(repoRoot, "src/vault.ts")).href;
  const script = `import { reconcileVaultLedgers } from ${JSON.stringify(moduleUrl)}; console.log(reconcileVaultLedgers("", [{ nodeId: "remote", lines: ${JSON.stringify(`${JSON.stringify(contract)}\n`)} }]));`;
  const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${repoRoot}`, "--input-type=module", "-e", script], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), contract);
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
