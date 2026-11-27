import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../src/index.ts";
import {
  FACTORY_SETUP_CANONICAL_ORDER,
  FACTORY_SETUP_COMPANION_IDS,
  FACTORY_SETUP_MAX_ACTIONS,
  FACTORY_SETUP_MAX_DIAGNOSTIC_CHARS,
  FACTORY_SETUP_MAX_HELPER_MCP_NAME_CHARS,
  FACTORY_SETUP_MAX_REASON_CHARS,
  FACTORY_SETUP_RECOVERED_APPLYING_ERROR,
  FACTORY_SETUP_TIER1_COMPANIONS,
  FACTORY_SETUP_TIER2_COMPANIONS,
  appendSetupAudit,
  canonicalizeSetupActions,
  classifySetupActionTier,
  classifySetupBundleTier,
  clearSetupAudit,
  clearSetupProposal,
  computeSetupActionsHash,
  isValidGitBranchRef,
  isValidSetupBranchName,
  readSetupAudit,
  readSetupProposal,
  recoverInterruptedSetupProposal,
  scrubSetupDiagnostic,
  setupAuditPath,
  setupProposalPath,
  validateFactorySetupInput,
  writeSetupProposal,
} from "../src/factory-setup.ts";
import type { FactorySetupAction, SetupAuditEntry, SetupProposalRecord } from "../src/factory-setup.ts";
import { FactoryError } from "../src/errors.ts";
import { resolveProject } from "../src/project.ts";
import {
  COMPANION_CATALOG,
  COMPANION_TOOLS_CATALOG,
  CORE_PLUGIN_ENTRY,
  MANAGEABLE_PLUGIN_IDS,
  MANAGEABLE_TOOL_IDS,
} from "../plugin/shared/companions.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createLeadMailRuntime } from "../plugin/server/lead-mailbox.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

function makeProposal(overrides: Partial<SetupProposalRecord> = {}): SetupProposalRecord {
  const actions: FactorySetupAction[] = canonicalizeSetupActions(
    overrides.actions ?? [
      { kind: "install_companion", id: "factory-release-lab" },
      { kind: "set_store_release_mode", mode: "on-request" },
    ],
  );
  return {
    schemaVersion: 1,
    id: "prop-1",
    actionsHash: computeSetupActionsHash(actions),
    projectSlug: "alpha",
    status: "pending",
    reason: "Enable iOS & Android store staging",
    actions,
    steps: actions.map((action, index) => ({
      index,
      action,
      tier: classifySetupActionTier(action),
      status: "pending",
    })),
    createdAt: "2026-11-26T10:00:00.000Z",
    updatedAt: "2026-11-26T10:00:00.000Z",
    ...overrides,
  };
}

function makeFakeSurfaceForCleanup(t: TestContext, agents: Array<{ id: string; labels?: Record<string, string>; status?: string; cwd?: string }> = []) {
  const dir = makeTempDir("paseo-setup-rpc-");
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async (options) => {
        const filter = options?.filter;
        const kept = agents.filter((agent) => {
          if (filter?.labels !== undefined) {
            for (const [k, v] of Object.entries(filter.labels)) {
              if (agent.labels?.[k] !== v) return false;
            }
          }
          return true;
        });
        return {
          entries: kept.map((agent) => ({
            agent: {
              id: agent.id,
              provider: "pi/zai/glm-5.3",
              title: null,
              status: agent.status ?? "idle",
              model: null,
              labels: agent.labels ?? {},
              archivedAt: null,
              requiresAttention: false,
              attentionReason: null,
              updatedAt: "2026-11-26T00:00:00.000Z",
              cwd: agent.cwd ?? dir,
            },
          })),
          pageInfo: {},
        };
      },
      create: async () => ({ id: "agent-created-1" }),
      ref: (id) => ({
        send: async () => {},
        archive: async () => {
          const idx = agents.findIndex((a) => a.id === id);
          if (idx !== -1) agents.splice(idx, 1);
          return { archivedAt: new Date().toISOString() };
        },
        timeline: { refetch: async () => ({ entries: [{ seqEnd: 0 }] }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "pi", available: true }] }),
      listModels: async () => ({ models: [] }),
    },
  };
  let leadMail!: ReturnType<typeof createLeadMailRuntime>;
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon,
    usagePaths: { userHome: dir, stateDir },
    stopAgent: async () => ({ ok: true }),
    onLeadRetired: (input) => leadMail.settleLeadRotation(input.slug),
    handoff: (input) => leadMail.handoff(input),
    handoffPending: (slug) => leadMail.hasPendingHandoff(slug),
    onSeatKickoffSent: (input) => leadMail.markKickoffSent(input.agentId),
    isSeatStarted: (agent) => leadMail.isSeatStarted(agent),
    rotateProjectMailbox: (slug) => leadMail.rotateProjectMailbox(slug),
  });
  leadMail = createLeadMailRuntime({
    factory,
    stateDir,
    daemon,
    ensureLead: (input) => handlers.leadEnsure(input),
    retireLead: (input) => handlers.leadRotate(input),
  });
  t.after(() => leadMail.stop());
  return { dir, home, stateDir, factory, handlers };
}

