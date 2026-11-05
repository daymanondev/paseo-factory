/**
 * The native Paseo role providers (v0.0.27, ADR 0017 §1): the three SLP role
 * providers `factory-supervisor`, `factory-lead`, and `factory-peer` plus the
 * single `Supervisor (Factory)` picker profile, reconciled from `Lane config`
 * into `<paseoHome>/config.json` (`agents.providers` + `daemon.agentProfiles`)
 * at plugin boot and on every lane save. A provider-named seat beats every
 * title heuristic — Paseo's New Chat picker starts `Supervisor (Factory)`
 * (`provider: "factory-supervisor"`) and `server.before("agent.create")`
 * recognizes the role deterministically (ADR 0017 §2), while
 * `paseoTools: { enabled: false }` keeps Paseo's own agent tools off the seat
 * at the daemon config layer.
 *
 * The reconcile is a pure object transform (`reconcilePaseoConfigObject`) over
 * the parsed config — it sweeps the orphaned `sw2-*` leftovers of the removed
 * seatworks-v2 install (29 broken picker profiles in the live trace) and any
 * stale `factory-*` entries, writes the three managed providers mapped from
 * `lanes.supervisor` / `lanes.lead` / `lanes.worker` to their base Paseo
 * provider, and leaves every unrelated user key (providers, profiles,
 * `plugins`, `app`, …) byte-identical. `reconcilePaseoRoleProviders` is the
 * file-backed wrapper: read, reconcile, and write atomically (tmp +
 * `renameSync`) ONLY when something changed — so a second run is a no-op and
 * the daemon reload fires at most once per real change.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultLanes,
  LANE_NAMES,
  laneError,
  lanesPath,
  loadLanes,
  normalizeZcodeRuntimeModelId,
  parseLane,
  projectLanesPath,
  stripZcodeProviderPrefix,
  ZCODE_CJS_PATH,
} from "./lanes.ts";
import type { LaneName, Lanes, LanesResult } from "./lanes.ts";
import { listProjectRegistrations } from "./project.ts";
import { provisionZcodeHome } from "./zcode-home.ts";

/** The canonical provider ids of the three SLP roles — the keys the reconciler owns in `agents.providers`. */
export const FACTORY_ROLE_PROVIDERS = {
  supervisor: "factory-supervisor",
  lead: "factory-lead",
  agent: "factory-peer",
} as const;

export type FactoryRole = keyof typeof FACTORY_ROLE_PROVIDERS;

/** The picker labels of the three role providers (ADR 0017 §1). */
export const FACTORY_ROLE_LABELS: Record<FactoryRole, string> = {
  supervisor: "Supervisor (Factory)",
  lead: "Lead (Factory)",
  agent: "Peer (Factory)",
};

/** The lane each role provider is mapped from — the worker lane backs the Peer. */
const ROLE_LANE: Record<FactoryRole, "supervisor" | "lead" | "worker"> = {
  supervisor: "supervisor",
  lead: "lead",
  agent: "worker",
};

const ROLE_ORDER: readonly FactoryRole[] = ["supervisor", "lead", "agent"];

/**
 * The picker profile's `modeId` per base harness — the mode id the
 * `Supervisor (Factory)` profile pins so the native picker starts the seat
 * fenced (opencode `build` — never `plan`, whose synthetic `<system-reminder>`
 * forbids subagent delegation and unlocks `~/.opencode/plan/*`; copilot's ACP
 * plan session-mode URL; codex `auto`; omp `write`; the harnesses that need
 * none — claude, pi, antigravity — get no `modeId`). The exact ids
 * `applyProviderExecutionFence` pins per family (plugin/server/roles.ts),
 * restated for the daemon config layer.
 */
const SUPERVISOR_PROFILE_MODE_ID: Record<string, string> = {
  opencode: "build",
  copilot: "https://agentclientprotocol.com/protocol/session-modes#plan",
  codex: "auto",
  omp: "write",
};

// ---- the config shapes (structural slices of `<paseoHome>/config.json`) ---------------------

/** One thinking option on a replacement/additional model entry in `agents.providers`. */
export interface PaseoProviderThinkingOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** One model entry in `agents.providers.<id>.models` or `additionalModels`. */
export interface PaseoProviderModelEntry {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  thinkingOptions?: PaseoProviderThinkingOption[];
}

/** One `agents.providers` entry — user fields beyond the slice survive untouched. */
export interface PaseoProviderEntry {
  extends?: string;
  label?: string;
  description?: string;
  command?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  paseoTools?: { enabled?: boolean; disabledTools?: string[] };
  models?: PaseoProviderModelEntry[];
  additionalModels?: PaseoProviderModelEntry[];
  [key: string]: unknown;
}

/** One `daemon.agentProfiles` entry — the New Chat picker row. */
export interface PaseoAgentProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  [key: string]: unknown;
}

