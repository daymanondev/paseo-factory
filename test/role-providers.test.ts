import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { writeProjectRegistration } from "../plugin/server/projects.ts";
import {
  FACTORY_ROLE_PROVIDERS,
  effectiveLanesForReconcile,
  healFactoryRoleProvidersInConfig,
  reconcilePaseoConfigObject,
  reconcilePaseoRoleProviders,
} from "../src/role-providers.ts";
import { projectLanesPath, saveLanes } from "../src/lanes.ts";
import type { Lanes } from "../src/lanes.ts";
import { laneProviderConfig } from "../plugin/server/provider-lanes.ts";
import { disposeDir, fakeCopilotRunner, gitCommitAll, makeTempDir, writeLanes } from "./helpers.ts";

/**
 * The Role Provider Reconciliation seam (v0.0.27, ADR 0017 §1, spec §Testing
 * Decisions seam 1): realistic `<paseoHome>/config.json` payloads — including
 * the 29 orphaned `sw2-*` profiles the removed seatworks-v2 install left in
 * the live trace — reconciled into the three native role providers
 * (`factory-supervisor`, `factory-lead`, `factory-peer`) and the single
 * `Supervisor (Factory)` picker profile, against a temp home on disk (never
 * `~/.paseo` or `~/.paseo-factory`).
 */

// ---- the realistic config payload — the live trace's shape ------------------------------

const SW2_ROLES = ["supervisor", "lead", "peer", "reviewer", "watcher", "pager"] as const;
const SW2_HARNESSES = ["claude", "codex", "pi", "omp", "opencode"] as const;

/** The 29 orphaned picker profiles of the removed seatworks-v2 install (the live trace's exact vocabulary). */
function sw2Profiles(): { id: string; name: string; provider: string; model: string; modeId?: string; thinkingOptionId?: string }[] {
  const profiles: { id: string; name: string; provider: string; model: string; modeId?: string; thinkingOptionId?: string }[] = [];
  for (const role of SW2_ROLES) {
    for (const harness of SW2_HARNESSES) {
      if (role === "pager" && (harness === "omp" || harness === "opencode")) continue; // the live set never had these two
      profiles.push({
        id: `sw2-${role}-${harness}`,
        name: `${role.charAt(0).toUpperCase()}${role.slice(1)} · ${harness} (sw2)`,
        provider: `sw2-${role}-${harness}`,
        model: harness === "claude" ? "claude-opus-5" : harness === "codex" ? "gpt-5.5" : harness === "pi" ? "zai/glm-5.3" : "glm-5.1",
        ...(harness === "claude" ? { modeId: "bypassPermissions" } : {}),
        ...(harness === "claude" || harness === "codex" || harness === "pi" ? { thinkingOptionId: "high" } : {}),
      });
    }
  }
  profiles.push({ id: "sw2-designer-agy", name: "Designer · Antigravity (sw2)", provider: "sw2-designer-agy", model: "gemini-3-pro" });
  return profiles;
}

/** A `<paseoHome>/config.json` modeled on the live trace: unrelated user providers, plugins, and daemon settings stay. */
function liveLikeConfig(): Record<string, unknown> {
  return {
    version: 3,
    app: { desktop: true, firstRunAt: "2026-10-11T17:06:21.197Z" },
    plugins: { "paseo-factory": { source: "directory", path: "/Users/andrewpham/code/self-project/research-slp/plugin" } },
    pluginsEnabled: { "paseo-factory": true },
    agents: {
      providers: {
        opencode: { enabled: true },
        claude: { enabled: false },
        codex: { enabled: true },
        omp: { enabled: true },
        agy: {
          extends: "acp",
          label: "Antigravity (agy)",
          description: "Google Antigravity agent on the ACP kernel.",
          command: ["npx", "-y", "paseo-agy-acp@2.4.0"],
          env: { PASEO_AGY_ACP_OFFICIAL_BIN: "/Users/andrewpham/tools/agy-acp/agy_acp_server.par" },
          enabled: false,
        },
        "glm-acp-agent": {
          extends: "acp",
          label: "GLM Agent",
          description: "ACP agent powered by Zhipu AI's GLM Coding Plan models.",
          command: ["npx", "-y", "glm-acp-agent@1.3.0"],
          env: {},
          enabled: false,
        },
        muse: { enabled: false },
      },
    },
    daemon: {
      listen: "127.0.0.1:6767",
      cors: { origins: [] },
      browserTools: { enabled: false },
      mcp: {},
      agentProfiles: sw2Profiles(),
    },
  };
}

const LANES: Lanes = {
  supervisor: "opencode/glm-5.1",
  lead: "claude-code/claude-opus-5",
  worker: "pi/zai/glm-5.3",
  watch: "pi/zai/glm-5.3",
  retro: "pi/zai/glm-5.3",
  freshEyes: "pi/zai/glm-5.3",
};

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
}

/** Writes `<home>/config.json` the way the daemon does — 2-space JSON plus a trailing newline. */
function writeConfig(home: string, config: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), typeof config === "string" ? config : `${JSON.stringify(config, null, 2)}\n`);
}

