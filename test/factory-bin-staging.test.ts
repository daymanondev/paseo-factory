import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureFactoryBinScripts, factoryBinImportClosure } from "../src/agy-home.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

const pluginBin = join(repoRoot, "plugin", "bin");

test("factoryBinImportClosure follows static, side-effect and dynamic ./*.mjs imports transitively and skips missing files", (t) => {
  const dir = makeTempDir("bin-closure-");
  disposeDir(t, dir);
  writeFileSync(join(dir, "entry.mjs"), 'import * as a from "./a.mjs";\nimport "./side.mjs";\nconst lazy = () => import("./lazy.mjs");\nimport { x } from "./missing.mjs";\nimport fs from "node:fs";\n');
  writeFileSync(join(dir, "a.mjs"), "import { b } from './b.mjs';\n");
  writeFileSync(join(dir, "b.mjs"), 'export * from "./a.mjs";\n');
  writeFileSync(join(dir, "side.mjs"), "");
  writeFileSync(join(dir, "lazy.mjs"), "");
  writeFileSync(join(dir, "unrelated.mjs"), "");
  assert.deepEqual(factoryBinImportClosure(dir, ["entry.mjs"]).sort(), ["a.mjs", "b.mjs", "entry.mjs", "lazy.mjs", "side.mjs"]);
});

test("staged bridge and hook are zero-relative-import self-contained ESM scripts in <stateDir>/bin (immune to sibling .mjs drift)", (t) => {
  const stateDir = makeTempDir("bin-staging-");
  disposeDir(t, stateDir);
  ensureFactoryBinScripts(stateDir, join(repoRoot, "plugin"));
  const binDir = join(stateDir, "bin");
  const staged = readdirSync(binDir).filter((name) => name.endsWith(".mjs"));
  for (const name of ["bridge.mjs", "agy-pre-tool-hook.mjs"]) {
    assert.ok(staged.includes(name), `${name} is staged into <stateDir>/bin`);
    const relativeImports = [...readFileSync(join(binDir, name), "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']\.\/([\w.-]+\.mjs)["']/g)];
    assert.deepEqual(relativeImports.map((m) => m[1]), [], `${name} must have zero relative ./*.mjs imports`);
  }
});

test("the staged Supervisor bridge loads and lists its MCP tools (it died with ERR_MODULE_NOT_FOUND before v0.8.4)", (t) => {
  const stateDir = makeTempDir("bin-bridge-live-");
  disposeDir(t, stateDir);
  mkdirSync(stateDir, { recursive: true });
  ensureFactoryBinScripts(stateDir, join(repoRoot, "plugin"));
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "staging-test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  const run = spawnSync(process.execPath, [join(stateDir, "bin", "bridge.mjs"), "--role", "supervisor", "--state-dir", stateDir], {
    input: frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, PASEO_FACTORY_SEAT: "", PASEO_FACTORY_ROLE: "" },
  });
  assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND/, run.stderr);
  const replies = run.stdout.split("\n").filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } });
  const tools = replies.find((reply) => reply.id === 2)?.result?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(tools.includes("supervisor_dispatch_lead"), `supervisor_dispatch_lead is listed (got ${JSON.stringify(tools)}; stderr ${run.stderr.slice(0, 400)})`);
});

test("plugin/bin still carries every module the closure names (a renamed import fails here, not in a live seat)", () => {
  for (const name of factoryBinImportClosure(pluginBin, ["bridge.mjs", "agy-pre-tool-hook.mjs"])) {
    assert.ok(existsSync(join(pluginBin, name)), name);
  }
});