/** The parsed `<paseoHome>/config.json` — everything outside the reconciled keys is preserved verbatim. */
export interface PaseoConfigObject {
  agents?: { providers?: Record<string, PaseoProviderEntry>; [key: string]: unknown };
  daemon?: { agentProfiles?: PaseoAgentProfile[]; [key: string]: unknown };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `sw2-*` (the removed seatworks-v2 install) and every `factory-*` key the reconciler does not own. */
function isSweptProviderKey(key: string): boolean {
  if (key.startsWith("sw2-")) return true;
  return key.startsWith("factory-") && !ROLE_ORDER.some((role) => FACTORY_ROLE_PROVIDERS[role] === key);
}

/** A profile row the reconciler owns or orphans — matched by `id` or `provider` prefix. */
function isSweptProfile(profile: PaseoAgentProfile): boolean {
  for (const field of [profile.id, profile.provider]) {
    if (typeof field === "string" && (field.startsWith("sw2-") || field.startsWith("factory-"))) return true;
  }
  return false;
}

/**
 * Paseo 0.13.0's `ProviderOverridesSchema` (`@getpaseo/protocol`) validates
 * `agents.providers.<id>.extends` against `BUILTIN_PROVIDER_IDS` (`claude`,
 * `codex`, `copilot`, `opencode`, `pi`, `omp`) plus `acp` (which requires a
 * non-empty `command` array). Plugin-contributed providers such as
 * `antigravity` are not in `validExtendsValues`, so extending them directly in
 * `<paseoHome>/config.json` fails schema validation and aborts daemon config
 * reload. When a lane uses a non-builtin provider without a custom `acp`
 * command, the picker entry extends a valid built-in provider (`pi` or the
 * first non-disabled built-in) with a replacement `models` catalog, while
 * `server.before("agent.create")` rewrites `{ provider, model }` onto the real
 * runtime provider (ADR 0026 §1).
 */
const PASEO_BUILTIN_EXTENDS = new Set(["claude", "codex", "copilot", "opencode", "pi", "omp"]);
const FALLBACK_BUILTIN_ORDER = ["opencode", "copilot", "claude", "codex", "omp", "pi"] as const;

/**
 * The zcode base provider's ACP runtime (v0.0.94, ADR 0046 Decision 1): the
 * Paseo core team's official ZCode Protocol v1 bridge, pinned to the exact
 * version the ADR validated against ZCode `v0.17.1` / App `v3.17.2`.
 */
const ZCODE_ACP_COMMAND = ["npx", "-y", "zcode-acp-server@0.82.1"] as const;
const ZCODE_BASE_LABEL = "ZCode (GLM Coding Plan)";

/**
 * The factory-safe defaults on the base `agents.providers.zcode` env (ADR 0046
 * Decision 1 / Gap 5): workflows stay with the factory's own orchestration,
 * quota parking + auto-resume stay with `QuotaParkRuntime`, and the boot
 * notice never fires on multi-provider `~/.zcode/v2/config.json` setups.
 */
const ZCODE_BASE_ENV_DEFAULTS: Record<string, string> = {
  ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled",
  ZCODE_ACP_QUOTA_AUTO_RESUME: "0",
  ZCODE_ACP_QUOTA_BOOT_NOTICE: "0",
};

function fallbackBuiltinExtends(providers: Record<string, PaseoProviderEntry>): string {
  for (const candidate of FALLBACK_BUILTIN_ORDER) {
    const entry = providers[candidate];
    if (isRecord(entry) && entry.enabled === true) return candidate;
  }
  for (const candidate of FALLBACK_BUILTIN_ORDER) {
    const entry = providers[candidate];
    if (!isRecord(entry) || entry.enabled !== false) return candidate;
  }
  return "opencode";
}

/**
 * Maps one lane's provider family to the base Paseo provider it extends in
 * `<paseoHome>/config.json`:
 * - `claude-code` → the `claude` builtin;
 * - `agy` (or any custom entry in `agents.providers`) → inherits the user's
 *   custom `extends`/`command`/`env` when its `extends` is in
 *   `PASEO_BUILTIN_EXTENDS` or is `acp` with a non-empty `command` array;
 * - any built-in provider in `PASEO_BUILTIN_EXTENDS` → verbatim;
 * - any plugin-contributed provider not in `PASEO_BUILTIN_EXTENDS` (such as
 *   `antigravity`, or `agy` without a custom `acp` command) → falls back to
 *   `fallbackBuiltinExtends(providers)` (`"pi"`) so `ProviderOverridesSchema`
 *   always accepts `<paseoHome>/config.json`.
 */
function baseProviderFor(
  laneProvider: string,
  providers: Record<string, PaseoProviderEntry>,
): { extends: string; command?: string[]; inheritedEnv?: Record<string, string> } {
  if (laneProvider === "claude-code") return { extends: "claude" };
  const custom = providers[laneProvider];
  if (isRecord(custom)) {
    const entry = custom as PaseoProviderEntry;
    const rawExtends = typeof entry.extends === "string" && entry.extends !== "" ? entry.extends : "";
    const hasValidCommand =
      Array.isArray(entry.command) && entry.command.length > 0 && entry.command.every((part) => typeof part === "string");
    const inheritedEnv = isRecord(entry.env) ? (entry.env as Record<string, string>) : undefined;
    if (rawExtends === "acp" && hasValidCommand) {
      return {
        extends: "acp",
        command: entry.command as string[],
        ...(inheritedEnv === undefined ? {} : { inheritedEnv }),
      };
    }
    if (PASEO_BUILTIN_EXTENDS.has(rawExtends)) {
      return {
        extends: rawExtends,
        ...(hasValidCommand ? { command: entry.command as string[] } : {}),
        ...(inheritedEnv === undefined ? {} : { inheritedEnv }),
      };
    }
    if (!PASEO_BUILTIN_EXTENDS.has(laneProvider)) {
      if (laneProvider === "zcode") return zcodeBaseProvider(inheritedEnv);
      return {
        extends: fallbackBuiltinExtends(providers),
        ...(inheritedEnv === undefined ? {} : { inheritedEnv }),
      };
    }
  }
  if (laneProvider === "zcode") return zcodeBaseProvider(undefined);
  if (PASEO_BUILTIN_EXTENDS.has(laneProvider)) {
    return { extends: laneProvider };
  }
  return { extends: fallbackBuiltinExtends(providers) };
}

/**
 * The canonical zcode base provider (v0.0.94, ADR 0046 Decision 1): an
 * `acp`-extending entry running `zcode-acp-server@0.82.1` with the
 * factory-safe env defaults under whatever env the user already put on their
 * own `agents.providers.zcode` entry — the same precedence the registered
 * base entry itself carries, so a valid custom entry and the canonical arm
 * resolve identically.
 */
function zcodeBaseProvider(inheritedEnv: Record<string, string> | undefined): {
  extends: string;
  command: string[];
  inheritedEnv: Record<string, string>;
} {
  return {
    extends: "acp",
    command: [...ZCODE_ACP_COMMAND],
    inheritedEnv: { ...ZCODE_BASE_ENV_DEFAULTS, ...(inheritedEnv ?? {}) },
  };
}

/** One role provider's English description — the picker's hover text. */
const ROLE_DESCRIPTIONS: Record<FactoryRole, string> = {
  supervisor: "The factory Supervisor seat — talks to the Owner, dispatches Leads, accepts tasks; never writes product code.",
  lead: "The factory Lead seat — sets Contracts, spawns and verifies working Peers inside task worktrees.",
  agent: "The factory Peer seat — the working agent that claims a task worktree and lands an attempt.",
};

/**
 * The plugin-owned OpenCode state home (spec v0.0.91 §3) — the XDG root whose
 * `opencode/service.json` Paseo 0.15.0's V2Runtime probes when acquiring an
 * opencode v2 runtime. One computation shared by the reconcile and heal paths
 * so the two can never drift; undefined when no usable `paseoHome` is given.
 */
function opencodeStateDirFor(paseoHome: string | undefined): string | undefined {
  return typeof paseoHome === "string" && paseoHome.trim() !== ""
    ? join(paseoHome, "plugin-state", "paseo-factory", "opencode-state")
    : undefined;
}

/**
 * The plugin-owned factory state root (`<paseoHome>/plugin-state/paseo-factory`)
 * under which the per-seat zcode clean rooms are provisioned
 * (`<stateDir>/zcode-home/<role>`, ticket 01's provisioner); undefined when no
 * usable `paseoHome` is given.
 */
function factoryStateDirFor(paseoHome: string | undefined): string | undefined {
  return typeof paseoHome === "string" && paseoHome.trim() !== ""
    ? join(paseoHome, "plugin-state", "paseo-factory")
    : undefined;
}

/**
 * The base `agents.providers.opencode` arm (spec v0.0.91 §3), shared by the
 * reconcile and heal paths: `agent.create.before` rewrites factory-* seats
 * onto the runtime `opencode` provider, so its env must carry the same
 * isolated state home — the user's own keys on the entry are preserved by the
 * spread, and an explicit `PASEO_OPENCODE_SERVER_URL` or custom
 * `XDG_STATE_HOME` is left exactly as the owner wrote it. Mutates `providers`
 * in place (both callers build a fresh post-sweep table first).
 */
function ensureBaseOpencodeStateDir(
  providers: Record<string, PaseoProviderEntry>,
  opencodeStateDir: string,
): void {
  const baseEntry = providers.opencode;
  const baseEnv = isRecord(baseEntry?.env) ? (baseEntry.env as Record<string, string>) : undefined;
  if (baseEnv?.PASEO_OPENCODE_SERVER_URL === undefined && baseEnv?.XDG_STATE_HOME === undefined) {
    providers.opencode = {
      ...(isRecord(baseEntry) ? (baseEntry as PaseoProviderEntry) : {}),
      env: {
        ...(baseEnv ?? {}),
        XDG_STATE_HOME: opencodeStateDir,
      },
    };
  }
}

/**
 * The base `agents.providers.zcode` arm (v0.0.94, ADR 0046 Decision 1),
 * shared by the reconcile and heal paths so the two can never drift: when
 * `wanted` — any lane names `zcode/...` or ZCode Desktop is installed on the
 * host — the entry exists with `extends: "acp"`, the pinned
 * `zcode-acp-server@0.82.1` command, and the factory-safe env defaults. The
 * user's own keys on the entry are preserved by the spread (the
 * `ensureBaseOpencodeStateDir` law): a valid own `extends`/`command` and every
 * explicit env key stand exactly as the owner wrote them; only absent keys are
 * defaulted. Mutates `providers` in place (both callers build a fresh
 * post-sweep table first).
 */
function ensureBaseZcodeProvider(providers: Record<string, PaseoProviderEntry>, wanted: boolean): void {
  if (!wanted) return;
  const entry = providers.zcode;
  const userRecord = isRecord(entry) ? (entry as PaseoProviderEntry) : {};
  const userLabel = typeof userRecord.label === "string" && userRecord.label.trim() !== "" ? userRecord.label : undefined;
  const userEnv = isRecord(userRecord.env) ? (userRecord.env as Record<string, string>) : undefined;
  const userExtends = typeof userRecord.extends === "string" && userRecord.extends !== "" ? userRecord.extends : undefined;
  const userCommand =
    Array.isArray(userRecord.command) && userRecord.command.length > 0 && userRecord.command.every((part) => typeof part === "string")
      ? (userRecord.command as string[])
      : undefined;
  providers.zcode = {
    ...userRecord,
    label: userLabel ?? ZCODE_BASE_LABEL,
    extends: userExtends ?? "acp",
    command: userCommand ?? [...ZCODE_ACP_COMMAND],
    env: {
      ...ZCODE_BASE_ENV_DEFAULTS,
      ...(userEnv ?? {}),
    },
  };
}

/** Whether any of the six lanes names the `zcode` family — the lane half of the registration trigger. */
function lanesWantZcode(lanes: Lanes): boolean {
  return LANE_NAMES.some((name) => parseLane(lanes[name])?.provider === "zcode");
}

/**
 * The installed-app half of the registration trigger: ZCode Desktop's
 * `zcode.cjs` exists on disk. Callers may inject their own probe path
 * (`zcodeAppPath`) so tests stay hermetic — never the real `/Applications`.
 */
function zcodeAppInstalled(zcodeAppPath?: string): boolean {
  return existsSync(zcodeAppPath ?? ZCODE_CJS_PATH);
}

/**
 * The pure config transform (spec v0.0.27 §Implementation Decisions 1, ADR
 * 0017 §1, ADR 0026 §1): sweeps `sw2-*` and unknown `factory-*` provider keys,
 * writes `factory-supervisor` / `factory-lead` / `factory-peer` mapped from
 * the role's lane with `enabled: true`, `paseoTools: { enabled: false }`,
 * `env.PASEO_FACTORY_SEAT`, and the lane's model as the sole replacement
 * `models` entry (including `thinkingOptions` when the lane names a thinking
 * level, so Paseo Desktop's New Chat composer cannot stay stuck on a cached
 * base-provider model in `AsyncStorage`), sweeps every `sw2-*` / `factory-*`
 * picker profile, and prepends the single `Supervisor (Factory)` profile
 * (model, plan-mode `modeId` when the harness needs one, `thinkingOptionId`
 * when the supervisor lane names a thinking level). A lane that does not parse
 * leaves its provider unwritten (its stale entry is swept, never guessed).
 * It also pins Paseo 0.15.0's `agents.resumeOnStartup: false` (spec v0.0.91
 * §3) and, when a `paseoHome` is given, defaults `XDG_STATE_HOME` onto the
 * `opencode`-extending role providers and the base `agents.providers.opencode`
 * entry — never over an explicit `PASEO_OPENCODE_SERVER_URL` or custom
 * `XDG_STATE_HOME` — so `V2Runtime` never discovers a host-wide OpenCode v2
 * shared service that would reject the factory's `mcpServers` and
 * `PASEO_FACTORY_*` env.
 * Returns the next config plus `changed` — the caller writes only on a real
 * change.
 */
export function reconcilePaseoConfigObject(
  config: PaseoConfigObject,
  lanes: Lanes,
  options?: { paseoHome?: string; zcodeAppPath?: string; userHome?: string },
): { changed: boolean; config: PaseoConfigObject } {
  const original = config;
  const agents = isRecord(original.agents) ? original.agents : {};
  const daemon = isRecord(original.daemon) ? original.daemon : {};
  const rawProviders = isRecord(agents.providers) ? agents.providers : {};
  const providers: Record<string, PaseoProviderEntry> = {};
  for (const [key, value] of Object.entries(rawProviders)) {
    if (isSweptProviderKey(key)) continue; // the sw2-* / stale factory-* sweep
    providers[key] = value as PaseoProviderEntry;
  }
  // The zcode base provider (v0.0.94, ADR 0046 Decision 1): auto-register the
  // `agents.providers.zcode` entry whenever any lane names the zcode family or
  // ZCode Desktop is installed on the host — before the role loop, so a zcode
  // lane's role entries inherit the registered entry exactly as it stands.
  ensureBaseZcodeProvider(providers, lanesWantZcode(lanes) || zcodeAppInstalled(options?.zcodeAppPath));
  // The plugin-owned OpenCode state home (spec v0.0.91 §3) — the XDG root whose
  // `opencode/service.json` Paseo 0.15.0's V2Runtime probes when acquiring an
  // opencode v2 runtime; undefined when no paseoHome is given.
  const opencodeStateDir = opencodeStateDirFor(options?.paseoHome);
  // The factory state root under which the per-seat zcode clean rooms live
  // (v0.0.94, ADR 0046 §3/§4); undefined when no paseoHome is given.
  const factoryStateDir = factoryStateDirFor(options?.paseoHome);
  // The three managed providers, in canonical order — the mapping is computed
  // against the post-sweep table so an `agy` lane inherits the user's custom
  // entry exactly as it stands after the sweep (agy itself is never swept).
  for (const role of ROLE_ORDER) {
    const parsed = parseLane(lanes[ROLE_LANE[role]]);
    if (parsed === undefined) continue; // an unparseable lane writes nothing, never a guessed provider
    const base = baseProviderFor(parsed.provider, providers);
    const env: Record<string, string> = { ...(base.inheritedEnv ?? {}), PASEO_FACTORY_SEAT: role };
    if (base.extends === "pi" && typeof options?.paseoHome === "string" && options.paseoHome.trim() !== "") {
      env.PI_CODING_AGENT_DIR =
        base.inheritedEnv?.PI_CODING_AGENT_DIR ?? join(options.paseoHome, "plugin-state", "paseo-factory", "pi-agent", role);
    }
    // OpenCode v2 shared-service isolation (spec v0.0.91 §3): a discovered shared
    // service rejects custom `mcpServers` and per-agent env, so an opencode-backed
    // seat defaults its state home onto plugin-owned state — unless the owner
    // already pointed the seat at their own server or state home.
    if (base.extends === "opencode" && opencodeStateDir !== undefined && env.PASEO_OPENCODE_SERVER_URL === undefined) {
      env.XDG_STATE_HOME = base.inheritedEnv?.XDG_STATE_HOME ?? opencodeStateDir;
    }
    // The per-seat zcode clean room (v0.0.94, ADR 0046 §3/§4): the role entry's
    // env is what the daemon feeds the spawned `zcode-acp-server` child, so the
    // provisioner's record (ticket 01) rides the entry — filling only keys the
    // seat does not already carry, so the user's own inherited values keep
    // winning (the PI_CODING_AGENT_DIR law). `userHome` is the hermetic seam
    // (tests pass a temp dir; production leaves it undefined for the operator's
    // real home — reads only, the provisioner never writes outside the state dir).
    if (parsed.provider === "zcode" && factoryStateDir !== undefined) {
      for (const [key, value] of Object.entries(
        provisionZcodeHome({ stateDir: factoryStateDir, role, userHome: options?.userHome }),
      )) {
        if (env[key] === undefined) env[key] = value;
      }
    }
    // The replacement `models` catalog: a zcode lane advertises the runtime id
    // `zcode-acp-server` exposes (`builtin:zai-coding-plan\GLM-5.3` — Paseo's
    // `setModelWithSelection` validates the option value verbatim, ADR 0046
    // Gap 2) under a clean display label; every other family stays verbatim.
    const modelEntry: PaseoProviderModelEntry =
      parsed.provider === "zcode"
        ? {
            id: normalizeZcodeRuntimeModelId(parsed.model),
            label: `${stripZcodeProviderPrefix(parsed.model)} (Factory)`,
            isDefault: true,
            ...(parsed.thinking === undefined
              ? {}
              : {
                  thinkingOptions: [{ id: parsed.thinking, label: parsed.thinking, isDefault: true }],
                }),
          }
        : {
            id: parsed.model,
            label: parsed.model,
            isDefault: true,
            ...(parsed.thinking === undefined
              ? {}
              : {
                  thinkingOptions: [{ id: parsed.thinking, label: parsed.thinking, isDefault: true }],
                }),
          };
    const entry: PaseoProviderEntry = {
      extends: base.extends,
      label: FACTORY_ROLE_LABELS[role],
      description: ROLE_DESCRIPTIONS[role],
      ...(base.command === undefined ? {} : { command: base.command }),
      enabled: true,
      paseoTools: { enabled: false },
      env,
      models: [modelEntry],
    };
    providers[FACTORY_ROLE_PROVIDERS[role]] = entry;
  }
  // The base `opencode` entry too (spec v0.0.91 §3): `agent.create.before`
  // rewrites factory-* seats onto the runtime `opencode` provider, so its env
  // must carry the same isolated state home — the user's own keys on the entry
  // are preserved by the spread, and an explicit `PASEO_OPENCODE_SERVER_URL`
  // or custom `XDG_STATE_HOME` is left exactly as the owner wrote it.
  if (opencodeStateDir !== undefined) {
    ensureBaseOpencodeStateDir(providers, opencodeStateDir);
  }
  // The picker: every sw2-* / factory-* row goes, and exactly one
  // `Supervisor (Factory)` profile is prepended — model, the harness's
  // plan-mode id, and the lane's thinking level when it names one.
  const keptProfiles = (Array.isArray(daemon.agentProfiles) ? daemon.agentProfiles : []).filter(
    (profile) => !isRecord(profile) || !isSweptProfile(profile as PaseoAgentProfile),
  );
  const profiles: PaseoAgentProfile[] = [...keptProfiles];
  const supervisorLane = parseLane(lanes.supervisor);
  if (supervisorLane !== undefined) {
    const normalizedSupervisorFamily =
      supervisorLane.provider === "claude-code"
        ? "claude"
        : supervisorLane.provider === "agy"
          ? "antigravity"
          : supervisorLane.provider;
    const modeId = SUPERVISOR_PROFILE_MODE_ID[normalizedSupervisorFamily];
    profiles.unshift({
      id: FACTORY_ROLE_PROVIDERS.supervisor,
      name: FACTORY_ROLE_LABELS.supervisor,
      provider: FACTORY_ROLE_PROVIDERS.supervisor,
      // A zcode supervisor lane's catalog advertises the normalized runtime id,
      // so the picker row carries it too — every other family stays verbatim.
      model:
        supervisorLane.provider === "zcode" ? normalizeZcodeRuntimeModelId(supervisorLane.model) : supervisorLane.model,
      ...(modeId === undefined ? {} : { modeId }),
      ...(supervisorLane.thinking === undefined ? {} : { thinkingOptionId: supervisorLane.thinking }),
    });
  }
  // Paseo 0.15.0's agents.resumeOnStartup (defaulting true on 0.15.0-beta.1 hosts)
  // would re-prompt interrupted agents with "Resume working." after a daemon
  // restart — ahead of ADR 0003 (recoveredAttempts) and ADR 0013/0015
  // (startupRecovery) — so the reconcile pins it false unconditionally (spec
  // v0.0.91 §3): the factory's own recovery stays the sole authority.
  const next: PaseoConfigObject = {
    ...original,
    agents: { ...agents, resumeOnStartup: false, providers },
    daemon: { ...daemon, agentProfiles: profiles },
  };
  const changed = JSON.stringify(next) !== JSON.stringify(original);
  return { changed, config: next };
}

/** What `reconcilePaseoRoleProviders` can report — a named refusal never a crash, a change never silent. */
export type ReconcileRoleProvidersResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * The file-backed wrapper over `reconcilePaseoConfigObject`: reads
 * `<paseoHome>/config.json` (an absent file starts from `{}`; a file that is
 * not valid JSON is a named refusal — a user's broken config is never
 * overwritten), reconciles it, and writes it back atomically (`tmp` +
 * `renameSync`, the ledger's law) ONLY when the reconciled object differs —
 * so repeated runs never churn the daemon. When the file changed and a
 * `reloadDaemon` door is given, it fires once, non-blocking, so the daemon
 * re-reads its config without the plugin ever awaiting it.
 */
export function reconcilePaseoRoleProviders(
  paseoHome: string,
  lanes: Lanes,
  deps?: { reloadDaemon?: (paseoHome: string) => void; zcodeAppPath?: string; userHome?: string },
): ReconcileRoleProvidersResult {
  const path = join(paseoHome, "config.json");
  let config: PaseoConfigObject = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(parsed)) return { ok: false, reason: `${path} is not a JSON object — leaving it untouched` };
      config = parsed as PaseoConfigObject;
    } catch {
      return { ok: false, reason: `${path} is not valid JSON — leaving it untouched` };
    }
  }
  const { changed, config: next } = reconcilePaseoConfigObject(config, lanes, {
    paseoHome,
    ...(deps?.zcodeAppPath === undefined ? {} : { zcodeAppPath: deps.zcodeAppPath }),
    ...(deps?.userHome === undefined ? {} : { userHome: deps.userHome }),
  });
  if (!changed) return { ok: true, changed: false };
  try {
    mkdirSync(paseoHome, { recursive: true });
    // The daemon keeps config.json owner-only (0o600 on a live home) — a
    // rewrite must not loosen it, and a first write starts tight.
    let mode = 0o600;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      // absent file — the tight default stands
    }
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, reason: `writing ${path} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (deps?.reloadDaemon !== undefined) deps.reloadDaemon(paseoHome);
  return { ok: true, changed: true };
}

/**
 * Pure sanitizer for an existing `<paseoHome>/config.json` object: sweeps
 * orphaned `sw2-*` / unknown `factory-*` provider entries and heals any
 * `factory-supervisor` / `factory-lead` / `factory-peer` entry whose `extends`
 * would be rejected by Paseo 0.13.0's `ProviderOverridesSchema` (such as
 * `"extends": "antigravity"` left by v0.0.40 or `"extends": "acp"` without a
 * non-empty `command` array) onto a valid built-in `extends` (`"opencode"` or custom
 * `acp` command), promoting `additionalModels` to `models` when `models` is
 * absent. It also heals the 0.15.0-beta.1 legacy `agents.resumeOnStartup: true`
 * back to `false` and, when a `paseoHome` is given, a missing `XDG_STATE_HOME`
 * onto `opencode`-extending role providers and the base
 * `agents.providers.opencode` entry (spec v0.0.91 §3) — under the reconcile
 * path's explicit-user-setting precedence.
 */
export function healFactoryRoleProvidersObject(
  config: PaseoConfigObject,
  options?: { paseoHome?: string; zcodeAppPath?: string },
): { changed: boolean; config: PaseoConfigObject } {
  const original = config;
  if (!isRecord(original.agents)) {
    return { changed: false, config: original };
  }
  const agents = original.agents;
  // The startup auto-resume guard (spec v0.0.91 §3): heal the 0.15.0-beta.1
  // legacy `resumeOnStartup: true` back to false — the factory's own recovery
  // (ADR 0003 / ADR 0013 / ADR 0015) stays the sole authority after a restart.
  const resumeHealed = agents.resumeOnStartup === true;
  if (!isRecord(agents.providers)) {
    if (!resumeHealed) return { changed: false, config: original };
    return { changed: true, config: { ...original, agents: { ...agents, resumeOnStartup: false } } };
  }
  // The plugin-owned OpenCode state home (spec v0.0.91 §3) — same dir and same
  // explicit-user-setting precedence as the reconcile path.
  const opencodeStateDir = opencodeStateDirFor(options?.paseoHome);
  const rawProviders = agents.providers as Record<string, unknown>;
  const providers: Record<string, PaseoProviderEntry> = {};
  for (const [key, value] of Object.entries(rawProviders)) {
    if (isSweptProviderKey(key)) continue;
    providers[key] = value as PaseoProviderEntry;
  }
  for (const role of ROLE_ORDER) {
    const key = FACTORY_ROLE_PROVIDERS[role];
    const rawEntry = providers[key];
    if (!isRecord(rawEntry)) continue;
    const entry: PaseoProviderEntry = { ...(rawEntry as PaseoProviderEntry) };
    const rawExtends = typeof entry.extends === "string" && entry.extends !== "" ? entry.extends : "";
    const hasValidCommand =
      Array.isArray(entry.command) && entry.command.length > 0 && entry.command.every((part) => typeof part === "string");
    const isValidExtends = PASEO_BUILTIN_EXTENDS.has(rawExtends) || (rawExtends === "acp" && hasValidCommand);
    if (!isValidExtends) {
      const base = baseProviderFor(rawExtends, providers);
      entry.extends = base.extends;
      if (base.command !== undefined) {
        entry.command = base.command;
      } else if (!hasValidCommand) {
        delete entry.command;
      }
    }
    if (entry.extends === "pi" && typeof options?.paseoHome === "string" && options.paseoHome.trim() !== "") {
      const existingEnv = isRecord(entry.env) ? (entry.env as Record<string, string>) : {};
      entry.env = {
        ...existingEnv,
        PASEO_FACTORY_SEAT: existingEnv.PASEO_FACTORY_SEAT ?? role,
        PI_CODING_AGENT_DIR:
          existingEnv.PI_CODING_AGENT_DIR ?? join(options.paseoHome, "plugin-state", "paseo-factory", "pi-agent", role),
      };
    }
    // OpenCode v2 shared-service isolation (spec v0.0.91 §3): heal a missing
    // XDG_STATE_HOME onto opencode-extending role providers — never over an
    // explicit PASEO_OPENCODE_SERVER_URL or custom state home.
    if (entry.extends === "opencode" && opencodeStateDir !== undefined) {
      const existingEnv = isRecord(entry.env) ? (entry.env as Record<string, string>) : {};
      if (existingEnv.PASEO_OPENCODE_SERVER_URL === undefined && existingEnv.XDG_STATE_HOME === undefined) {
        entry.env = { ...existingEnv, XDG_STATE_HOME: opencodeStateDir };
      }
    }
    if (entry.models === undefined && Array.isArray(entry.additionalModels)) {
      entry.models = entry.additionalModels;
      delete entry.additionalModels;
    }
    providers[key] = entry;
  }
  // The base `opencode` entry arm (spec v0.0.91 §3) — same merge and same
  // explicit-user-setting precedence as the reconcile path.
  if (opencodeStateDir !== undefined) {
    ensureBaseOpencodeStateDir(providers, opencodeStateDir);
  }
  // The base `zcode` entry arm (v0.0.94, ADR 0046 Decision 1) — the heal has
  // no lanes, so its trigger is the installed app OR the entry itself already
  // standing (one registered by the reconcile's lane arm never rots): same
  // merge and same user-key precedence as the reconcile path, so the two can
  // never drift.
  ensureBaseZcodeProvider(providers, zcodeAppInstalled(options?.zcodeAppPath) || isRecord(providers.zcode));
  let nextDaemon = original.daemon;
  if (isRecord(original.daemon) && Array.isArray(original.daemon.agentProfiles)) {
    const filteredProfiles = original.daemon.agentProfiles.filter((profile) => {
      if (!isRecord(profile)) return true;
      const id = typeof profile.id === "string" ? profile.id : "";
      const prov = typeof profile.provider === "string" ? profile.provider : "";
      return !isSweptProviderKey(id) && !isSweptProviderKey(prov);
    });
    if (filteredProfiles.length !== original.daemon.agentProfiles.length) {
      nextDaemon = { ...original.daemon, agentProfiles: filteredProfiles };
    }
  }
  const next: PaseoConfigObject = {
    ...original,
    agents: resumeHealed ? { ...agents, providers, resumeOnStartup: false } : { ...agents, providers },
    ...(nextDaemon === original.daemon ? {} : { daemon: nextDaemon }),
  };
  const changed = JSON.stringify(next) !== JSON.stringify(original);
  return { changed, config: next };
}

/**
 * Self-heals an existing `<paseoHome>/config.json` on disk before the plugin
 * opens a new daemon WebSocket session. In Paseo 0.13.0, every WebSocket
 * `hello` handshake constructs `new Session()`, which synchronously calls
 * `loadPersistedConfig(paseoHome)` from disk and closes the socket with code
 * `4002 ("Invalid hello")` if any `agents.providers.factory-*` entry has an
 * `extends` outside `BUILTIN_PROVIDER_IDS ∪ {"acp"}` (for example,
 * `"extends": "antigravity"` written by v0.0.40). Healing the file on disk
 * before connecting lets the running daemon's `hello` handshake succeed
 * immediately without a daemon restart. Never creates a missing file and never
 * throws.
 */
export function healFactoryRoleProvidersInConfig(paseoHome: string, deps?: { zcodeAppPath?: string }): boolean {
  if (typeof paseoHome !== "string" || paseoHome.trim() === "") return false;
  const path = join(paseoHome, "config.json");
  if (!existsSync(path)) return false;
  let config: PaseoConfigObject;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return false;
    config = parsed as PaseoConfigObject;
  } catch {
    return false;
  }
  const { changed, config: next } = healFactoryRoleProvidersObject(config, {
    paseoHome,
    ...(deps?.zcodeAppPath === undefined ? {} : { zcodeAppPath: deps.zcodeAppPath }),
  });
  if (!changed) return false;
  try {
    let mode = 0o600;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      // keep 0o600 default
    }
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lane table the role providers reconcile from (ADR 0017 §1, ADR 0026 §1):
 * when `preferredProjectSlug` is given, that Project's effective `Lanes` table;
 * otherwise, when `<stateDir>/lanes.json` exists, the most recently modified
 * valid scope between `<stateDir>/lanes.json` and any registered Project's
 * `<projectStateDir>/lanes.json` (so plugin boot reflects the latest Project or
 * machine lane save); otherwise — a machine that never named its lanes — the
 * cleanest effective table across the registered projects' own override files:
 * per lane, the value the majority of projects run, ties broken by the first
 * registration (slug order, deterministic), absent everywhere → the safe
 * default. A broken machine file is the same named refusal `loadLanes` gives
 * (boot logs it and skips the reconcile); a broken project entry is skipped,
 * never trusted.
 */
export function effectiveLanesForReconcile(stateDir: string, preferredProjectSlug?: string): LanesResult {
  if (preferredProjectSlug !== undefined) {
    return loadLanes(stateDir, preferredProjectSlug);
  }
  const machineFile = lanesPath(stateDir);
  if (existsSync(machineFile)) {
    const machineLoaded = loadLanes(stateDir);
    if (!machineLoaded.ok) return machineLoaded;
    let newestMtime = 0;
    try {
      newestMtime = statSync(machineFile).mtimeMs;
    } catch {
      return machineLoaded;
    }
    let newestProjectLanes: LanesResult | undefined;
    for (const registration of listProjectRegistrations(stateDir)) {
      const projFile = projectLanesPath(stateDir, registration.slug);
      if (!existsSync(projFile)) continue;
      try {
        const mtime = statSync(projFile).mtimeMs;
        if (mtime > newestMtime) {
          const candidate = loadLanes(stateDir, registration.slug);
          if (candidate.ok) {
            newestMtime = mtime;
            newestProjectLanes = candidate;
          }
        }
      } catch {
        // skip unreadable project override
      }
    }
    return newestProjectLanes ?? machineLoaded;
  }
  const lanes = defaultLanes();
  const tally = new Map<LaneName, { counts: Map<string, number>; first: string }>();
  for (const registration of listProjectRegistrations(stateDir)) {
    const entries = explicitLaneEntries(projectLanesPath(stateDir, registration.slug));
    for (const name of Object.keys(entries) as LaneName[]) {
      const value = entries[name];
      if (value === undefined) continue;
      const slot = tally.get(name) ?? { counts: new Map<string, number>(), first: value };
      slot.counts.set(value, (slot.counts.get(value) ?? 0) + 1);
      tally.set(name, slot);
    }
  }
  for (const [name, slot] of tally) {
    let best = slot.first;
    let bestCount = -1;
    for (const [value, count] of slot.counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    lanes[name] = best;
  }
  return { ok: true, lanes };
}

/**
 * The lanes one project override file itself names — the same reader law as
 * `lanes.ts`'s private `explicitLanes` (absent/unreadable → nothing, a
 * non-string or invalid value → skipped, never trusted), local so the module
 * owns no edit of `lanes.ts`.
 */
function explicitLaneEntries(path: string): Partial<Record<LaneName, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const explicit: Partial<Record<LaneName, string>> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!LANE_NAMES.includes(name as LaneName)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (laneError(name as LaneName, trimmed) !== undefined) continue;
    explicit[name as LaneName] = trimmed;
  }
  return explicit;
}