test("v0.0.27 (ADR 0017 §1): reconcilePaseoRoleProviders sweeps the 29 sw2-* orphans, writes the three factory providers, keeps only Supervisor (Factory) in daemon.agentProfiles, preserves unrelated user config, and is idempotent", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const before = liveLikeConfig();
  writeConfig(home, before);
  const reloads: string[] = [];

  const first = reconcilePaseoRoleProviders(home, LANES, { reloadDaemon: (target) => reloads.push(target) });
  assert.ok(first.ok, "the first reconcile succeeds");
  assert.equal(first.changed, true, "the first reconcile changes the config");
  assert.deepEqual(reloads, [home], "the daemon reload fires exactly once for the real change");

  const after = readConfig(home);
  const providers = (after.agents as { providers: Record<string, Record<string, unknown>> }).providers;
  // The sweep: every sw2-* provider key is gone, and only the three canonical factory keys exist.
  assert.deepEqual(
    Object.keys(providers).filter((key) => key.startsWith("sw2-")),
    [],
    "no sw2-* provider survives",
  );
  assert.deepEqual(
    Object.keys(providers).filter((key) => key.startsWith("factory-")).sort(),
    ["factory-lead", "factory-peer", "factory-supervisor"],
    "exactly the three canonical factory providers are written",
  );
  // Unrelated user providers are preserved verbatim — except `opencode`, which the
  // spec v0.0.91 §3 XDG isolation arm augments (asserted below the loop).
  for (const key of ["claude", "codex", "omp", "agy", "glm-acp-agent", "muse"]) {
    assert.deepEqual(providers[key], (before.agents as { providers: Record<string, unknown> }).providers[key], `user provider ${key} is untouched`);
  }
  assert.equal(providers.opencode!.enabled, true, "the user's opencode entry keeps its own keys");
  assert.deepEqual(providers.opencode!.env, {
    XDG_STATE_HOME: join(home, "plugin-state", "paseo-factory", "opencode-state"),
  }, "agents.providers.opencode.env gains only the isolated XDG_STATE_HOME");
  // The three role providers carry the ADR 0017 / ADR 0026 replacement `models` shape.
  assert.deepEqual(providers[FACTORY_ROLE_PROVIDERS.supervisor], {
    extends: "opencode",
    label: "Supervisor (Factory)",
    description: providers[FACTORY_ROLE_PROVIDERS.supervisor]!.description,
    enabled: true,
    paseoTools: { enabled: false },
    env: {
      PASEO_FACTORY_SEAT: "supervisor",
      XDG_STATE_HOME: join(home, "plugin-state", "paseo-factory", "opencode-state"),
    },
    models: [{ id: "glm-5.1", label: "glm-5.1", isDefault: true }],
  });
  const lead = providers[FACTORY_ROLE_PROVIDERS.lead]!;
  assert.equal(lead.extends, "claude", "a claude-code lane maps onto the claude builtin");
  assert.equal(lead.enabled, true);
  assert.deepEqual(lead.paseoTools, { enabled: false });
  assert.deepEqual(lead.env, { PASEO_FACTORY_SEAT: "lead" });
  assert.deepEqual(lead.models, [{ id: "claude-opus-5", label: "claude-opus-5", isDefault: true }]);
  const peer = providers[FACTORY_ROLE_PROVIDERS.agent]!;
  assert.equal(peer.extends, "pi", "a pi lane maps onto the pi builtin verbatim");
  assert.deepEqual(peer.env, {
    PASEO_FACTORY_SEAT: "agent",
    PI_CODING_AGENT_DIR: join(home, "plugin-state", "paseo-factory", "pi-agent", "agent"),
  });
  assert.deepEqual(peer.models, [{ id: "zai/glm-5.3", label: "zai/glm-5.3", isDefault: true }]);

  // The picker: all 29 sw2-* rows swept, exactly one Supervisor (Factory) profile prepended.
  const profiles = (after.daemon as { agentProfiles: Record<string, unknown>[] }).agentProfiles;
  assert.equal(profiles.length, 1, "only the single Supervisor (Factory) profile remains");
  assert.deepEqual(profiles[0], {
    id: "factory-supervisor",
    name: "Supervisor (Factory)",
    provider: "factory-supervisor",
    model: "glm-5.1",
    modeId: "build", // the opencode harness pins build mode so opencode.plan never injects its subagent-forbidding reminder
  });

  // Everything else the daemon owns is preserved byte-identically.
  assert.deepEqual(after.plugins, before.plugins);
  assert.deepEqual(after.pluginsEnabled, before.pluginsEnabled);
  assert.deepEqual(after.app, before.app);
  const daemon = after.daemon as Record<string, unknown>;
  const daemonBefore = before.daemon as Record<string, unknown>;
  assert.equal(daemon.listen, daemonBefore.listen);
  assert.deepEqual(daemon.cors, daemonBefore.cors);
  assert.deepEqual(daemon.browserTools, daemonBefore.browserTools);

  // The write is atomic-in-place, tight by default, and idempotent.
  const raw = readFileSync(join(home, "config.json"), "utf8");
  assert.ok(raw.endsWith("\n"), "the file ends with a newline");
  const second = reconcilePaseoRoleProviders(home, LANES, { reloadDaemon: (target) => reloads.push(target) });
  assert.ok(second.ok && second.changed === false, "the second reconcile is a no-op");
  assert.equal(reloads.length, 1, "a no-op never fires the daemon reload");
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), raw, "a no-op never rewrites the file");

  // A change again re-reconciles and reloads — the reload tracks real changes only.
  const shifted = reconcilePaseoRoleProviders(home, { ...LANES, supervisor: "codex/gpt-5.5" }, { reloadDaemon: (target) => reloads.push(target) });
  assert.ok(shifted.ok && shifted.changed === true, "a supervisor lane change reconciles again");
  assert.equal(reloads.length, 2);
  assert.equal(((readConfig(home).daemon as { agentProfiles: { model?: string; modeId?: string }[] }).agentProfiles[0]!.model), "gpt-5.5");
});

test("v0.0.27 (ADR 0017 §1): an agy lane inherits the user's custom agy provider (or falls back to antigravity), a copilot supervisor pins the ACP plan mode, and stale factory-* keys are swept", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const config = liveLikeConfig();
  // A stale factory key from a prior install — not one of the three canonical ids.
  (config.agents as { providers: Record<string, unknown> }).providers["factory-reviewer"] = { extends: "claude", enabled: true };
  (config.daemon as { agentProfiles: unknown[] }).agentProfiles.push({ id: "factory-reviewer", name: "Reviewer (Factory)", provider: "factory-reviewer", model: "claude-opus-5" });
  writeConfig(home, config);

  const result = reconcilePaseoRoleProviders(home, {
    ...LANES,
    supervisor: "copilot/gpt-5.4",
    lead: "codex/gpt-5.5",
    worker: "agy/gemini-3-pro",
  });
  assert.ok(result.ok && result.changed === true);
  const after = readConfig(home);
  const providers = (after.agents as { providers: Record<string, Record<string, unknown>> }).providers;
  assert.equal("factory-reviewer" in providers, false, "an unknown factory-* provider key is swept");
  const peer = providers[FACTORY_ROLE_PROVIDERS.agent]!;
  assert.equal(peer.extends, "acp", "an agy lane inherits the user's custom agy extends");
  assert.deepEqual(peer.command, ["npx", "-y", "paseo-agy-acp@2.4.0"], "the custom agy command carries over");
  assert.deepEqual(peer.env, { PASEO_AGY_ACP_OFFICIAL_BIN: "/Users/andrewpham/tools/agy-acp/agy_acp_server.par", PASEO_FACTORY_SEAT: "agent" }, "the inherited env merges under the seat var");
  const profiles = (after.daemon as { agentProfiles: Record<string, unknown>[] }).agentProfiles;
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["factory-supervisor"],
    "the stale factory profile row is swept with the provider",
  );
  assert.equal(profiles[0]!.modeId, "https://agentclientprotocol.com/protocol/session-modes#plan", "the copilot harness pins its ACP plan session-mode");

  // Without a custom agy entry (or with an antigravity plugin lane), extends falls back
  // to a valid static-mode built-in provider ("opencode") so @getpaseo/protocol's ProviderOverridesSchema
  // (validExtendsValues) never rejects <home>/config.json on daemon reload and Paseo's
  // ProviderSnapshotManager resolves the replacement catalog in-memory without spawning `pi --mode rpc`.
  delete (after.agents as { providers: Record<string, unknown> }).providers.agy;
  writeConfig(home, after);
  const fallback = reconcilePaseoRoleProviders(home, { ...LANES, supervisor: "antigravity/gemini-3.1-pro-high", worker: "agy/gemini-3-pro" });
  assert.ok(fallback.ok && fallback.changed === true);
  const fallbackConfig = readConfig(home);
  const fallbackProviders = (fallbackConfig.agents as { providers: Record<string, { extends?: string; models?: { id: string }[] }> }).providers;
  assert.equal(fallbackProviders[FACTORY_ROLE_PROVIDERS.agent]!.extends, "opencode");
  assert.equal(fallbackProviders[FACTORY_ROLE_PROVIDERS.supervisor]!.extends, "opencode");
  assert.deepEqual(fallbackProviders[FACTORY_ROLE_PROVIDERS.supervisor]!.models, [
    { id: "gemini-3.1-pro-high", label: "gemini-3.1-pro-high", isDefault: true },
  ]);
  const fallbackProfile = (fallbackConfig.daemon as { agentProfiles: Record<string, unknown>[] }).agentProfiles[0]!;
  assert.equal(fallbackProfile.model, "gemini-3.1-pro-high");
  assert.equal("modeId" in fallbackProfile, false, "antigravity supervisor does not attach a foreign modeId");

  // The pure transform refuses nothing — an unparseable lane writes no provider, never a guess.
  const pure = reconcilePaseoConfigObject(liveLikeConfig(), { ...LANES, worker: "eye.json" });
  assert.equal(FACTORY_ROLE_PROVIDERS.agent in (pure.config.agents as { providers: Record<string, unknown> }).providers, false, "an eye.json worker lane leaves factory-peer unwritten");
});

