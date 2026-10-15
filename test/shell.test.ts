import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginDirFor, resolvePaseoHome, stateDirFor } from "../plugin/server/paths.ts";
import { claimCliBinDir, ensureClaimCli, ensureGitShim, injectClaimCliPath } from "../plugin/server/shell.ts";
import { Ledger } from "../plugin/server/core/ledger.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";

const sessionOpenRequest = (reason: PluginSessionOpenRequest["reason"], env: Record<string, string>): PluginSessionOpenRequest => ({
  agentId: "a1",
  workspaceId: null,
  provider: "pi",
  cwd: "/repo",
  reason,
  purpose: "interactive",
  env,
});

test("resolvePaseoHome follows PASEO_HOME, expands ~, defaults to <home>/.paseo", () => {
  const home = "/Users/test";
  assert.equal(resolvePaseoHome({ PASEO_HOME: "/custom/home" }, home), "/custom/home");
  assert.equal(resolvePaseoHome({ PASEO_HOME: "~/trial" }, home), join(home, "trial"));
  assert.equal(resolvePaseoHome({ PASEO_HOME: "  " }, home), join(home, ".paseo"));
  assert.equal(resolvePaseoHome({}, home), join(home, ".paseo"));
});

test("stateDirFor is the per-plugin state root under the daemon home", () => {
  assert.equal(stateDirFor("/custom/home"), join("/custom/home", "plugin-state", "paseo-factory"));
});

test("pluginDirFor reads the install path the daemon recorded in config.json", (t) => {
  const home = makeTempDir();
  disposeDir(t, home);
  const writeConfig = (body: string): void => writeFileSync(join(home, "config.json"), body);

  writeConfig(JSON.stringify({ plugins: { "paseo-factory": { source: "directory", path: "/somewhere/plugin", enabled: true } } }));
  assert.equal(pluginDirFor(home), "/somewhere/plugin");

  writeConfig(JSON.stringify({ plugins: { "paseo-factory": { source: "npm", path: "/x" } } }));
  assert.equal(pluginDirFor(home), undefined, "non-directory installs expose no directory");

  writeConfig("{ not json");
  assert.equal(pluginDirFor(home), undefined, "garbage config degrades to undefined, never throws");

  assert.equal(pluginDirFor(join(home, "missing")), undefined, "missing config file");
});

test("injectClaimCliPath prepends the bin dir without touching the rest of the request", () => {
  const request = sessionOpenRequest("create", { PATH: "/usr/bin:/bin", HOME: "/Users/test" });

  const next = injectClaimCliPath(request, "/state/bin");
  assert.notEqual(next, request);
  assert.equal(next.env.PATH, "/state/bin:/usr/bin:/bin");
  assert.equal(next.env.HOME, "/Users/test");
  assert.equal(next.agentId, "a1");

  const again = injectClaimCliPath(next, "/state/bin");
  assert.equal(again, next, "idempotent — no duplicate entry on repeated launches");
});

test("injectClaimCliPath leaves no empty PATH entry when the agent had none", () => {
  const next = injectClaimCliPath(sessionOpenRequest("resume", {}), "/state/bin");
  assert.equal(next.env.PATH, "/state/bin");
  assert.ok(!next.env.PATH.endsWith(":") && !next.env.PATH.includes("::"), "no empty entry (CWD) on PATH");
});

test("injectClaimCliPath keeps an explicit missing-PATH env shape intact", () => {
  const next = injectClaimCliPath(sessionOpenRequest("refresh", { CUSTOM: "1" }), "/state/bin");
  assert.equal(next.env.CUSTOM, "1");
  assert.equal(next.env.PATH, "/state/bin");
});