function makeGitRepo(t: TestContext, name: string): string {
  const repo = makeTempDir(`paseo-setup-repo-${name}-`);
  disposeDir(t, repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# test\n");
  gitCommitAll(repo, "init");
  return repo;
}

// 1. Companion parity with plugin/shared/companions.ts
test("companion whitelist constants stay in exact parity with plugin/shared/companions.ts", () => {
  const expectedTier1 = COMPANION_TOOLS_CATALOG.map((c) => c.id).sort();
  const expectedTier2 = COMPANION_CATALOG.map((c) => c.id).sort();
  const expectedAll = [...expectedTier1, ...expectedTier2].sort();

  assert.deepEqual([...FACTORY_SETUP_TIER1_COMPANIONS].sort(), expectedTier1);
  assert.deepEqual([...FACTORY_SETUP_TIER2_COMPANIONS].sort(), expectedTier2);
  assert.deepEqual([...FACTORY_SETUP_COMPANION_IDS].sort(), expectedAll);

  assert.equal(expectedAll.includes(CORE_PLUGIN_ENTRY.id as never), false, "paseo-factory core excluded");
  for (const id of FACTORY_SETUP_TIER1_COMPANIONS) {
    assert.equal(MANAGEABLE_TOOL_IDS.has(id), true);
  }
  for (const id of FACTORY_SETUP_TIER2_COMPANIONS) {
    assert.equal(MANAGEABLE_PLUGIN_IDS.has(id), true);
  }
});

// 2. Whitelist rejection (setup-action-forbidden)
test("install_companion rejects core plugin, arbitrary git/npm/https URLs, and unknown IDs with setup-action-forbidden", () => {
  const forbiddenIds = [
    "paseo-factory",
    "git:daymanondev/factory-release-lab:plugin",
    "https://github.com/evil/plugin.git",
    "http://example.com/pkg.tgz",
    "npm:evil-pkg",
    "../local-plugin",
    "unknown-companion",
  ];
  for (const id of forbiddenIds) {
    assert.throws(
      () => validateFactorySetupInput([{ kind: "vault_hydrate" }, { kind: "install_companion", id }], "Need companion"),
      (err: unknown) =>
        err instanceof FactoryError &&
        err.code === "setup-action-forbidden" &&
        err.message.startsWith("actions[1]: "),
      `Expected setup-action-forbidden for ${id}`,
    );
  }
});

// 3. Tier classification
test("classifySetupActionTier & classifySetupBundleTier classify Tier 1 vs Tier 2 accurately (set_helper_mcp is Tier 2)", () => {
  assert.equal(classifySetupActionTier({ kind: "vault_hydrate" }), 1);
  assert.equal(classifySetupActionTier({ kind: "set_skill_pack", pack: "expo", enabled: true }), 1);
  assert.equal(classifySetupActionTier({ kind: "sync_open_design", projectId: "proj_1" }), 1);
  assert.equal(classifySetupActionTier({ kind: "install_companion", id: "factory-skills-pack" }), 1);

  assert.equal(classifySetupActionTier({ kind: "install_companion", id: "factory-release-lab" }), 2);
  assert.equal(classifySetupActionTier({ kind: "set_release_mode", mode: "on-request" }), 2);
  assert.equal(classifySetupActionTier({ kind: "set_store_release_mode", mode: "auto-staging" }), 2);
  assert.equal(classifySetupActionTier({ kind: "set_helper_mcp", name: "exa", enabled: true }), 2);

  // All Tier 1 -> 1
  assert.equal(
    classifySetupBundleTier([
      { kind: "vault_hydrate" },
      { kind: "install_companion", id: "factory-skills-pack" },
      { kind: "set_skill_pack", pack: "expo", enabled: true },
      { kind: "sync_open_design", projectId: "od-1" },
    ]),
    1,
  );

  // Mixed Tier 1 + Tier 2 -> 2
  assert.equal(
    classifySetupBundleTier([
      { kind: "vault_hydrate" },
      { kind: "set_skill_pack", pack: "expo", enabled: true },
      { kind: "set_helper_mcp", name: "exa", enabled: true },
    ]),
    2,
  );
});

// 4. Per-index validation, reason rules, strict git branch ref, safeId, flat MCP compatibility & conflict checks
test("validateFactorySetupInput enforces bounds, reason rules, flat MCP compatibility, per-index errors, and conflict rules", () => {
  // Bounds on actions
  assert.throws(() => validateFactorySetupInput("not-an-array", "ok"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-actions");
  assert.throws(() => validateFactorySetupInput([], "ok"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-actions");
  const seventeen = Array.from({ length: FACTORY_SETUP_MAX_ACTIONS + 1 }, (_, i) => ({
    kind: "set_skill_pack",
    pack: `pack-${i}`,
    enabled: true,
  }));
  assert.throws(() => validateFactorySetupInput(seventeen, "too many"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-actions");

  // Exactly 16 actions is allowed
  const sixteen = Array.from({ length: FACTORY_SETUP_MAX_ACTIONS }, (_, i) => ({
    kind: "set_skill_pack",
    pack: `pack-${i}`,
    enabled: true,
  }));
  assert.equal(validateFactorySetupInput(sixteen, "sixteen ok").actions.length, 16);

  // Reason rules
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], 123), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], "   "), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], "\x00\x01  "), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], "para1\n\npara2"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], "para1\r\n   \r\npara2"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], "a\r\rb"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], "a\n\x00\nb"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.throws(() => validateFactorySetupInput([{ kind: "vault_hydrate" }], "a\n\u0085\nb"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason");
  assert.equal(validateFactorySetupInput([{ kind: "vault_hydrate" }], "a\nb").reason, "a b");
  assert.throws(
    () => validateFactorySetupInput([{ kind: "vault_hydrate" }], "a".repeat(FACTORY_SETUP_MAX_REASON_CHARS + 1)),
    (e: unknown) => e instanceof FactoryError && e.code === "invalid-setup-reason",
  );

  const validReasonRes = validateFactorySetupInput(
    [{ kind: "vault_hydrate" }],
    "  hello\x00\x1bworld\nwith\tsingle break  ",
  );
  assert.equal(validReasonRes.reason, "helloworld with single break");
  assert.equal(
    validateFactorySetupInput([{ kind: "vault_hydrate" }], "x".repeat(FACTORY_SETUP_MAX_REASON_CHARS)).reason.length,
    500,
  );

  // Per-index errors on malformed elements
  assert.throws(
    () => validateFactorySetupInput([null], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );
  assert.throws(
    () => validateFactorySetupInput([{ kind: "vault_hydrate" }, { kind: "unknown_kind" }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[1]: "),
  );

  // Flat MCP object compatibility: undefined extraneous keys stripped, defined non-null extraneous keys rejected
  const flatValidated = validateFactorySetupInput(
    [
      {
        kind: "set_skill_pack",
        pack: "expo",
        enabled: true,
        id: undefined,
        mode: undefined,
        branch: undefined,
        name: undefined,
        projectId: undefined,
      },
      {
        kind: "set_release_mode",
        mode: "auto",
        branch: undefined,
        pack: undefined,
      },
    ],
    "Enable expo and auto release",
  );
  assert.deepEqual(flatValidated.actions, [
    { kind: "set_skill_pack", pack: "expo", enabled: true },
    { kind: "set_release_mode", mode: "auto" },
  ]);

  assert.throws(
    () => validateFactorySetupInput([{ kind: "vault_hydrate", unexpected: "value" }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );

  // set_release_mode branch validation (strict git check-ref-format --branch)
  for (const goodBranch of ["main", "release/v1.0", "feat_1-2", "v2.0.1"]) {
    assert.equal(isValidGitBranchRef(goodBranch), true, `good branch ${goodBranch}`);
    assert.equal(isValidSetupBranchName(goodBranch), true);
    const res = validateFactorySetupInput([{ kind: "set_release_mode", mode: "on-request", branch: goodBranch }], "ok");
    assert.deepEqual(res.actions[0], { kind: "set_release_mode", mode: "on-request", branch: goodBranch });
  }
  const nullBranchRes = validateFactorySetupInput([{ kind: "set_release_mode", mode: "off", branch: null }], "clear branch");
  assert.deepEqual(nullBranchRes.actions[0], { kind: "set_release_mode", mode: "off", branch: null });

  const badBranches = [
    "",
    " ",
    " main",
    "main ",
    "a b",
    "a\x00b",
    "a\nb",
    "-bad",
    "@",
    "HEAD",
    "a@{b",
    "a..b",
    "a\\b",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "/main",
    "main/",
    "a//b",
    "main.",
    ".hidden",
    "a/.hidden",
    "main.lock",
    "a/b.lock/c",
  ];
  for (const bad of badBranches) {
    assert.equal(isValidGitBranchRef(bad), false, `expected invalid branch: ${JSON.stringify(bad)}`);
    assert.throws(
      () => validateFactorySetupInput([{ kind: "set_release_mode", mode: "auto", branch: bad }], "ok"),
      (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
    );
  }

  // set_store_release_mode
  assert.throws(
    () => validateFactorySetupInput([{ kind: "set_store_release_mode", mode: "auto-production" }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );

  // set_skill_pack safeId + boolean
  for (const badPack of ["../escape", ".hidden", "a/b", "", "expo "]) {
    assert.throws(
      () => validateFactorySetupInput([{ kind: "set_skill_pack", pack: badPack, enabled: true }], "ok"),
      (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
    );
  }
  assert.throws(
    () => validateFactorySetupInput([{ kind: "set_skill_pack", pack: "expo", enabled: "true" }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );

  // set_helper_mcp name rules + boolean
  assert.throws(
    () => validateFactorySetupInput([{ kind: "set_helper_mcp", name: "   ", enabled: true }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );
  assert.throws(
    () => validateFactorySetupInput([{ kind: "set_helper_mcp", name: "bad\x00name", enabled: true }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );
  assert.throws(
    () =>
      validateFactorySetupInput(
        [{ kind: "set_helper_mcp", name: "x".repeat(FACTORY_SETUP_MAX_HELPER_MCP_NAME_CHARS + 1), enabled: true }],
        "ok",
      ),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );
  assert.throws(
    () => validateFactorySetupInput([{ kind: "set_helper_mcp", name: "exa", enabled: 1 }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );
  const helperRes = validateFactorySetupInput(
    [{ kind: "set_helper_mcp", name: "  exa  ", enabled: false }],
    "Disable exa",
  );
  assert.deepEqual(helperRes.actions[0], { kind: "set_helper_mcp", name: "exa", enabled: false });

  // sync_open_design safeId
  assert.throws(
    () => validateFactorySetupInput([{ kind: "sync_open_design", projectId: "../bad" }], "ok"),
    (e: unknown) => e instanceof FactoryError && e.message.startsWith("actions[0]: "),
  );

  // Duplicate & contradictory targets across all 7 kinds
  const conflictBundles: FactorySetupAction[][] = [
    [{ kind: "vault_hydrate" }, { kind: "vault_hydrate" }],
    [
      { kind: "install_companion", id: "factory-release-lab" },
      { kind: "install_companion", id: "factory-release-lab" },
    ],
    [
      { kind: "set_release_mode", mode: "on-request" },
      { kind: "set_release_mode", mode: "auto" },
    ],
    [
      { kind: "set_store_release_mode", mode: "on-request" },
      { kind: "set_store_release_mode", mode: "off" },
    ],
    [
      { kind: "set_skill_pack", pack: "expo", enabled: true },
      { kind: "set_skill_pack", pack: "expo", enabled: false },
    ],
    [
      { kind: "set_helper_mcp", name: "exa", enabled: true },
      { kind: "set_helper_mcp", name: "exa", enabled: false },
    ],
    [
      { kind: "sync_open_design", projectId: "proj-a" },
      { kind: "sync_open_design", projectId: "proj-b" },
    ],
  ];
  for (const bundle of conflictBundles) {
    assert.throws(
      () => validateFactorySetupInput(bundle, "conflicting"),
      (e: unknown) =>
        e instanceof FactoryError &&
        e.code === "setup-action-conflict" &&
        e.message.startsWith("actions[1]: "),
    );
  }
});

// 5. Canonical ordering & deterministic actionsHash
test("canonicalizeSetupActions sorts in dependency order with deterministic tie-breakers & actionsHash", () => {
  assert.deepEqual([...FACTORY_SETUP_CANONICAL_ORDER], [
    "vault_hydrate",
    "install_companion",
    "set_release_mode",
    "set_store_release_mode",
    "set_skill_pack",
    "set_helper_mcp",
    "sync_open_design",
  ]);

  const inputA: FactorySetupAction[] = [
    { kind: "sync_open_design", projectId: "design-1" },
    { kind: "set_helper_mcp", name: "zendesk", enabled: true },
    { kind: "set_helper_mcp", name: "chrome-devtools", enabled: false },
    { kind: "set_skill_pack", pack: "science", enabled: true },
    { kind: "set_skill_pack", pack: "expo", enabled: true },
    { kind: "set_store_release_mode", mode: "on-request" },
    { kind: "set_release_mode", mode: "auto", branch: "main" },
    { kind: "install_companion", id: "factory-skills-pack" },
    { kind: "install_companion", id: "factory-release-lab" },
    { kind: "vault_hydrate" },
  ];
  const inputB = [...inputA].reverse();

  const canonA = canonicalizeSetupActions(inputA);
  const canonB = canonicalizeSetupActions(inputB);

  assert.deepEqual(canonA, canonB);
  assert.deepEqual(
    canonA.map((a) =>
      a.kind === "install_companion"
        ? `${a.kind}:${a.id}`
        : a.kind === "set_skill_pack"
          ? `${a.kind}:${a.pack}`
          : a.kind === "set_helper_mcp"
            ? `${a.kind}:${a.name}`
            : a.kind,
    ),
    [
      "vault_hydrate",
      "install_companion:factory-release-lab",
      "install_companion:factory-skills-pack",
      "set_release_mode",
      "set_store_release_mode",
      "set_skill_pack:expo",
      "set_skill_pack:science",
      "set_helper_mcp:chrome-devtools",
      "set_helper_mcp:zendesk",
      "sync_open_design",
    ],
  );

  // Key-order independent SHA-256 hex digest
  const hashA = computeSetupActionsHash(inputA);
  const hashB = computeSetupActionsHash([
    { enabled: true, pack: "expo", kind: "set_skill_pack" } as FactorySetupAction,
    { branch: "main", mode: "auto", kind: "set_release_mode" } as FactorySetupAction,
  ]);
  const hashC = computeSetupActionsHash([
    { kind: "set_release_mode", mode: "auto", branch: "main" },
    { kind: "set_skill_pack", pack: "expo", enabled: true },
  ]);
  assert.match(hashA, /^[a-f0-9]{64}$/);
  assert.equal(hashB, hashC);

  // Sensitive to any field change
  const hashD = computeSetupActionsHash([
    { kind: "set_release_mode", mode: "on-request", branch: "main" },
    { kind: "set_skill_pack", pack: "expo", enabled: true },
  ]);
  assert.notEqual(hashC, hashD);
});

// 6. scrubSetupDiagnostic
test("scrubSetupDiagnostic strips ANSI/control chars, redacts secrets, and caps at <= 500 chars", () => {
  const dirty =
    "\x1b[31mError\x1b[0m: Bearer supersecrettoken123 https://user:pass123@example.com/hook?token=xyz999 " +
    "ghp_1234567890abcdef123456 ASC_KEY_SECRET=\"abc+def\" " +
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  const scrubbed = scrubSetupDiagnostic(dirty);
  assert.equal(scrubbed.includes("\x1b"), false);
  assert.equal(scrubbed.includes("supersecrettoken123"), false);
  assert.equal(scrubbed.includes("pass123"), false);
  assert.equal(scrubbed.includes("xyz999"), false);
  assert.equal(scrubbed.includes("ghp_1234567890abcdef123456"), false);
  assert.equal(scrubbed.includes("abc+def"), false);
  assert.equal(scrubbed.includes("MIIEowIBAAKCAQEA"), false);

  const huge = "x".repeat(800);
  const capped = scrubSetupDiagnostic(huge);
  assert.equal(capped.length, FACTORY_SETUP_MAX_DIAGNOSTIC_CHARS);
  assert.equal(capped.endsWith("…"), true);

  // Truncated multi-line PEM private keys (missing -----END ... PRIVATE KEY-----)
  const truncatedRsa = scrubSetupDiagnostic(
    "Error reading key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretline1\nsecretline2",
  );
  assert.equal(truncatedRsa, "Error reading key: [REDACTED_PRIVATE_KEY]");
  const truncatedEc = scrubSetupDiagnostic(
    "-----BEGIN EC PRIVATE KEY-----\r\nMHcCAQEEIPsecret\r\nmoresecret",
  );
  assert.equal(truncatedEc, "[REDACTED_PRIVATE_KEY]");

  // User-only URL credentials redacted without breaking normal email/text
  const tokenUrl = scrubSetupDiagnostic(
    "remote: https://my_secret_pat_value@github.com/org/repo.git contact ops@example.com",
  );
  assert.equal(tokenUrl.includes("my_secret_pat_value"), false);
  assert.equal(tokenUrl, "remote: https://[REDACTED]@github.com/org/repo.git contact ops@example.com");

  // UTF-16 surrogate pairs are never split on truncation
  const emojiHuge = "😀".repeat(260);
  const emojiCapped = scrubSetupDiagnostic(emojiHuge);
  assert.ok(emojiCapped.length <= FACTORY_SETUP_MAX_DIAGNOSTIC_CHARS);
  assert.equal(emojiCapped, `${"😀".repeat(249)}…`);
  assert.equal(Buffer.from(emojiCapped, "utf8").toString("utf8"), emojiCapped);

  const tightSurrogate = scrubSetupDiagnostic("😀a", 2);
  assert.equal(tightSurrogate, "…");
  assert.equal(Buffer.from(tightSurrogate, "utf8").toString("utf8"), tightSurrogate);
});

// 7. Atomic setup-proposal.json persistence & out-of-ledger check
test("setup-proposal.json persists atomically outside ledger.jsonl, refuses damaged files, and clears cleanly", (t) => {
  const stateDir = makeTempDir("paseo-setup-state-");
  disposeDir(t, stateDir);

  assert.throws(() => setupProposalPath(stateDir, "../bad"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-project-slug");
  assert.equal(readSetupProposal(stateDir, "alpha"), undefined);

  const proposal1 = makeProposal({
    steps: [
      {
        index: 0,
        action: { kind: "install_companion", id: "factory-release-lab" },
        tier: 2,
        status: "pending",
        summary: "Bearer topsecrettoken123 " + "a".repeat(600),
      },
      {
        index: 1,
        action: { kind: "set_store_release_mode", mode: "on-request" },
        tier: 2,
        status: "pending",
      },
    ],
  });
  const saved = writeSetupProposal(stateDir, "alpha", proposal1);
  assert.equal(saved.steps[0].summary?.includes("topsecrettoken123"), false);
  assert.ok((saved.steps[0].summary?.length ?? 0) <= FACTORY_SETUP_MAX_DIAGNOSTIC_CHARS);

  const loaded = readSetupProposal(stateDir, "alpha");
  assert.deepEqual(loaded, saved);
  assert.equal(existsSync(join(stateDir, "projects", "alpha", "ledger.jsonl")), false, "ledger.jsonl must not be touched");

  // Overwrite pending with failed/new proposal
  const proposal2 = makeProposal({ id: "prop-2", status: "failed" });
  writeSetupProposal(stateDir, "alpha", proposal2);
  assert.equal(readSetupProposal(stateDir, "alpha")?.id, "prop-2");

  // Clear returns true then false
  assert.equal(clearSetupProposal(stateDir, "alpha"), true);
  assert.equal(clearSetupProposal(stateDir, "alpha"), false);
  assert.equal(readSetupProposal(stateDir, "alpha"), undefined);

  // Corrupt JSON or wrong schemaVersion refuses with setup-proposal-invalid
  mkdirSync(join(stateDir, "projects", "alpha"), { recursive: true });
  writeFileSync(setupProposalPath(stateDir, "alpha"), "{broken");
  assert.throws(
    () => readSetupProposal(stateDir, "alpha"),
    (e: unknown) => e instanceof FactoryError && e.code === "setup-proposal-invalid",
  );
  writeFileSync(setupProposalPath(stateDir, "alpha"), JSON.stringify({ ...proposal1, schemaVersion: 2 }));
  assert.throws(
    () => readSetupProposal(stateDir, "alpha"),
    (e: unknown) => e instanceof FactoryError && e.code === "setup-proposal-invalid",
  );
});

// 8. "applying" boot & lazy recovery
test("recoverInterruptedSetupProposal recovers orphaned applying proposals into failed while preserving active runs", (t) => {
  const stateDir = makeTempDir("paseo-setup-recover-");
  disposeDir(t, stateDir);

  assert.equal(recoverInterruptedSetupProposal(stateDir, "alpha"), undefined);

  const actions: FactorySetupAction[] = canonicalizeSetupActions([
    { kind: "install_companion", id: "factory-release-lab" },
    { kind: "set_release_mode", mode: "on-request" },
    { kind: "set_store_release_mode", mode: "on-request" },
  ]);
  const applying = makeProposal({
    id: "prop-applying",
    status: "applying",
    actions,
    steps: [
      { index: 0, action: actions[0], tier: 2, status: "done", summary: "Installed" },
      { index: 1, action: actions[1], tier: 2, status: "pending" },
      { index: 2, action: actions[2], tier: 2, status: "pending" },
    ],
  });
  writeSetupProposal(stateDir, "alpha", applying);

  // Active in-memory run (Set or Map) leaves status: "applying" untouched
  const activeSet = new Set(["alpha"]);
  assert.equal(recoverInterruptedSetupProposal(stateDir, "alpha", activeSet)?.status, "applying");
  const activeMap = new Map([["alpha", "prop-applying"]]);
  assert.equal(recoverInterruptedSetupProposal(stateDir, "alpha", activeMap)?.status, "applying");

  // Orphaned applying (empty activeProposalRuns) recovers to failed
  const recovered = recoverInterruptedSetupProposal(
    stateDir,
    "alpha",
    new Set(),
    () => "2026-11-26T12:34:56.000Z",
  );
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.updatedAt, "2026-11-26T12:34:56.000Z");
  assert.equal(recovered?.steps[0].status, "done");
  assert.equal(recovered?.steps[1].status, "failed");
  assert.equal(recovered?.steps[1].error, FACTORY_SETUP_RECOVERED_APPLYING_ERROR);
  assert.equal(recovered?.steps[2].status, "skipped");
  assert.deepEqual(readSetupProposal(stateDir, "alpha"), recovered);

  // Pending / failed proposals remain untouched
  const pending = makeProposal({ id: "prop-pending", status: "pending" });
  writeSetupProposal(stateDir, "alpha", pending);
  assert.deepEqual(recoverInterruptedSetupProposal(stateDir, "alpha", new Set()), pending);
});

test("SetupProposalRecord optional supervisorHandoffAgentId persists, validates, and survives interrupted applying recovery", (t) => {
  const stateDir = makeTempDir("paseo-setup-handoff-id-");
  disposeDir(t, stateDir);

  const withoutId = writeSetupProposal(stateDir, "alpha", makeProposal({ id: "prop-no-id" }));
  assert.equal("supervisorHandoffAgentId" in withoutId, false);
  assert.equal("supervisorHandoffAgentId" in (readSetupProposal(stateDir, "alpha") ?? {}), false);

  const withId = writeSetupProposal(
    stateDir,
    "alpha",
    makeProposal({ id: "prop-with-id", status: "applying", supervisorHandoffAgentId: "sup-claude-1" }),
  );
  assert.equal(withId.supervisorHandoffAgentId, "sup-claude-1");
  assert.equal(readSetupProposal(stateDir, "alpha")?.supervisorHandoffAgentId, "sup-claude-1");

  const recovered = recoverInterruptedSetupProposal(
    stateDir,
    "alpha",
    new Set(),
    () => "2026-11-26T13:00:00.000Z",
  );
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.supervisorHandoffAgentId, "sup-claude-1");
  assert.equal(readSetupProposal(stateDir, "alpha")?.supervisorHandoffAgentId, "sup-claude-1");

  for (const badId of ["", "   ", 123, null]) {
    writeFileSync(
      setupProposalPath(stateDir, "alpha"),
      JSON.stringify({ ...withId, supervisorHandoffAgentId: badId }),
    );
    assert.throws(
      () => readSetupProposal(stateDir, "alpha"),
      (e: unknown) => e instanceof FactoryError && e.code === "setup-proposal-invalid",
    );
  }
});

// 9. setup-audit.jsonl append/read/clear
test("setup-audit.jsonl appends durably (0o600), scrubs step diagnostics, refuses corrupt lines, and clears cleanly", (t) => {
  const stateDir = makeTempDir("paseo-setup-audit-");
  disposeDir(t, stateDir);

  assert.throws(() => setupAuditPath(stateDir, "../bad"), (e: unknown) => e instanceof FactoryError && e.code === "invalid-project-slug");
  assert.deepEqual(readSetupAudit(stateDir, "alpha"), []);

  const entry1: SetupAuditEntry = {
    timestamp: "2026-11-26T10:00:00.000Z",
    projectSlug: "alpha",
    tier: 1,
    actor: "supervisor",
    reason: "Hydrate vault runtime and enable expo pack",
    steps: [
      {
        index: 0,
        action: { kind: "vault_hydrate" },
        tier: 1,
        status: "done",
        summary: "Hydrated with GITHUB_TOKEN=ghp_secret1234567890",
      },
    ],
  };
  const entry2: SetupAuditEntry = {
    timestamp: "2026-11-26T10:05:00.000Z",
    projectSlug: "alpha",
    proposalId: "prop-2",
    actionsHash: computeSetupActionsHash([{ kind: "set_store_release_mode", mode: "on-request" }]),
    tier: 2,
    actor: "owner-approved",
    reason: "Enable store release",
    steps: [
      {
        index: 0,
        action: { kind: "set_store_release_mode", mode: "on-request" },
        tier: 2,
        status: "done",
      },
    ],
  };

  appendSetupAudit(stateDir, "alpha", entry1);
  appendSetupAudit(stateDir, "alpha", entry2);

  if (process.platform !== "win32") {
    const mode = statSync(setupAuditPath(stateDir, "alpha")).mode & 0o777;
    assert.equal(mode & 0o077, 0, "setup-audit.jsonl must not be group/world accessible");
  }

  const read = readSetupAudit(stateDir, "alpha");
  assert.equal(read.length, 2);
  assert.equal(read[0].actor, "supervisor");
  assert.equal(read[0].steps[0].summary?.includes("ghp_secret1234567890"), false);
  assert.equal(read[1].actor, "owner-approved");
  assert.equal(read[1].proposalId, "prop-2");

  // Clear
  assert.equal(clearSetupAudit(stateDir, "alpha"), true);
  assert.equal(clearSetupAudit(stateDir, "alpha"), false);
  assert.deepEqual(readSetupAudit(stateDir, "alpha"), []);

  // Corrupt JSONL refuses with setup-audit-invalid
  mkdirSync(join(stateDir, "projects", "alpha"), { recursive: true });
  writeFileSync(setupAuditPath(stateDir, "alpha"), "{broken\n");
  assert.throws(
    () => readSetupAudit(stateDir, "alpha"),
    (e: unknown) => e instanceof FactoryError && e.code === "setup-audit-invalid",
  );
});

// 10. surface-rpc.ts projectRotate and projectReset cleanup
test("surface-rpc.ts projectRotate drops setup-proposal.json while keeping setup-audit.jsonl; projectReset drops both without touching siblings", async (t) => {
  const repoA = makeGitRepo(t, "alpha");
  const repoB = makeGitRepo(t, "beta");

  const runningPeers: Array<{ id: string; labels?: Record<string, string>; status?: string; cwd?: string }> = [];
  const { stateDir, factory, handlers } = makeFakeSurfaceForCleanup(t, runningPeers);

  const projA = resolveProject(repoA);
  const projB = resolveProject(repoB);
  assert.equal(projA.ok, true);
  assert.equal(projB.ok, true);
  if (!projA.ok || !projB.ok) throw new Error("expected valid git repos");
  await handlers.snapshot({ projectRoot: repoA });
  await handlers.snapshot({ projectRoot: repoB });

  const seedBoth = (slug: string) => {
    writeSetupProposal(stateDir, slug, makeProposal({ projectSlug: slug }));
    appendSetupAudit(stateDir, slug, {
      timestamp: "2026-11-26T10:00:00.000Z",
      projectSlug: slug,
      tier: 1,
      actor: "supervisor",
      reason: "Seed audit",
      steps: [{ index: 0, action: { kind: "vault_hydrate" }, tier: 1, status: "done" }],
    });
  };

  seedBoth(projA.slug);
  seedBoth(projB.slug);

  // Refused projectRotate (seat-cannot-rotate & peers-live) leaves both files intact
  const seatRefused = await handlers.projectRotate({ projectRoot: repoA, seat: "supervisor" });
  assert.equal(seatRefused.ok, false);
  assert.equal(seatRefused.code, "seat-cannot-rotate");
  assert.ok(readSetupProposal(stateDir, projA.slug) !== undefined, "seat-refused rotate keeps proposal");
  assert.equal(readSetupAudit(stateDir, projA.slug).length, 1, "seat-refused rotate keeps audit");

  factory.ledger.append({
    event: "contract_set",
    task: "T1",
    workspace: projA.root,
    gate: "npm test",
    artifact: "README.md",
    base: "HEAD",
    scope: ["README.md"],
    description: "In-flight task",
  });
  factory.ledger.append({ event: "spawn_dispatched", task: "T1", provider: "pi/zai/glm-5.3", arity: 1 });
  runningPeers.push({ id: "peer-1", status: "running", cwd: projA.root, labels: { project: projA.slug, task: "T1", role: "agent" } });
  const refusedRotate = await handlers.projectRotate({ projectRoot: repoA });
  assert.equal(refusedRotate.ok, false);
  assert.equal(refusedRotate.code, "peers-live");
  assert.ok(readSetupProposal(stateDir, projA.slug) !== undefined, "refused rotate keeps proposal");
  assert.equal(readSetupAudit(stateDir, projA.slug).length, 1, "refused rotate keeps audit");
  runningPeers.length = 0;
  factory.ledger.append({ event: "task_closed", task: "T1", outcome: "abandoned", reason: "done testing refusal" });

  // Successful projectRotate clears setup-proposal.json and preserves setup-audit.jsonl
  const rotated = await handlers.projectRotate({ projectRoot: repoA });
  assert.ok(rotated.ok, JSON.stringify(rotated));
  assert.equal(readSetupProposal(stateDir, projA.slug), undefined, "projectRotate clears setup-proposal.json");
  assert.equal(readSetupAudit(stateDir, projA.slug).length, 1, "projectRotate preserves setup-audit.jsonl");

  // Re-seed and test projectReset({ keepSeats: true })
  writeSetupProposal(stateDir, projA.slug, makeProposal({ projectSlug: projA.slug }));
  const resetKeepSeats = await handlers.projectReset({ projectRoot: repoA, keepSeats: true });
  assert.ok(resetKeepSeats.ok, JSON.stringify(resetKeepSeats));
  assert.equal(readSetupProposal(stateDir, projA.slug), undefined, "projectReset(keepSeats) clears setup-proposal.json");
  assert.deepEqual(readSetupAudit(stateDir, projA.slug), [], "projectReset(keepSeats) clears setup-audit.jsonl");

  // Re-seed and test full projectReset
  seedBoth(projA.slug);
  const resetFull = await handlers.projectReset({ projectRoot: repoA });
  assert.ok(resetFull.ok, JSON.stringify(resetFull));
  assert.equal(readSetupProposal(stateDir, projA.slug), undefined, "projectReset clears setup-proposal.json");
  assert.deepEqual(readSetupAudit(stateDir, projA.slug), [], "projectReset clears setup-audit.jsonl");

  // Sibling project untouched
  assert.ok(readSetupProposal(stateDir, projB.slug) !== undefined, "sibling proposal preserved");
  assert.equal(readSetupAudit(stateDir, projB.slug).length, 1, "sibling audit preserved");
});

// 11. Pure core boundary & core sync & index barrel exports
test("src/factory-setup.ts has zero plugin/@getpaseo/import.meta usage, matches plugin/server/core copy, and is exported by src/index.ts", () => {
  const srcSource = readFileSync(join(repoRoot, "src", "factory-setup.ts"), "utf8");
  const coreCopy = readFileSync(join(repoRoot, "plugin", "server", "core", "factory-setup.ts"), "utf8");

  assert.equal(srcSource, coreCopy, "plugin/server/core/factory-setup.ts must match src/factory-setup.ts verbatim");
  assert.equal(/from\s+["'](?:\.\.\/plugin|@getpaseo\/)/.test(srcSource), false, "zero plugin/@getpaseo imports");
  assert.equal(/import\.meta/.test(srcSource), false, "zero import.meta usage");

  // Spot-check barrel exports on src/index.ts
  assert.equal(core.validateFactorySetupInput, validateFactorySetupInput);
  assert.equal(core.canonicalizeSetupActions, canonicalizeSetupActions);
  assert.equal(core.classifySetupActionTier, classifySetupActionTier);
  assert.equal(core.classifySetupBundleTier, classifySetupBundleTier);
  assert.equal(core.computeSetupActionsHash, computeSetupActionsHash);
  assert.equal(core.recoverInterruptedSetupProposal, recoverInterruptedSetupProposal);
  assert.equal(core.scrubSetupDiagnostic, scrubSetupDiagnostic);
  assert.equal(core.FACTORY_SETUP_COMPANION_IDS, FACTORY_SETUP_COMPANION_IDS);
});