test("v0.0.27 (ADR 0017 §1): an existing config.json that is not valid JSON is a named refusal, never overwritten; an absent one is created tight", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  writeConfig(home, "{ not json");
  const refused = reconcilePaseoRoleProviders(home, LANES);
  assert.ok(!refused.ok && refused.reason.includes("not valid JSON"), "the refusal names the file and the reason");
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), "{ not json", "the broken user config is left untouched");

  const freshHome = join(dir, "fresh-home");
  const created = reconcilePaseoRoleProviders(freshHome, LANES);
  assert.ok(created.ok && created.changed === true, "an absent config is created");
  assert.equal(existsSync(join(freshHome, "config.json")), true);
  assert.equal(statSync(join(freshHome, "config.json")).mode & 0o777, 0o600, "a first write starts owner-only");
});

test("v0.0.27 (ADR 0017 §1): effectiveLanesForReconcile reads the machine table when it exists, else the cleanest table across registered project overrides", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");

  // Machine file absent, no projects: the safe defaults.
  const none = effectiveLanesForReconcile(stateDir);
  assert.ok(none.ok);
  assert.equal(none.lanes.supervisor, "pi/zai/glm-5.3");

  // Two registered projects with overrides: the majority value per lane wins;
  // a lane only one project names takes that value; unmentioned lanes stay default.
  writeProjectRegistration(stateDir, "proj-a-111111", { root: join(dir, "proj-a") });
  writeProjectRegistration(stateDir, "proj-b-222222", { root: join(dir, "proj-b") });
  saveLanes(stateDir, { supervisor: "codex/gpt-5.5", worker: "claude-code/claude-opus-5" }, "proj-a-111111");
  saveLanes(stateDir, { supervisor: "codex/gpt-5.5" }, "proj-b-222222");
  const folded = effectiveLanesForReconcile(stateDir);
  assert.ok(folded.ok);
  assert.equal(folded.lanes.supervisor, "codex/gpt-5.5", "the majority supervisor lane wins");
  assert.equal(folded.lanes.worker, "claude-code/claude-opus-5", "the only worker vote stands");
  assert.equal(folded.lanes.lead, "pi/zai/glm-5.3", "an unnamed lane keeps the default");

  // A machine lanes.json, once written, is the table of record — projects stop mattering.
  writeLanes(stateDir, { supervisor: "opencode/glm-5.1" });
  const machine = effectiveLanesForReconcile(stateDir);
  assert.ok(machine.ok);
  assert.equal(machine.lanes.supervisor, "opencode/glm-5.1", "the machine file wins when it exists");
  assert.equal(machine.lanes.worker, "pi/zai/glm-5.3", "project-only lanes do not leak into the machine table");
  // A project override file with an invalid value is skipped, never trusted (the eye.json law).
  writeFileSync(projectLanesPath(stateDir, "proj-a-111111"), JSON.stringify({ supervisor: "auto" }));
  const skipped = effectiveLanesForReconcile(join(dir, "state-2"));
  assert.ok(skipped.ok, "an invalid project entry alone never refuses");
  assert.equal(skipped.lanes.supervisor, "pi/zai/glm-5.3");
});

// ---- the lanesSet seam ---------------------------------------------------------------------

/** The fake daemon slice lanesSet reads — no live agents, an empty provider catalog. */
function emptyDaemon(): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: [] }),
      create: async () => ({ id: "agent-x" }),
      ref: () => ({ send: async () => {}, archive: async () => ({ archivedAt: new Date().toISOString() }), timeline: { refetch: async () => ({ entries: [] }) } }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
}

test("v0.0.27 (ADR 0017 §1): lanesSet reconciles <home>/config.json when a Supervisor, Lead, or Worker lane changes — and writes nothing for an unrelated lane", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner });
  const handlers = createSurfaceHandlers({ factory, stateDir, home, daemon: emptyDaemon(), onLog: () => {} });
  writeConfig(home, liveLikeConfig());

  // A supervisor lane change lands in the picker profile and the provider entry.
  const supervisorSave = await handlers.lanesSet({ lane: "supervisor", value: "codex/gpt-5.5:high" });
  assert.ok(supervisorSave.ok, "the save succeeds");
  const afterSupervisor = readConfig(home);
  const profile = (afterSupervisor.daemon as { agentProfiles: { id: string; model?: string; modeId?: string; thinkingOptionId?: string }[] }).agentProfiles.find((row) => row.id === "factory-supervisor");
  assert.ok(profile !== undefined, "the Supervisor (Factory) profile exists after the save");
  assert.equal(profile.model, "gpt-5.5", "the supervisor model follows the lane");
  assert.equal(profile.modeId, "auto", "the codex harness pins auto mode");
  assert.equal(profile.thinkingOptionId, "high", "the lane's thinking level rides the profile");
  const provider = (afterSupervisor.agents as { providers: Record<string, { models?: { id: string; thinkingOptions?: { id: string }[] }[] }> }).providers["factory-supervisor"];
  assert.deepEqual(provider.models, [
    {
      id: "gpt-5.5",
      label: "gpt-5.5",
      isDefault: true,
      thinkingOptions: [{ id: "high", label: "high", isDefault: true }],
    },
  ]);

  // A worker lane change rewrites factory-peer's base provider and model.
  const workerSave = await handlers.lanesSet({ lane: "worker", value: "claude-code/claude-opus-5" });
  assert.ok(workerSave.ok);
  const peer = ((readConfig(home).agents) as { providers: Record<string, { extends?: string; models?: { id: string }[] }> }).providers["factory-peer"];
  assert.equal(peer.extends, "claude", "the worker lane change re-maps factory-peer onto claude");
  assert.deepEqual(peer.models, [{ id: "claude-opus-5", label: "claude-opus-5", isDefault: true }]);

  // A lead lane change lands in factory-lead the same way.
  const leadSave = await handlers.lanesSet({ lane: "lead", value: "omp/qwen3-coder" });
  assert.ok(leadSave.ok);
  const lead = ((readConfig(home).agents) as { providers: Record<string, { extends?: string }> }).providers["factory-lead"];
  assert.equal(lead.extends, "omp");

  // A lane the providers never read rewrites nothing — idempotence, not churn.
  const rawBefore = readFileSync(join(home, "config.json"), "utf8");
  const watchSave = await handlers.lanesSet({ lane: "watch", value: "copilot/gpt-5.4" });
  assert.ok(watchSave.ok, "the watch save itself succeeds");
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), rawBefore, "an unrelated lane leaves config.json untouched");
});

// ---- Seam 2 (ADR 0026 §1): active-scope picker sync + reset to machine default ----