test("ensureClaimCli writes an executable wrapper around the daemon's node", (t) => {
  const stateDir = makeTempDir();
  disposeDir(t, stateDir);
  const pluginDir = join(stateDir, "plugin-source");
  mkdirSync(join(pluginDir, "bin"), { recursive: true });

  ensureClaimCli(stateDir, pluginDir, "/daemon/node");

  const wrapper = join(claimCliBinDir(stateDir), "factory-claim");
  assert.ok(existsSync(wrapper), "wrapper exists at <stateDir>/bin/factory-claim");
  const body = readFileSync(wrapper, "utf8");
  assert.match(body, /^#!\/bin\/sh\n/);
  assert.match(
    body,
    /ELECTRON_RUN_AS_NODE=1 FACTORY_STATE_DIR='[^']*' exec '\/daemon\/node' '.*factory-claim\.mjs' "\$@"\n$/,
  );
  assert.ok(body.includes(shellQuoteFor(stateDir)), "the wrapper bakes in this daemon's state dir");
  const stat = statSync(wrapper);
  assert.equal(stat.mode & 0o111, 0o111, "wrapper is executable");

  // A changed node binary rewrites the wrapper (daemon updates move node).
  ensureClaimCli(stateDir, pluginDir, "/daemon/node-new");
  assert.match(readFileSync(wrapper, "utf8"), /'\/daemon\/node-new'/);
});

function shellQuoteFor(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

test("the vendored core appends one fsynced JSONL line like the root core", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ledger = Ledger.open(join(dir, "ledger.jsonl"));

  const evt = ledger.append({ event: "contract_set", task: "T1", workspace: "/tmp/ws", gate: "npm test", artifact: "src/format.ts" });

  assert.equal(evt.seq, 1);
  const { ts, ...rest } = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8")) as { ts?: string };
  assert.match(String(ts), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rest, {
    seq: 1,
    event: "contract_set",
    task: "T1",
    workspace: "/tmp/ws",
    gate: "npm test",
    artifact: "src/format.ts",
  });
});

test("plugin/server/core is a byte-exact copy of src/ (run npm run sync:plugin-core after editing the core)", () => {
  const srcDir = join(repoRoot, "src");
  const coreDir = join(repoRoot, "plugin", "server", "core");
  const sources = readdirSync(srcDir).filter((name) => name.endsWith(".ts")).sort();
  const copies = readdirSync(coreDir).filter((name) => name.endsWith(".ts")).sort();
  assert.deepEqual(copies, sources, "same file set in src/ and plugin/server/core/");
  for (const name of sources) {
    assert.equal(
      readFileSync(join(coreDir, name), "utf8"),
      readFileSync(join(srcDir, name), "utf8"),
      `plugin/server/core/${name} differs from src/${name}`,
    );
  }
});

test("ensureGitShim generates the git wrapper beside factory-claim, rewriting only on change", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const pluginDir = join(repoRoot, "plugin");

  ensureGitShim(stateDir, pluginDir, "/daemon/node");
  const target = join(claimCliBinDir(stateDir), "git");
  const body = readFileSync(target, "utf8");
  assert.match(body, /^#!\/bin\/sh/);
  assert.match(body, /FACTORY_STATE_DIR=/);
  assert.match(body, /git-shim\.mjs/);
  assert.equal(statSync(target).mode & 0o111, 0o111, "executable");

  const mtimeBefore = statSync(target).mtimeMs;
  ensureGitShim(stateDir, pluginDir, "/daemon/node");
  assert.equal(statSync(target).mtimeMs, mtimeBefore, "unchanged content is not rewritten");

  ensureGitShim(stateDir, pluginDir, "/daemon/node-v2");
  assert.match(readFileSync(target, "utf8"), /daemon\/node-v2/, "a moved node binary moves the wrapper");
});

test("the agent PATH surface is exactly factory-claim and the git shim — the factory CLI never rides it (US17's mechanical half)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const pluginDir = join(repoRoot, "plugin");

  // Both wrappers the plugin's session_open hook ever generates.
  ensureClaimCli(stateDir, pluginDir, "/daemon/node");
  ensureGitShim(stateDir, pluginDir, "/daemon/node");
  assert.deepEqual(
    readdirSync(claimCliBinDir(stateDir)).sort(),
    ["factory-claim", "git"],
    "the one dir injectClaimCliPath puts on every agent's PATH holds exactly the claim CLI and the git shim — never the Owner CLI (factory.mjs), whose every wrapper would be an orchestration door",
  );
  // And the wrapper that IS there points at factory-claim.mjs, not factory.mjs.
  assert.match(readFileSync(join(claimCliBinDir(stateDir), "factory-claim"), "utf8"), /factory-claim\.mjs/);
});
