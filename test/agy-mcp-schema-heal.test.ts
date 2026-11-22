import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalog } from "../src/mcp/catalog.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

const HOOK_BIN = resolve(import.meta.dirname, "../plugin/bin/agy-pre-tool-hook.mjs");
const ALLOWED_AGY_PROTO_KEYS = new Set(["decision", "reason", "permissionOverrides", "overwrite"]);

function runHook(
  payload: unknown,
  env: Record<string, string | undefined>,
  options: { hookPath?: string; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string; output: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [options.hookPath ?? HOOK_BIN], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    cwd: options.cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  const output = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  const unknown = Object.keys(output).filter((k) => !ALLOWED_AGY_PROTO_KEYS.has(k));
  assert.deepEqual(unknown, [], `unexpected protojson keys: ${unknown.join(", ")}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output };
}

function assertHealedSchemaMatchesCatalog(schemaPath: string, toolName: string): void {
  assert.equal(existsSync(schemaPath), true, `expected ${schemaPath} to exist`);
  const parsed = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const expectedTool = catalog.tools[toolName];
  assert.ok(expectedTool, `unknown catalog tool in test: ${toolName}`);
  assert.deepEqual(parsed, {
    name: expectedTool.name,
    description: expectedTool.description,
    parameters: expectedTool.inputSchema,
  });
  assert.equal("_meta" in parsed, false, "internal _meta must not appear in on-disk schema");
}

test("agy-pre-tool-hook self-heals missing schemas for supervisor, lead, and agent across CLI and IDE paths", (t) => {
  const dir = makeTempDir("agy-schema-roles-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");

  const cases = [
    { seat: "supervisor", appDir: "antigravity-cli", toolName: "supervisor_dispatch_lead" },
    { seat: "supervisor", appDir: "antigravity", toolName: "supervisor_accept_task" },
    { seat: "lead", appDir: "antigravity-cli", toolName: "lead_merge" },
    { seat: "lead", appDir: "antigravity", toolName: "lead_set_contract" },
    { seat: "agent", appDir: "antigravity-cli", toolName: "agent_claim" },
    { seat: "agent", appDir: "antigravity", toolName: "agent_escalate_blocker" },
  ] as const;

  for (const { seat, appDir, toolName } of cases) {
    const schemaPath = join(homeDir, ".gemini", appDir, "mcp", "paseo-factory_paseo_factory", `${toolName}.json`);
    assert.equal(existsSync(schemaPath), false, `precondition: ${schemaPath} absent`);

    const res = runHook(
      {
        toolCall: { name: "read_file", args: { Path: schemaPath } },
        workspacePaths: [workspaceDir],
      },
      {
        HOME: homeDir,
        PASEO_FACTORY_SEAT: seat,
        PASEO_FACTORY_STATE_DIR: stateDir,
        PASEO_FACTORY_PROJECT_ROOT: workspaceDir,
      },
    );

    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.output.decision, "allow");
    assertHealedSchemaMatchesCatalog(schemaPath, toolName);
  }
});

test("agy-pre-tool-hook supports read_file, view_file, nested/flat payloads, and all path keys", (t) => {
  const dir = makeTempDir("agy-schema-shapes-");
  disposeDir(t, dir);
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");

  const leadTools = [
    { toolCallName: "read_file", key: "Path", format: "nestedArgs", schemaTool: "lead_set_contract" },
    { toolCallName: "view_file", key: "AbsolutePath", format: "nestedArgs", schemaTool: "lead_dispatch_agent" },
    { toolCallName: "read_file", key: "TargetFile", format: "nestedArguments", schemaTool: "lead_verify" },
    { toolCallName: "view_file", key: "file_path", format: "flatToolInput", schemaTool: "lead_merge" },
    { toolCallName: "read_file", key: "filePath", format: "flatToolInputCamel", schemaTool: "lead_update_notebook" },
    { toolCallName: "view_file", key: "path", format: "flatInput", schemaTool: "lead_read_ledger" },
  ] as const;

  for (const entry of leadTools) {
    const caseHome = join(dir, `home-${entry.key}-${entry.format}`);
    const schemaPath = join(caseHome, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory", `${entry.schemaTool}.json`);
    const argsObj = { [entry.key]: schemaPath };
    let payload: unknown;
    if (entry.format === "nestedArgs") {
      payload = { toolCall: { name: entry.toolCallName, args: argsObj }, workspacePaths: [workspaceDir] };
    } else if (entry.format === "nestedArguments") {
      payload = { toolCall: { name: entry.toolCallName, arguments: argsObj }, workspacePaths: [workspaceDir] };
    } else if (entry.format === "flatToolInput") {
      payload = { tool_name: entry.toolCallName, tool_input: argsObj, cwd: workspaceDir };
    } else if (entry.format === "flatToolInputCamel") {
      payload = { toolName: entry.toolCallName, toolInput: argsObj, cwd: workspaceDir };
    } else {
      payload = { name: entry.toolCallName, input: argsObj, cwd: workspaceDir };
    }

    const res = runHook(payload, {
      HOME: caseHome,
      PASEO_FACTORY_SEAT: "lead",
      PASEO_FACTORY_STATE_DIR: stateDir,
      PASEO_FACTORY_PROJECT_ROOT: workspaceDir,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.output.decision, "allow");
    assertHealedSchemaMatchesCatalog(schemaPath, entry.schemaTool);
  }
});

test("agy-pre-tool-hook heals via correlation-resolved seat when PASEO_FACTORY_SEAT is unset", (t) => {
  const dir = makeTempDir("agy-schema-corr-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "correlations.json"),
    JSON.stringify([{ correlationId: "corr-lead-1", role: "lead", projectRoot: workspaceDir, projectSlug: "demo" }]),
  );

  const schemaPath = join(homeDir, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory", "lead_close_task.json");
  const res = runHook(
    { toolCall: { name: "read_file", args: { Path: schemaPath } } },
    {
      HOME: homeDir,
      PASEO_FACTORY_CORRELATION: "corr-lead-1",
      PASEO_FACTORY_STATE_DIR: stateDir,
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.output.decision, "allow");
  assertHealedSchemaMatchesCatalog(schemaPath, "lead_close_task");
});

test("agy-pre-tool-hook schema healing is strictly additive and never overwrites or prunes sibling schemas", (t) => {
  const dir = makeTempDir("agy-schema-additive-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");
  const serverDir = join(homeDir, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory");
  mkdirSync(serverDir, { recursive: true });

  const siblingAgentSchema = join(serverDir, "agent_claim.json");
  const existingLeadSchema = join(serverDir, "lead_set_contract.json");
  const siblingSentinel = '{"sentinel":"keep-agent"}';
  const existingSentinel = '{"sentinel":"keep-existing-lead"}';
  writeFileSync(siblingAgentSchema, siblingSentinel);
  writeFileSync(existingLeadSchema, existingSentinel);

  // Reading existing schema must not overwrite it
  const resExisting = runHook(
    { toolCall: { name: "read_file", args: { Path: existingLeadSchema } }, workspacePaths: [workspaceDir] },
    { HOME: homeDir, PASEO_FACTORY_SEAT: "lead", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(resExisting.output.decision, "allow");
  assert.equal(readFileSync(existingLeadSchema, "utf8"), existingSentinel);

  // Healing missing lead_merge.json must leave both existing and sibling files untouched
  const missingLeadSchema = join(serverDir, "lead_merge.json");
  const resMissing = runHook(
    { toolCall: { name: "read_file", args: { Path: missingLeadSchema } }, workspacePaths: [workspaceDir] },
    { HOME: homeDir, PASEO_FACTORY_SEAT: "lead", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(resMissing.output.decision, "allow");
  assertHealedSchemaMatchesCatalog(missingLeadSchema, "lead_merge");
  assert.equal(readFileSync(siblingAgentSchema, "utf8"), siblingSentinel);
  assert.equal(readFileSync(existingLeadSchema, "utf8"), existingSentinel);
});

test("agy-pre-tool-hook enforces role fences and path safety: cross-role, unknown, traversal, and non-MCP paths write nothing", (t) => {
  const dir = makeTempDir("agy-schema-negatives-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");
  const serverDir = join(homeDir, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory");

  const negatives = [
    { seat: "agent", target: join(serverDir, "lead_merge.json"), desc: "agent cannot heal lead schema" },
    { seat: "agent", target: join(serverDir, "supervisor_dispatch_lead.json"), desc: "agent cannot heal supervisor schema" },
    { seat: "supervisor", target: join(serverDir, "agent_claim.json"), desc: "supervisor cannot heal agent schema" },
    { seat: "supervisor", target: join(serverDir, "lead_merge.json"), desc: "supervisor cannot heal lead schema" },
    { seat: "lead", target: join(serverDir, "supervisor_dispatch_lead.json"), desc: "lead cannot heal supervisor schema" },
    { seat: "lead", target: join(serverDir, "agent_claim.json"), desc: "lead cannot heal agent schema" },
    { seat: "lead", target: join(serverDir, "factory_status.json"), desc: "lead cannot heal unbound schema" },
    { seat: "lead", target: join(serverDir, "unknown_tool.json"), desc: "unknown tool writes nothing" },
    { seat: "lead", target: `${serverDir}/../paseo-factory_paseo_factory/lead_merge.json`, desc: "traversal (..) rejected" },
    { seat: "lead", target: `${serverDir}/sub/lead_merge.json`, desc: "nested subpath rejected" },
    { seat: "lead", target: join(serverDir, "lead_merge.txt"), desc: "non-.json extension rejected" },
    { seat: "lead", target: join(homeDir, ".gemini", "antigravity-cli", "mcp", "other_server", "lead_merge.json"), desc: "unrelated MCP server rejected" },
    { seat: "lead", target: join(homeDir, ".gemini", "antigravity-ide", "mcp", "paseo-factory_paseo_factory", "lead_merge.json"), desc: "unrelated antigravity-ide dir rejected" },
    { seat: "lead", target: join(workspaceDir, "lead_merge.json"), desc: "non-MCP workspace path rejected" },
    { seat: "lead", target: "lead_merge.json", desc: "relative path rejected" },
  ];

  for (const { seat, target, desc } of negatives) {
    const res = runHook(
      { toolCall: { name: "read_file", args: { Path: target } }, workspacePaths: [workspaceDir] },
      { HOME: homeDir, PASEO_FACTORY_SEAT: seat, PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
    );
    assert.equal(res.status, 0, `${desc}: ${res.stderr}`);
    assert.equal(res.output.decision, "allow", desc);
  }

  assert.equal(existsSync(join(homeDir, ".gemini")), false, "no .gemini directory or file should be created for rejected requests");
  assert.equal(existsSync(join(workspaceDir, "lead_merge.json")), false, "non-MCP workspace target must not be created");
});

test("agy-pre-tool-hook preserves unbound non-factory fast-path without reading stdin or touching disk", (t) => {
  const dir = makeTempDir("agy-schema-unbound-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const schemaPath = join(homeDir, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory", "lead_merge.json");

  const res = runHook(
    { toolCall: { name: "read_file", args: { Path: schemaPath } } },
    { HOME: homeDir },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.output.decision, "allow");
  assert.equal(existsSync(join(homeDir, ".gemini")), false, "unbound fast-path must never create .gemini files");
});

test("agy-pre-tool-hook fails open with allow when schema directory is unwritable or blocked by a file", (t) => {
  const dir = makeTempDir("agy-schema-failopen-");
  disposeDir(t, dir);
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");

  // Case A: unwritable server directory
  const homeReadOnly = join(dir, "home-ro");
  const serverDir = join(homeReadOnly, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory");
  mkdirSync(serverDir, { recursive: true });
  chmodSync(serverDir, 0o555);
  t.after(() => {
    try {
      chmodSync(serverDir, 0o755);
    } catch {
      // ignore
    }
  });

  const roTarget = join(serverDir, "lead_merge.json");
  const resRo = runHook(
    { toolCall: { name: "read_file", args: { Path: roTarget } }, workspacePaths: [workspaceDir] },
    { HOME: homeReadOnly, PASEO_FACTORY_SEAT: "lead", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(resRo.status, 0, resRo.stderr);
  assert.equal(resRo.output.decision, "allow");
  assert.deepEqual(readdirSync(serverDir), [], "no stray temp files left in unwritable directory");

  // Case B: parent path blocked by regular file (ENOTDIR on mkdirSync)
  const homeBlocked = join(dir, "home-blocked");
  mkdirSync(homeBlocked, { recursive: true });
  writeFileSync(join(homeBlocked, ".gemini"), "blocker-file");
  const blockedTarget = join(homeBlocked, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory", "lead_merge.json");
  const resBlocked = runHook(
    { toolCall: { name: "read_file", args: { Path: blockedTarget } }, workspacePaths: [workspaceDir] },
    { HOME: homeBlocked, PASEO_FACTORY_SEAT: "lead", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(resBlocked.status, 0, resBlocked.stderr);
  assert.equal(resBlocked.output.decision, "allow");
});

test("agy-pre-tool-hook works when copied alone into an empty directory with zero relative imports", (t) => {
  const dir = makeTempDir("agy-schema-standalone-");
  disposeDir(t, dir);
  const standaloneDir = join(dir, "bin");
  mkdirSync(standaloneDir, { recursive: true });
  const copiedHook = join(standaloneDir, "agy-pre-tool-hook.mjs");
  copyFileSync(HOOK_BIN, copiedHook);
  assert.deepEqual(readdirSync(standaloneDir), ["agy-pre-tool-hook.mjs"]);

  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");
  const schemaPath = join(homeDir, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory", "supervisor_dispatch_lead.json");

  const res = runHook(
    { toolCall: { name: "read_file", args: { Path: schemaPath } }, workspacePaths: [workspaceDir] },
    {
      HOME: homeDir,
      NODE_PATH: "",
      PASEO_FACTORY_SEAT: "supervisor",
      PASEO_FACTORY_STATE_DIR: stateDir,
      PASEO_FACTORY_PROJECT_ROOT: workspaceDir,
    },
    { hookPath: copiedHook, cwd: standaloneDir },
  );

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.output.decision, "allow");
  assertHealedSchemaMatchesCatalog(schemaPath, "supervisor_dispatch_lead");
});

test("agy-pre-tool-hook self-heals per-session mcp/paseo_factory schemas across CLI and IDE paths while enforcing role and path fences", (t) => {
  const dir = makeTempDir("agy-schema-persession-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");

  const validCases = [
    { seat: "supervisor", appDir: "antigravity-cli", toolName: "supervisor_dispatch_lead" },
    { seat: "supervisor", appDir: "antigravity", toolName: "supervisor_accept_task" },
    { seat: "lead", appDir: "antigravity-cli", toolName: "lead_merge" },
    { seat: "lead", appDir: "antigravity", toolName: "lead_set_contract" },
    { seat: "agent", appDir: "antigravity-cli", toolName: "agent_claim" },
    { seat: "agent", appDir: "antigravity", toolName: "agent_escalate_blocker" },
  ] as const;

  for (const { seat, appDir, toolName } of validCases) {
    const schemaPath = join(homeDir, ".gemini", appDir, "mcp", "paseo_factory", `${toolName}.json`);
    assert.equal(existsSync(schemaPath), false, `precondition: ${schemaPath} absent`);

    const res = runHook(
      {
        toolCall: { name: "read_file", args: { Path: schemaPath } },
        workspacePaths: [workspaceDir],
      },
      {
        HOME: homeDir,
        PASEO_FACTORY_SEAT: seat,
        PASEO_FACTORY_STATE_DIR: stateDir,
        PASEO_FACTORY_PROJECT_ROOT: workspaceDir,
      },
    );

    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.output.decision, "allow");
    assertHealedSchemaMatchesCatalog(schemaPath, toolName);
  }

  // Negative checks under per-session paseo_factory directory
  const negHome = join(dir, "neg-home");
  const perSessionCliDir = join(negHome, ".gemini", "antigravity-cli", "mcp", "paseo_factory");
  const negatives = [
    { seat: "agent", target: join(perSessionCliDir, "lead_merge.json"), desc: "agent cannot heal lead schema under paseo_factory" },
    { seat: "supervisor", target: join(perSessionCliDir, "agent_claim.json"), desc: "supervisor cannot heal agent schema under paseo_factory" },
    { seat: "lead", target: join(perSessionCliDir, "supervisor_dispatch_lead.json"), desc: "lead cannot heal supervisor schema under paseo_factory" },
    { seat: "lead", target: join(perSessionCliDir, "unknown_tool.json"), desc: "unknown tool rejected under paseo_factory" },
    { seat: "lead", target: `${perSessionCliDir}/../paseo_factory/lead_merge.json`, desc: "traversal rejected under paseo_factory" },
    { seat: "lead", target: join(negHome, ".gemini", "antigravity-ide", "mcp", "paseo_factory", "lead_merge.json"), desc: "unrelated antigravity-ide rejected under paseo_factory" },
  ];
  for (const { seat, target, desc } of negatives) {
    const res = runHook(
      { toolCall: { name: "read_file", args: { Path: target } }, workspacePaths: [workspaceDir] },
      { HOME: negHome, PASEO_FACTORY_SEAT: seat, PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
    );
    assert.equal(res.status, 0, `${desc}: ${res.stderr}`);
    assert.equal(res.output.decision, "allow", desc);
  }
  assert.equal(existsSync(join(negHome, ".gemini")), false, "rejected paseo_factory requests create nothing");
});

test("agy-pre-tool-hook heals all missing role schemas on list_dir / find_by_name / shell ls after peer overwrite without pruning siblings", (t) => {
  const dir = makeTempDir("agy-schema-dir-cmd-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");
  const serverDir = join(homeDir, ".gemini", "antigravity-cli", "mcp", "paseo-factory_paseo_factory");
  mkdirSync(serverDir, { recursive: true });

  // Simulate a Peer having just connected and wiped the dir down to Peer tools only.
  const peerClaim = join(serverDir, "agent_claim.json");
  const peerSentinel = '{"sentinel":"keep-peer-claim"}';
  writeFileSync(peerClaim, peerSentinel);

  // 1. Supervisor inspects the directory with list_dir -> heals all Supervisor schemas, keeps Peer file untouched.
  const listRes = runHook(
    { toolCall: { name: "list_dir", args: { DirectoryPath: serverDir } }, workspacePaths: [workspaceDir] },
    { HOME: homeDir, PASEO_FACTORY_SEAT: "supervisor", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(listRes.status, 0, listRes.stderr);
  assert.equal(listRes.output.decision, "allow");
  for (const toolName of catalog.roles.supervisor) {
    assertHealedSchemaMatchesCatalog(join(serverDir, `${toolName}.json`), toolName);
  }
  assert.equal(readFileSync(peerClaim, "utf8"), peerSentinel, "list_dir heal must not overwrite sibling Peer schema");
  assert.equal(existsSync(join(serverDir, "lead_set_contract.json")), false, "supervisor list_dir must never create lead schemas");

  // 2. Lead inspects the directory with shell `ls -la` -> heals all Lead schemas, keeps existing Supervisor & Peer files untouched.
  const lsRes = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: `ls -la ${serverDir}` } }, workspacePaths: [workspaceDir] },
    { HOME: homeDir, PASEO_FACTORY_SEAT: "lead", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(lsRes.status, 0, lsRes.stderr);
  assert.equal(lsRes.output.decision, "allow");
  for (const toolName of catalog.roles.lead) {
    assertHealedSchemaMatchesCatalog(join(serverDir, `${toolName}.json`), toolName);
  }
  assert.equal(readFileSync(peerClaim, "utf8"), peerSentinel, "shell ls heal must not overwrite sibling Peer schema");
});

test("agy-pre-tool-hook warms missing allowed schema on call_mcp_tool and skips healing on denied commands", (t) => {
  const dir = makeTempDir("agy-schema-call-deny-");
  disposeDir(t, dir);
  const homeDir = join(dir, "home");
  const workspaceDir = join(dir, "workspace");
  const stateDir = join(dir, "state");
  const mcpRoot = join(homeDir, ".gemini", "antigravity-cli", "mcp");
  const serverDir = join(mcpRoot, "paseo-factory_paseo_factory");
  mkdirSync(serverDir, { recursive: true });

  // Denied shell command referencing the server dir must be denied and write nothing.
  const denyRes = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: `git push origin main && ls ${serverDir}` } }, workspacePaths: [workspaceDir] },
    { HOME: homeDir, PASEO_FACTORY_SEAT: "supervisor", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(denyRes.status, 0, denyRes.stderr);
  assert.equal(denyRes.output.decision, "deny");
  assert.deepEqual(readdirSync(serverDir), [], "denied command must not heal schemas");

  // call_mcp_tool warms the called role-allowed tool schema on disk.
  const callRes = runHook(
    {
      toolCall: {
        name: "call_mcp_tool",
        args: { ServerName: "paseo-factory_paseo_factory", ToolName: "supervisor_dispatch_lead", Arguments: { message: "go" } },
      },
      workspacePaths: [workspaceDir],
    },
    { HOME: homeDir, PASEO_FACTORY_SEAT: "supervisor", PASEO_FACTORY_STATE_DIR: stateDir, PASEO_FACTORY_PROJECT_ROOT: workspaceDir },
  );
  assert.equal(callRes.status, 0, callRes.stderr);
  assert.equal(callRes.output.decision, "allow");
  assertHealedSchemaMatchesCatalog(join(serverDir, "supervisor_dispatch_lead.json"), "supervisor_dispatch_lead");
  assert.equal(existsSync(join(serverDir, "lead_set_contract.json")), false);
});