test("ADR 0026 §1: a project-scoped lanesSet or lanesSetBatch reconciles <home>/config.json from the active scope's effective lanes so the New Chat picker immediately shows the configured model, and lanesReset restores the machine default", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const projectA = join(dir, "project-a");
  const projectB = join(dir, "project-b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(join(projectA, "README.md"), "# a\n");
  writeFileSync(join(projectB, "README.md"), "# b\n");
  gitCommitAll(projectA, "seed a");
  gitCommitAll(projectB, "seed b");
  writeProjectRegistration(stateDir, "project-a-111111", { root: projectA });
  writeProjectRegistration(stateDir, "project-b-222222", { root: projectB });
  const factory = createFactory({ stateDir });
  const handlers = createSurfaceHandlers({ factory, stateDir, home, daemon: emptyDaemon(), onLog: () => {} });
  writeConfig(home, liveLikeConfig());

  // The machine table starts as the baseline.
  writeLanes(stateDir, { supervisor: "codex/gpt-5.5", lead: "omp/qwen3-coder", worker: "pi/zai/glm-5.3" });
  const boot = await handlers.lanesSet({ lane: "watch", value: "pi/zai/glm-5.3" });
  assert.ok(boot.ok, "the machine-anchored save succeeds");
  const anchored = readConfig(home);
  assert.equal(
    ((anchored.agents as { providers: Record<string, { models?: { id: string }[] }> }).providers[FACTORY_ROLE_PROVIDERS.supervisor]?.models?.[0]?.id),
    "gpt-5.5",
    "the global factory-supervisor maps the machine supervisor lane",
  );

  // Saving Project A's lanes reconciles <home>/config.json from Project A's effective lanes
  // so Paseo Desktop's New Chat picker immediately shows Project A's Supervisor model.
  const aSave = await handlers.lanesSet({ lane: "supervisor", value: "claude/claude-opus-4-6:high", projectRoot: projectA });
  assert.ok(aSave.ok, aSave.ok ? "" : aSave.error);
  const aBatch = await handlers.lanesSetBatch({ lanes: { lead: "codex/gpt-5.4:high", worker: "opencode/glm-5.1" }, projectRoot: projectA });
  assert.ok(aBatch.ok, aBatch.ok ? "" : aBatch.error);
  const afterA = readConfig(home);
  const providers = (afterA.agents as { providers: Record<string, { extends?: string; models?: { id: string }[] }> }).providers;
  assert.equal(providers[FACTORY_ROLE_PROVIDERS.supervisor]?.models?.[0]?.id, "claude-opus-4-6", "factory-supervisor updates to Project A's saved supervisor model");
  assert.equal(providers[FACTORY_ROLE_PROVIDERS.lead]?.extends, "codex", "factory-lead updates to Project A's saved lead family");
  assert.equal(providers[FACTORY_ROLE_PROVIDERS.agent]?.models?.[0]?.id, "glm-5.1", "factory-peer updates to Project A's saved worker model");
  const profile = ((afterA.daemon) as { agentProfiles: { id: string; model?: string; thinkingOptionId?: string }[] }).agentProfiles.find((row) => row.id === "factory-supervisor");
  assert.equal(profile?.model, "claude-opus-4-6", "the Supervisor (Factory) picker row immediately displays Project A's model");
  assert.equal(profile?.thinkingOptionId, "high");

  // Resetting Project A back to the machine default reconciles <home>/config.json back to the machine table.
  const resetA = await handlers.lanesReset({ projectRoot: projectA });
  assert.ok(resetA.ok, resetA.ok ? "" : resetA.error);
  const afterReset = readConfig(home);
  assert.equal(
    ((afterReset.agents as { providers: Record<string, { models?: { id: string }[] }> }).providers[FACTORY_ROLE_PROVIDERS.supervisor]?.models?.[0]?.id),
    "gpt-5.5",
    "lanesReset restores the machine supervisor model in <home>/config.json",
  );

  // An unscoped save also reconciles <home>/config.json from the machine table.
  const machineSave = await handlers.lanesSet({ lane: "supervisor", value: "opencode/glm-5.1" });
  assert.ok(machineSave.ok, machineSave.ok ? "" : machineSave.error);
  const afterMachine = readConfig(home);
  assert.equal(
    ((afterMachine.agents as { providers: Record<string, { models?: { id: string }[] }> }).providers[FACTORY_ROLE_PROVIDERS.supervisor]?.models?.[0]?.id),
    "glm-5.1",
    "an UNSCOPED save reconciles the globals from the machine table it just wrote",
  );
});

test("ADR 0026 §1: healFactoryRoleProvidersInConfig repairs v0.0.40 poisoned extends ('antigravity', commandless 'acp') and promotes additionalModels to models in place without creating missing files", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const missingHome = join(dir, "missing-home");
  assert.equal(healFactoryRoleProvidersInConfig(missingHome), false, "never creates a missing config.json");
  assert.equal(existsSync(join(missingHome, "config.json")), false);

  const home = join(dir, "poisoned-home");
  const poisoned = liveLikeConfig();
  const providers = (poisoned.agents as { providers: Record<string, Record<string, unknown>> }).providers;
  providers["factory-supervisor"] = {
    extends: "antigravity",
    label: "Supervisor (Factory)",
    enabled: true,
    paseoTools: { enabled: false },
    env: { PASEO_FACTORY_SEAT: "supervisor" },
    additionalModels: [{ id: "gemini-4-argon-high", label: "gemini-4-argon-high", isDefault: true }],
  };
  providers["factory-lead"] = {
    extends: "acp",
    label: "Lead (Factory)",
    enabled: true,
    paseoTools: { enabled: false },
    env: { PASEO_FACTORY_SEAT: "lead" },
    models: [{ id: "claude-opus-4-6", label: "claude-opus-4-6", isDefault: true }],
  };
  providers["factory-peer"] = {
    extends: "agy",
    label: "Peer (Factory)",
    enabled: true,
    paseoTools: { enabled: false },
    env: { PASEO_FACTORY_SEAT: "agent" },
    models: [{ id: "gemini-3-pro", label: "gemini-3-pro", isDefault: true }],
  };
  providers["sw2-supervisor-claude"] = { extends: "claude", enabled: true };
  writeConfig(home, poisoned);

  assert.equal(healFactoryRoleProvidersInConfig(home), true, "heals the poisoned config on the first call");
  assert.equal(healFactoryRoleProvidersInConfig(home), false, "second call is a no-op");

  const healed = readConfig(home);
  const healedProviders = (healed.agents as { providers: Record<string, Record<string, unknown>> }).providers;
  assert.equal("sw2-supervisor-claude" in healedProviders, false, "sweeps orphaned sw2-* provider keys");
  assert.equal(healedProviders["factory-supervisor"]?.extends, "opencode", "heals 'antigravity' extends onto a valid static-mode built-in provider");
  assert.deepEqual(healedProviders["factory-supervisor"]?.models, [
    { id: "gemini-4-argon-high", label: "gemini-4-argon-high", isDefault: true },
  ]);
  assert.equal("additionalModels" in (healedProviders["factory-supervisor"] ?? {}), false, "promotes additionalModels to models");
  assert.equal(healedProviders["factory-lead"]?.extends, "opencode", "heals commandless 'acp' extends onto a valid static-mode built-in provider");
  assert.equal(healedProviders["factory-peer"]?.extends, "acp", "inherits custom agy acp command when present");
  assert.deepEqual(healedProviders["factory-peer"]?.command, ["npx", "-y", "paseo-agy-acp@2.4.0"]);
});

