import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pluginDirFor, resolvePaseoHome, stateDirFor } from "../plugin/server/paths.ts";
import { claimCliBinDir, ensureClaimCli, ensureGitShim, injectClaimCliPath } from "../plugin/server/shell.ts";
import { Ledger } from "../plugin/server/core/ledger.ts";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";
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

test("injectClaimCliPath seeds from basePath (process.env.PATH) when request.env is an overlay without PATH", () => {
  const next = injectClaimCliPath(sessionOpenRequest("create", {}), "/state/bin", "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(
    next.env.PATH,
    "/state/bin:/opt/homebrew/bin:/usr/bin:/bin",
    "daemon overlays request.env onto process.env with Object.assign — missing request.env.PATH must preserve basePath so PATH-resolved provider CLIs (copilot, pi, opencode) do not fail with ENOENT",
  );
});

test("injectClaimCliPath leaves no empty PATH entry when neither request.env nor basePath has PATH", () => {
  const next = injectClaimCliPath(sessionOpenRequest("resume", {}), "/state/bin", "");
  assert.equal(next.env.PATH, "/state/bin");
  assert.ok(!next.env.PATH.endsWith(":") && !next.env.PATH.includes("::"), "no empty entry (CWD) on PATH");
});

test("injectClaimCliPath keeps other overlay env keys intact when seeding PATH from basePath", () => {
  const next = injectClaimCliPath(sessionOpenRequest("refresh", { CUSTOM: "1" }), "/state/bin", "/usr/bin");
  assert.equal(next.env.CUSTOM, "1");
  assert.equal(next.env.PATH, "/state/bin:/usr/bin");
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

test("ensureGitShim enforces supervisor-git-fence and lead-git-fence by PASEO_FACTORY_SEAT", (t) => {
  const dir = makeTempDir("git-shim-seat-fence-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "docs", "adr"), { recursive: true });
  mkdirSync(join(workspace, ".scratch"), { recursive: true });
  writeFileSync(join(workspace, "src", "index.ts"), "export const v = 1;\n");
  writeFileSync(join(workspace, "CONTEXT.md"), "# Context\n");
  gitCommitAll(workspace, "initial");

  const pluginDir = join(repoRoot, "plugin");
  ensureGitShim(stateDir, pluginDir, process.execPath);
  const gitWrapper = join(claimCliBinDir(stateDir), "git");
  const pathWithShim = `${claimCliBinDir(stateDir)}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`;

  const runGit = (seat: string, argv: string[]) =>
    spawnSync(gitWrapper, argv, {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, FACTORY_STATE_DIR: stateDir, PATH: pathWithShim, PASEO_FACTORY_SEAT: seat },
      timeout: 15_000,
    });

  // 1. Supervisor git fence: blocks commit, merge, cherry-pick, rebase, am, apply, stash, checkout -b/-B, switch -c/-C
  for (const argv of [
    ["commit", "-m", "supervisor coding on main"],
    ["merge", "factory/T-01"],
    ["cherry-pick", "HEAD"],
    ["rebase", "main"],
    ["am", "patch.mbox"],
    ["apply", "diff.patch"],
    ["stash"],
    ["checkout", "-b", "feat/rogue"],
    ["checkout", "-B", "feat/rogue"],
    ["switch", "-c", "feat/rogue"],
    ["switch", "-C", "feat/rogue"],
  ]) {
    const res = runGit("supervisor", argv);
    assert.equal(res.status, 126, `supervisor 'git ${argv.join(" ")}' must be blocked`);
    assert.match(res.stderr, /supervisor-git-fence/);
  }
  // Supervisor read-only git commands stay allowed
  assert.equal(runGit("supervisor", ["status", "--short"]).status, 0);

  // 2. Lead git fence: blocks committing staged product files (src/index.ts)
  writeFileSync(join(workspace, "src", "index.ts"), "export const v = 2;\n");
  assert.equal(runGit("lead", ["add", "src/index.ts"]).status, 0);
  const leadDenied = runGit("lead", ["commit", "-m", "lead editing product source"]);
  assert.equal(leadDenied.status, 126, "lead committing src/index.ts must be blocked");
  assert.match(leadDenied.stderr, /lead-git-fence/);

  // Unstage src/index.ts and restore it
  assert.equal(runGit("lead", ["reset", "HEAD", "src/index.ts"]).status, 0);
  writeFileSync(join(workspace, "src", "index.ts"), "export const v = 1;\n");

  // 3. Lead git fence: allows committing CONTEXT.md, docs/**, and .scratch/**
  writeFileSync(join(workspace, "CONTEXT.md"), "# Updated Context\n");
  writeFileSync(join(workspace, "docs", "adr", "0015.md"), "# ADR 0015\n");
  writeFileSync(join(workspace, ".scratch", "spec.md"), "# Spec\n");
  assert.equal(runGit("lead", ["add", "CONTEXT.md", "docs/adr/0015.md", ".scratch/spec.md"]).status, 0);
  const leadAllowed = runGit("lead", ["commit", "-m", "docs: update context and scratch"]);
  assert.equal(leadAllowed.status, 0, `lead committing whitelisted docs must pass: ${leadAllowed.stderr}`);

  // 4. Lead git fence: allows committing src/index.ts when MERGE_HEAD is present (settling a Landing on Accept conflict)
  const headSha = runGit("lead", ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(workspace, "src", "index.ts"), "export const v = 3;\n");
  assert.equal(runGit("lead", ["add", "src/index.ts"]).status, 0);
  writeFileSync(join(workspace, ".git", "MERGE_HEAD"), `${headSha}\n`);
  const mergeAllowed = runGit("lead", ["commit", "-m", "merge: settle landing conflict"]);
  assert.equal(mergeAllowed.status, 0, `lead settling a MERGE_HEAD conflict must pass: ${mergeAllowed.stderr}`);
});

