import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { writeProjectRegistration } from "../plugin/server/projects.ts";
import { FACTORY_ROLE_PROVIDERS, effectiveLanesForReconcile, reconcilePaseoConfigObject, reconcilePaseoRoleProviders } from "../src/role-providers.ts";
import { projectLanesPath, saveLanes } from "../src/lanes.ts";
import type { Lanes } from "../src/lanes.ts";
import { disposeDir, fakeCopilotRunner, makeTempDir, writeLanes } from "./helpers.ts";

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
  // Unrelated user providers are preserved verbatim.
  for (const key of ["opencode", "claude", "codex", "omp", "agy", "glm-acp-agent", "muse"]) {
    assert.deepEqual(providers[key], (before.agents as { providers: Record<string, unknown> }).providers[key], `user provider ${key} is untouched`);
  }
  // The three role providers carry the ADR 0017 shape.
  assert.deepEqual(providers[FACTORY_ROLE_PROVIDERS.supervisor], {
    extends: "opencode",
    label: "Supervisor (Factory)",
    description: providers[FACTORY_ROLE_PROVIDERS.supervisor]!.description,
    enabled: true,
    paseoTools: { enabled: false },
    env: { PASEO_FACTORY_SEAT: "supervisor" },
    additionalModels: [{ id: "glm-5.1", label: "glm-5.1", isDefault: true }],
  });
  const lead = providers[FACTORY_ROLE_PROVIDERS.lead]!;
  assert.equal(lead.extends, "claude", "a claude-code lane maps onto the claude builtin");
  assert.equal(lead.enabled, true);
  assert.deepEqual(lead.paseoTools, { enabled: false });
  assert.deepEqual(lead.env, { PASEO_FACTORY_SEAT: "lead" });
  assert.deepEqual(lead.additionalModels, [{ id: "claude-opus-5", label: "claude-opus-5", isDefault: true }]);
  const peer = providers[FACTORY_ROLE_PROVIDERS.agent]!;
  assert.equal(peer.extends, "pi", "a pi lane maps onto the pi builtin verbatim");
  assert.deepEqual(peer.env, { PASEO_FACTORY_SEAT: "agent" });
  assert.deepEqual(peer.additionalModels, [{ id: "zai/glm-5.3", label: "zai/glm-5.3", isDefault: true }]);

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

  // Without a custom agy entry, the same lane falls back to the antigravity builtin.
  delete (after.agents as { providers: Record<string, unknown> }).providers.agy;
  writeConfig(home, after);
  const fallback = reconcilePaseoRoleProviders(home, { ...LANES, worker: "agy/gemini-3-pro" });
  assert.ok(fallback.ok && fallback.changed === true);
  assert.equal(((readConfig(home).agents as { providers: Record<string, { extends?: string }> }).providers[FACTORY_ROLE_PROVIDERS.agent]!.extends), "antigravity");

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
  const provider = (afterSupervisor.agents as { providers: Record<string, { additionalModels?: { id: string }[] }> }).providers["factory-supervisor"];
  assert.deepEqual(provider.additionalModels, [{ id: "gpt-5.5", label: "gpt-5.5", isDefault: true }]);

  // A worker lane change rewrites factory-peer's base provider and model.
  const workerSave = await handlers.lanesSet({ lane: "worker", value: "claude-code/claude-opus-5" });
  assert.ok(workerSave.ok);
  const peer = ((readConfig(home).agents) as { providers: Record<string, { extends?: string; additionalModels?: { id: string }[] }> }).providers["factory-peer"];
  assert.equal(peer.extends, "claude", "the worker lane change re-maps factory-peer onto claude");
  assert.deepEqual(peer.additionalModels, [{ id: "claude-opus-5", label: "claude-opus-5", isDefault: true }]);

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