test("reconcilePaseoRoleProviders and healFactoryRoleProvidersInConfig pin per-role PI_CODING_AGENT_DIR on pi-extending role providers so Paseo's catalog probe never loads global ~/.pi/agent extensions", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "pi-home");
  const config = liveLikeConfig();
  const providers = (config.agents as { providers: Record<string, Record<string, unknown>> }).providers;
  for (const key of ["opencode", "copilot", "claude", "codex", "omp"]) {
    providers[key] = { enabled: false };
  }
  providers.pi = { enabled: true };
  writeConfig(home, config);

  const reconciled = reconcilePaseoRoleProviders(home, {
    ...LANES,
    supervisor: "antigravity/gemini-4-argon-high",
    lead: "pi/zai/glm-5.3:high",
    worker: "pi/zai/glm-5.3:high",
  });
  assert.ok(reconciled.ok && reconciled.changed === true);
  const after = readConfig(home);
  const afterProviders = (after.agents as { providers: Record<string, { extends?: string; env?: Record<string, string> }> }).providers;
  for (const role of ["supervisor", "lead", "agent"] as const) {
    const providerKey = FACTORY_ROLE_PROVIDERS[role];
    assert.equal(afterProviders[providerKey]?.extends, "pi");
    assert.equal(
      afterProviders[providerKey]?.env?.PI_CODING_AGENT_DIR,
      join(home, "plugin-state", "paseo-factory", "pi-agent", role),
      `${providerKey} pins isolated PI_CODING_AGENT_DIR for ${role}`,
    );
  }

  // Also verify healFactoryRoleProvidersInConfig adds PI_CODING_AGENT_DIR when an existing pi-extending entry lacks it.
  delete afterProviders["factory-peer"]!.env!.PI_CODING_AGENT_DIR;
  writeConfig(home, after);
  assert.equal(healFactoryRoleProvidersInConfig(home), true);
  const healed = readConfig(home);
  const healedPeer = (healed.agents as { providers: Record<string, { env?: Record<string, string> }> }).providers["factory-peer"];
  assert.equal(
    healedPeer?.env?.PI_CODING_AGENT_DIR,
    join(home, "plugin-state", "paseo-factory", "pi-agent", "agent"),
  );
});

// ---- spec v0.0.91 §3: OpenCode v2 XDG_STATE_HOME isolation + agents.resumeOnStartup: false ----

test("spec v0.0.91 §3 (User Story 12): reconcilePaseoConfigObject pins agents.resumeOnStartup: false — overwriting the 0.15.0-beta.1 legacy true — with or without paseoHome, idempotently", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  // The 0.15.0-beta.1 legacy: agents.resumeOnStartup defaulted to true and was persisted
  // in <paseoHome>/config.json — Paseo would re-prompt interrupted agents ahead of
  // ADR 0003 (recoveredAttempts) and ADR 0013/0015 (startupRecovery) on every restart.
  const legacy = liveLikeConfig();
  (legacy.agents as Record<string, unknown>).resumeOnStartup = true;
  const first = reconcilePaseoConfigObject(legacy, LANES, { paseoHome: join(dir, "paseo-home") });
  assert.equal(first.changed, true, "the legacy resumeOnStartup: true is a real change");
  assert.equal((first.config.agents as Record<string, unknown>).resumeOnStartup, false, "resumeOnStartup is pinned false");

  // A second pass over the converged config is a no-op — boots and lane saves never churn the daemon.
  const second = reconcilePaseoConfigObject(first.config, LANES, { paseoHome: join(dir, "paseo-home") });
  assert.equal(second.changed, false, "the converged config reconciles to changed: false");
  assert.equal((second.config.agents as Record<string, unknown>).resumeOnStartup, false);

  // The pin is not gated on paseoHome — the resume guard stands even without plugin state.
  const noHome = reconcilePaseoConfigObject(liveLikeConfig(), LANES);
  assert.equal((noHome.config.agents as Record<string, unknown>).resumeOnStartup, false, "the pin does not depend on paseoHome");
  assert.equal(reconcilePaseoConfigObject(noHome.config, LANES).changed, false, "no-paseoHome reconcile is idempotent too");
});

test("spec v0.0.91 §3 (User Story 9): with paseoHome, reconcile defaults XDG_STATE_HOME onto extends-opencode role providers and agents.providers.opencode.env so Paseo 0.15.0's V2Runtime never discovers a host-wide OpenCode v2 shared service", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  writeConfig(home, liveLikeConfig());
  const opencodeStateDir = join(home, "plugin-state", "paseo-factory", "opencode-state");

  // Supervisor and Peer on opencode, Lead on claude-code — only the opencode-backed seats isolate.
  const lanes: Lanes = { ...LANES, supervisor: "opencode/glm-5.1", worker: "opencode/glm-5.1" };
  const result = reconcilePaseoRoleProviders(home, lanes);
  assert.ok(result.ok && result.changed === true);
  const after = readConfig(home);
  const providers = (after.agents as { providers: Record<string, { extends?: string; env?: Record<string, string>; enabled?: boolean }> })
    .providers;

  // The opencode-backed role providers carry the plugin-owned state home — the dir whose
  // `<XDG_STATE_HOME>/opencode/service.json` probe must never find the host-wide service.
  assert.equal(providers[FACTORY_ROLE_PROVIDERS.supervisor]?.env?.XDG_STATE_HOME, opencodeStateDir, "factory-supervisor isolates XDG_STATE_HOME");
  assert.equal(providers[FACTORY_ROLE_PROVIDERS.agent]?.env?.XDG_STATE_HOME, opencodeStateDir, "factory-peer isolates XDG_STATE_HOME");
  assert.equal(providers[FACTORY_ROLE_PROVIDERS.lead]?.env?.XDG_STATE_HOME, undefined, "a claude-backed role provider never gains the OpenCode state dir");

  // The base providers.opencode entry keeps its user keys and gains only env.XDG_STATE_HOME.
  assert.equal(providers.opencode?.enabled, true, "the user's opencode entry keeps its own keys");
  assert.equal(providers.opencode?.env?.XDG_STATE_HOME, opencodeStateDir, "agents.providers.opencode.env isolates XDG_STATE_HOME");

  // Idempotent (User Story 13): a second reconcile over the converged config changes nothing.
  const second = reconcilePaseoRoleProviders(home, lanes);
  assert.ok(second.ok && second.changed === false, "the converged config reconciles to changed: false");

  // Without a paseoHome the transform never pins XDG_STATE_HOME anywhere.
  const noHome = reconcilePaseoConfigObject(liveLikeConfig(), lanes);
  const noHomeProviders = (noHome.config.agents as { providers: Record<string, { env?: Record<string, string> }> }).providers;
  assert.equal(noHomeProviders[FACTORY_ROLE_PROVIDERS.supervisor]?.env?.XDG_STATE_HOME, undefined, "no paseoHome — no role-provider XDG pin");
  assert.equal(noHomeProviders.opencode?.env, undefined, "no paseoHome — the base opencode entry stays untouched");
});

test("spec v0.0.91 §3 (User Story 10): an explicit PASEO_OPENCODE_SERVER_URL or custom XDG_STATE_HOME survives reconciliation untouched — the isolation is a default, never an override", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");

  // 1. An explicit PASEO_OPENCODE_SERVER_URL on agents.providers.opencode.env — the Owner
  //    runs their own OpenCode server and points Paseo at it.
  const serverUrlConfig = liveLikeConfig();
  (serverUrlConfig.agents as { providers: Record<string, { enabled?: boolean; env?: Record<string, string> }> }).providers.opencode = {
    enabled: true,
    env: { PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096/openapi.json" },
  };
  writeConfig(home, serverUrlConfig);
  const serverUrlResult = reconcilePaseoRoleProviders(home, { ...LANES, worker: "opencode/glm-5.1" });
  assert.ok(serverUrlResult.ok && serverUrlResult.changed === true);
  const serverUrlAfter = (readConfig(home).agents as { providers: Record<string, { env?: Record<string, string> }> }).providers;
  assert.deepEqual(
    serverUrlAfter.opencode?.env,
    { PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096/openapi.json" },
    "an explicit server URL is preserved and gains no XDG default",
  );
  assert.equal(
    serverUrlAfter[FACTORY_ROLE_PROVIDERS.agent]?.env?.XDG_STATE_HOME,
    join(home, "plugin-state", "paseo-factory", "opencode-state"),
    "a builtin opencode lane has no inherited env, so the role provider still takes the XDG default — the owner's server URL on the base entry governs acquisition",
  );

  // 2. A custom XDG_STATE_HOME on agents.providers.opencode.env — the Owner isolated
  //    OpenCode state themselves.
  const customXdgConfig = liveLikeConfig();
  (customXdgConfig.agents as { providers: Record<string, { enabled?: boolean; env?: Record<string, string> }> }).providers.opencode = {
    enabled: true,
    env: { XDG_STATE_HOME: "/Users/owner/opencode-paseo-state" },
  };
  writeConfig(home, customXdgConfig);
  const customXdgResult = reconcilePaseoRoleProviders(home, { ...LANES, worker: "opencode/glm-5.1" });
  assert.ok(customXdgResult.ok && customXdgResult.changed === true);
  const customXdgAfter = (readConfig(home).agents as { providers: Record<string, { env?: Record<string, string> }> }).providers;
  assert.deepEqual(
    customXdgAfter.opencode?.env,
    { XDG_STATE_HOME: "/Users/owner/opencode-paseo-state" },
    "a custom XDG_STATE_HOME is preserved untouched",
  );

  // 3. The same precedence on the role-provider side: a custom opencode-extending provider
  //    entry whose inherited env names a server URL or its own state home is respected.
  const inheritedConfig = liveLikeConfig();
  (inheritedConfig.agents as { providers: Record<string, unknown> }).providers["my-oc"] = {
    extends: "opencode",
    label: "My OpenCode",
    env: { PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:5057/openapi.json" },
  };
  const pure = reconcilePaseoConfigObject(inheritedConfig, { ...LANES, worker: "my-oc/glm-5.1" }, { paseoHome: home });
  const pureProviders = (pure.config.agents as { providers: Record<string, { env?: Record<string, string> }> }).providers;
  assert.equal(
    pureProviders[FACTORY_ROLE_PROVIDERS.agent]?.env?.PASEO_OPENCODE_SERVER_URL,
    "http://127.0.0.1:5057/openapi.json",
    "the inherited server URL reaches the role provider env",
  );
  assert.equal(pureProviders[FACTORY_ROLE_PROVIDERS.agent]?.env?.XDG_STATE_HOME, undefined, "an inherited server URL beats the XDG default");

  const inheritedXdg = liveLikeConfig();
  (inheritedXdg.agents as { providers: Record<string, unknown> }).providers["my-oc"] = {
    extends: "opencode",
    label: "My OpenCode",
    env: { XDG_STATE_HOME: "/Users/owner/my-oc-state" },
  };
  const pureXdg = reconcilePaseoConfigObject(inheritedXdg, { ...LANES, worker: "my-oc/glm-5.1" }, { paseoHome: home });
  const pureXdgProviders = (pureXdg.config.agents as { providers: Record<string, { env?: Record<string, string> }> }).providers;
  assert.equal(
    pureXdgProviders[FACTORY_ROLE_PROVIDERS.agent]?.env?.XDG_STATE_HOME,
    "/Users/owner/my-oc-state",
    "an inherited custom XDG_STATE_HOME beats the plugin-owned default",
  );
});

test("spec v0.0.91 §3: healFactoryRoleProvidersInConfig repairs a 0.15.0-beta.1 resumeOnStartup: true and missing XDG_STATE_HOME under the reconcile path's precedence rules, idempotently", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "heal-home");
  const opencodeStateDir = join(home, "plugin-state", "paseo-factory", "opencode-state");

  const poisoned = liveLikeConfig();
  const agentsPoisoned = poisoned.agents as { resumeOnStartup?: unknown; providers: Record<string, Record<string, unknown>> };
  agentsPoisoned.resumeOnStartup = true; // the 0.15.0-beta.1 legacy default, persisted
  agentsPoisoned.providers["factory-supervisor"] = {
    extends: "opencode",
    label: "Supervisor (Factory)",
    enabled: true,
    paseoTools: { enabled: false },
    env: { PASEO_FACTORY_SEAT: "supervisor" }, // missing XDG_STATE_HOME
    models: [{ id: "glm-5.1", label: "glm-5.1", isDefault: true }],
  };
  agentsPoisoned.providers["factory-lead"] = {
    extends: "opencode",
    label: "Lead (Factory)",
    enabled: true,
    paseoTools: { enabled: false },
    env: { PASEO_FACTORY_SEAT: "lead", PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096/openapi.json" },
    models: [{ id: "glm-5.1", label: "glm-5.1", isDefault: true }],
  };
  agentsPoisoned.providers["factory-peer"] = {
    extends: "claude",
    label: "Peer (Factory)",
    enabled: true,
    paseoTools: { enabled: false },
    env: { PASEO_FACTORY_SEAT: "agent" },
    models: [{ id: "claude-opus-5", label: "claude-opus-5", isDefault: true }],
  };
  writeConfig(home, poisoned);

  assert.equal(healFactoryRoleProvidersInConfig(home), true, "the first heal repairs the config");
  assert.equal(healFactoryRoleProvidersInConfig(home), false, "the second heal is a no-op");

  const healed = readConfig(home);
  const healedAgents = healed.agents as { resumeOnStartup?: unknown; providers: Record<string, { env?: Record<string, string>; enabled?: boolean }> };
  assert.equal(healedAgents.resumeOnStartup, false, "resumeOnStartup: true is healed back to false");
  assert.equal(healedAgents.providers["factory-supervisor"]?.env?.XDG_STATE_HOME, opencodeStateDir, "a missing XDG_STATE_HOME is healed onto the opencode-extending role provider");
  assert.deepEqual(
    healedAgents.providers["factory-lead"]?.env,
    { PASEO_FACTORY_SEAT: "lead", PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:4096/openapi.json" },
    "an explicit server URL is preserved and gains no XDG default on heal",
  );
  assert.equal(healedAgents.providers["factory-peer"]?.env?.XDG_STATE_HOME, undefined, "a claude-extending role provider never gains the OpenCode state dir");
  assert.equal(healedAgents.providers.opencode?.enabled, true, "the base opencode entry keeps its user keys through the heal");
  assert.equal(healedAgents.providers.opencode?.env?.XDG_STATE_HOME, opencodeStateDir, "the base opencode entry's missing XDG_STATE_HOME is healed");

  // The agents-without-providers shape still heals agents.resumeOnStartup — the resume
  // guard lives on `agents`, not under `agents.providers`.
  const bareHome = join(dir, "bare-home");
  writeConfig(bareHome, { agents: { resumeOnStartup: true }, app: { desktop: true } });
  assert.equal(healFactoryRoleProvidersInConfig(bareHome), true, "heals resumeOnStartup even when agents.providers is absent");
  const bareHealed = readConfig(bareHome);
  assert.equal((bareHealed.agents as { resumeOnStartup?: unknown }).resumeOnStartup, false);
  assert.equal("providers" in (bareHealed.agents as object), false, "the heal never invents an agents.providers table");
  assert.deepEqual(bareHealed.app, { desktop: true }, "unrelated user config survives the heal untouched");
});

// ---- spec v0.0.94 §3 (ADR 0046 Decision 1): the zcode base provider ------------------------

test("spec v0.0.94 §3 (ADR 0046 Decision 1): a zcode lane auto-registers agents.providers.zcode even with the app absent, the installed app alone registers it with no zcode lane, user keys survive, and heal fills only missing keys", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  // The injected app probe keeps both trigger arms machine-independent — the
  // real /Applications/ZCode.app exists on the Owner's host but never enters a test.
  const absentApp = join(dir, "missing", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs");
  const registeredZcodeEntry = {
    extends: "acp",
    command: ["npx", "-y", "zcode-acp-server@0.82.1"],
    env: {
      ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled",
      ZCODE_ACP_QUOTA_AUTO_RESUME: "0",
      ZCODE_ACP_QUOTA_BOOT_NOTICE: "0",
    },
  };
  const providersOf = (home: string): Record<string, Record<string, unknown>> =>
    (readConfig(home).agents as { providers: Record<string, Record<string, unknown>> }).providers;

  // Arm 1 — the lane trigger: a worker zcode lane registers the base entry even
  // when ZCode Desktop is absent from the host.
  const laneHome = join(dir, "lane-home");
  writeConfig(laneHome, liveLikeConfig());
  const zcodeLanes: Lanes = { ...LANES, worker: "zcode/GLM-5.3:high" };
  const laneRun = reconcilePaseoRoleProviders(laneHome, zcodeLanes, { zcodeAppPath: absentApp });
  assert.ok(laneRun.ok && laneRun.changed === true, "the zcode lane reconcile changes the config");
  assert.deepEqual(providersOf(laneHome).zcode, registeredZcodeEntry, "the base zcode entry carries extends, the npx command, and exactly the factory-safe env defaults");
  const laneAgain = reconcilePaseoRoleProviders(laneHome, zcodeLanes, { zcodeAppPath: absentApp });
  assert.ok(laneAgain.ok && laneAgain.changed === false, "the registration is idempotent");

  // The negative arm — no zcode lane and no app: nothing is registered.
  const plainHome = join(dir, "plain-home");
  writeConfig(plainHome, liveLikeConfig());
  const plainRun = reconcilePaseoRoleProviders(plainHome, LANES, { zcodeAppPath: absentApp });
  assert.ok(plainRun.ok && plainRun.changed === true);
  assert.equal("zcode" in providersOf(plainHome), false, "no zcode lane and no app — no zcode entry");

  // Arm 2 — the installed-app trigger: the app alone registers the entry with no zcode lane.
  const appPath = join(dir, "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs");
  mkdirSync(dirname(appPath), { recursive: true });
  writeFileSync(appPath, "#!/usr/bin/env node\n"); // a fixture file — only existsSync is consulted
  const appHome = join(dir, "app-home");
  writeConfig(appHome, liveLikeConfig());
  const appRun = reconcilePaseoRoleProviders(appHome, LANES, { zcodeAppPath: appPath });
  assert.ok(appRun.ok && appRun.changed === true);
  assert.deepEqual(providersOf(appHome).zcode, registeredZcodeEntry, "the installed app registers the same base entry");

  // Explicit user keys survive the spread — only missing plugin keys are defaulted.
  const userHome = join(dir, "user-home");
  const userConfig = liveLikeConfig();
  (userConfig.agents as { providers: Record<string, unknown> }).providers.zcode = {
    label: "My own zcode",
    command: ["npx", "-y", "zcode-acp-server@0.99.0"],
    env: { ZCODE_ACP_QUOTA_AUTO_RESUME: "1", ZCODE_MY_KEY: "keep" },
  };
  writeConfig(userHome, userConfig);
  const userRun = reconcilePaseoRoleProviders(userHome, LANES, { zcodeAppPath: appPath });
  assert.ok(userRun.ok && userRun.changed === true);
  assert.deepEqual(providersOf(userHome).zcode, {
    label: "My own zcode",
    extends: "acp",
    command: ["npx", "-y", "zcode-acp-server@0.99.0"],
    env: {
      ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled",
      ZCODE_ACP_QUOTA_AUTO_RESUME: "1",
      ZCODE_ACP_QUOTA_BOOT_NOTICE: "0",
      ZCODE_MY_KEY: "keep",
    },
  }, "the user's label, command, and env keys survive; only absent factory-safe keys are defaulted");

  // The heal twin: an existing entry is the heal trigger with the app absent, fills only
  // missing env keys idempotently; the app alone registers through the heal path; neither
  // trigger registers nothing.
  const healHome = join(dir, "heal-home");
  const healConfig = liveLikeConfig();
  (healConfig.agents as { providers: Record<string, unknown> }).providers.zcode = {
    extends: "acp",
    command: ["npx", "-y", "zcode-acp-server@0.82.1"],
    env: { ZCODE_ACP_QUOTA_AUTO_RESUME: "1" },
  };
  writeConfig(healHome, healConfig);
  assert.equal(healFactoryRoleProvidersInConfig(healHome, { zcodeAppPath: absentApp }), true, "the heal fills the missing factory-safe env keys");
  assert.equal(healFactoryRoleProvidersInConfig(healHome, { zcodeAppPath: absentApp }), false, "the second heal is a no-op");
  assert.deepEqual(providersOf(healHome).zcode?.env, {
    ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled",
    ZCODE_ACP_QUOTA_AUTO_RESUME: "1",
    ZCODE_ACP_QUOTA_BOOT_NOTICE: "0",
  }, "the heal defaults only the missing keys — the user's quota override stands");

  const healAppHome = join(dir, "heal-app-home");
  writeConfig(healAppHome, liveLikeConfig());
  assert.equal(healFactoryRoleProvidersInConfig(healAppHome, { zcodeAppPath: appPath }), true, "the app alone registers the entry through the heal path");
  assert.deepEqual(providersOf(healAppHome).zcode, registeredZcodeEntry, "the heal-registered entry matches the reconcile-registered one — the two paths cannot drift");

  const healNoneHome = join(dir, "heal-none-home");
  // The opencode entry carries an explicit XDG_STATE_HOME so the v0.0.91 heal arm is a
  // no-op and the changed flag isolates the zcode arm.
  writeConfig(healNoneHome, {
    agents: { providers: { opencode: { enabled: true, env: { XDG_STATE_HOME: "/Users/owner/oc-state" } } } },
    app: { desktop: true },
  });
  assert.equal(healFactoryRoleProvidersInConfig(healNoneHome, { zcodeAppPath: absentApp }), false, "no entry and no app — the heal registers nothing");
});

test("spec v0.0.94 §3 (ADR 0046 Decision 2): a zcode/GLM-5.3:high lane writes the normalized replacement catalog and the per-seat clean-room env onto the role provider, with no picker modeId", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const home = join(dir, "paseo-home");
  const absentApp = join(dir, "missing", "zcode.cjs");
  writeConfig(home, liveLikeConfig());
  const lanes: Lanes = { ...LANES, supervisor: "zcode/GLM-5.3:high", worker: "zcode/GLM-5.3:high" };
  const result = reconcilePaseoRoleProviders(home, lanes, { zcodeAppPath: absentApp });
  assert.ok(result.ok && result.changed === true);
  const after = readConfig(home);
  const providers = (after.agents as { providers: Record<string, Record<string, unknown>> }).providers;
  const factoryState = join(home, "plugin-state", "paseo-factory");

  // The per-role record: acp-backed onto the registered base, carrying the per-seat
  // provisionZcodeHome env (ticket 01) — the daemon-spawned zcode child reads its clean
  // room straight off the provider entry's env.
  const supervisor = providers[FACTORY_ROLE_PROVIDERS.supervisor]!;
  assert.equal(supervisor.extends, "acp");
  assert.deepEqual(supervisor.command, ["npx", "-y", "zcode-acp-server@0.82.1"]);
  const supervisorEnv = supervisor.env as Record<string, string>;
  assert.equal(supervisorEnv.PASEO_FACTORY_SEAT, "supervisor");
  assert.equal(supervisorEnv.ZCODE_STORAGE_DIR, join(factoryState, "zcode-home", "supervisor"));
  assert.equal(supervisorEnv.ZCODE_SESSION_DB_PATH, join(factoryState, "zcode-home", "supervisor", "db", "db.sqlite"));
  assert.equal(supervisorEnv.ZCODE_ACP_MODE, "guarded");
  assert.equal(supervisorEnv.ZCODE_DYNAMIC_WORKFLOW_MODE, "disabled");
  assert.equal(supervisorEnv.ZCODE_ACP_QUOTA_AUTO_RESUME, "0");
  assert.equal(supervisorEnv.ZCODE_ACP_QUOTA_BOOT_NOTICE, "0");
  assert.equal(supervisorEnv.ZCODE_DISALLOWED_TOOLS, "Write,Edit,MultiEdit,NotebookEdit,DeleteFile", "the Layer-1 seat tool lock rides the supervisor entry");
  assert.equal("HOME" in supervisorEnv, false, "the record never overrides HOME (ADR 0046 Gap 4)");
  assert.equal("ZCODE_HOME" in supervisorEnv, false, "the record never overrides ZCODE_HOME (ADR 0046 Gap 4)");

  // The normalized replacement catalog (ADR 0046 Gap 2): the runtime id Paseo's
  // setModelWithSelection validates, a clean display label, and the effort's thinkingOptions.
  assert.deepEqual(supervisor.models, [
    {
      id: "builtin:zai-coding-plan\\GLM-5.3",
      label: "GLM-5.3 (Factory)",
      isDefault: true,
      thinkingOptions: [{ id: "high", label: "high", isDefault: true }],
    },
  ]);

  const peer = providers[FACTORY_ROLE_PROVIDERS.agent]!;
  assert.equal(
    (peer.env as Record<string, string>).ZCODE_STORAGE_DIR,
    join(factoryState, "zcode-home", "agent"),
    "the working Agent seat lands on the standing agent home (per-Task homes come at session time)",
  );
  assert.equal("ZCODE_DISALLOWED_TOOLS" in (peer.env as Record<string, string>), false, "the Peer seat carries no Layer-1 tool lock — Choke governs it");

  // The picker row: the Supervisor (Factory) profile's model matches its own normalized
  // catalog, and zcode attaches no modeId.
  const profile = (after.daemon as { agentProfiles: Record<string, unknown>[] }).agentProfiles[0]!;
  assert.equal(profile.model, "builtin:zai-coding-plan\\GLM-5.3", "the picker row carries the runtime id its catalog advertises");
  assert.equal("modeId" in profile, false, "zcode attaches no picker modeId");
  assert.equal(profile.thinkingOptionId, "high");

  // An explicit "<providerId>\<modelId>" lane passes through verbatim (never rewritten),
  // with the display label stripped of the prefix.
  const explicit = reconcilePaseoConfigObject(
    liveLikeConfig(),
    { ...lanes, worker: "zcode/custom:mine\\GLM-5.3-Flash:medium" },
    { paseoHome: home, zcodeAppPath: absentApp },
  );
  const explicitModels = ((explicit.config.agents as { providers: Record<string, { models?: { id: string; label: string }[] }> }).providers[FACTORY_ROLE_PROVIDERS.agent])!.models!;
  assert.equal(explicitModels[0]!.id, "custom:mine\\GLM-5.3-Flash");
  assert.equal(explicitModels[0]!.label, "GLM-5.3-Flash (Factory)");

  // Idempotence: the converged config reconciles to changed: false.
  const again = reconcilePaseoRoleProviders(home, lanes, { zcodeAppPath: absentApp });
  assert.ok(again.ok && again.changed === false, "the zcode role record reconciles idempotently");
});

test("spec v0.0.94 §3: laneProviderConfig resolves a zcode lane onto the runtime model id with its thinking option intact — the feed for agent.create.before's model rewrite", () => {
  // The advertised catalog the daemon would build from the registered base zcode entry.
  const catalog = [
    {
      id: "zcode",
      provider: "zcode",
      models: [{ id: "builtin:zai-coding-plan\\GLM-5.3", thinkingOptions: [{ id: "high" }, { id: "medium" }] }],
    },
  ];

  // A clean lane resolves onto the runtime id, verbatim provider, and the effort's
  // thinking option (Paseo's setModelWithSelection validates the id client-side).
  assert.deepEqual(laneProviderConfig("zcode/GLM-5.3:high", catalog), {
    provider: "zcode",
    model: "builtin:zai-coding-plan\\GLM-5.3",
    thinkingOptionId: "high",
  });
  // An explicit "<providerId>\<modelId>" lane passes through unchanged — never rewritten twice.
  assert.deepEqual(laneProviderConfig("zcode/builtin:zai-coding-plan\\GLM-5.3:medium", catalog), {
    provider: "zcode",
    model: "builtin:zai-coding-plan\\GLM-5.3",
    thinkingOptionId: "medium",
  });
  // Without an advertised catalog the thinking level still rides (the options == null law).
  assert.deepEqual(laneProviderConfig("zcode/GLM-5.3:high", undefined), {
    provider: "zcode",
    model: "builtin:zai-coding-plan\\GLM-5.3",
    thinkingOptionId: "high",
  });
  // An effort the catalog does not offer is dropped — the existing supportsThinking law.
  assert.deepEqual(laneProviderConfig("zcode/GLM-5.3:max", catalog), {
    provider: "zcode",
    model: "builtin:zai-coding-plan\\GLM-5.3",
  });
  // An effort-less lane carries no thinkingOptionId.
  assert.deepEqual(laneProviderConfig("zcode/GLM-5.3", catalog), {
    provider: "zcode",
    model: "builtin:zai-coding-plan\\GLM-5.3",
  });
  // Non-zcode families resolve exactly as before.
  assert.deepEqual(laneProviderConfig("opencode/glm-5.1", [{ id: "opencode", models: [{ id: "glm-5.1" }] }]), {
    provider: "opencode",
    model: "glm-5.1",
  });
});
