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
import { defaultLanes, LANE_NAMES, laneError, lanesPath, loadLanes, parseLane, projectLanesPath } from "./lanes.ts";
import type { LaneName, Lanes, LanesResult } from "./lanes.ts";
import { listProjectRegistrations } from "./project.ts";

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
const FALLBACK_BUILTIN_ORDER = ["pi", "opencode", "claude", "codex", "copilot", "omp"] as const;

function fallbackBuiltinExtends(providers: Record<string, PaseoProviderEntry>): string {
  for (const candidate of FALLBACK_BUILTIN_ORDER) {
    const entry = providers[candidate];
    if (!isRecord(entry) || entry.enabled !== false) return candidate;
  }
  return "pi";
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
      return {
        extends: fallbackBuiltinExtends(providers),
        ...(inheritedEnv === undefined ? {} : { inheritedEnv }),
      };
    }
  }
  if (PASEO_BUILTIN_EXTENDS.has(laneProvider)) {
    return { extends: laneProvider };
  }
  return { extends: fallbackBuiltinExtends(providers) };
}

/** One role provider's English description — the picker's hover text. */
const ROLE_DESCRIPTIONS: Record<FactoryRole, string> = {
  supervisor: "The factory Supervisor seat — talks to the Owner, dispatches Leads, accepts tasks; never writes product code.",
  lead: "The factory Lead seat — sets Contracts, spawns and verifies working Peers inside task worktrees.",
  agent: "The factory Peer seat — the working agent that claims a task worktree and lands an attempt.",
};

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
 * Returns the next config plus `changed` — the caller writes only on a real
 * change.
 */
export function reconcilePaseoConfigObject(config: PaseoConfigObject, lanes: Lanes): { changed: boolean; config: PaseoConfigObject } {
  const original = config;
  const agents = isRecord(original.agents) ? original.agents : {};
  const daemon = isRecord(original.daemon) ? original.daemon : {};
  const rawProviders = isRecord(agents.providers) ? agents.providers : {};
  const providers: Record<string, PaseoProviderEntry> = {};
  for (const [key, value] of Object.entries(rawProviders)) {
    if (isSweptProviderKey(key)) continue; // the sw2-* / stale factory-* sweep
    providers[key] = value as PaseoProviderEntry;
  }
  // The three managed providers, in canonical order — the mapping is computed
  // against the post-sweep table so an `agy` lane inherits the user's custom
  // entry exactly as it stands after the sweep (agy itself is never swept).
  for (const role of ROLE_ORDER) {
    const parsed = parseLane(lanes[ROLE_LANE[role]]);
    if (parsed === undefined) continue; // an unparseable lane writes nothing, never a guessed provider
    const base = baseProviderFor(parsed.provider, providers);
    const env: Record<string, string> = { ...(base.inheritedEnv ?? {}), PASEO_FACTORY_SEAT: role };
    const modelEntry: PaseoProviderModelEntry = {
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
      model: supervisorLane.model,
      ...(modeId === undefined ? {} : { modeId }),
      ...(supervisorLane.thinking === undefined ? {} : { thinkingOptionId: supervisorLane.thinking }),
    });
  }
  const next: PaseoConfigObject = { ...original, agents: { ...agents, providers }, daemon: { ...daemon, agentProfiles: profiles } };
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
  deps?: { reloadDaemon?: (paseoHome: string) => void },
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
  const { changed, config: next } = reconcilePaseoConfigObject(config, lanes);
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
 * non-empty `command` array) onto a valid built-in `extends` (`"pi"` or custom
 * `acp` command), promoting `additionalModels` to `models` when `models` is
 * absent.
 */
export function healFactoryRoleProvidersObject(config: PaseoConfigObject): { changed: boolean; config: PaseoConfigObject } {
  const original = config;
  if (!isRecord(original.agents) || !isRecord(original.agents.providers)) {
    return { changed: false, config: original };
  }
  const agents = original.agents;
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
    if (entry.models === undefined && Array.isArray(entry.additionalModels)) {
      entry.models = entry.additionalModels;
      delete entry.additionalModels;
    }
    providers[key] = entry;
  }
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
    agents: { ...agents, providers },
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
export function healFactoryRoleProvidersInConfig(paseoHome: string): boolean {
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
  const { changed, config: next } = healFactoryRoleProvidersObject(config);
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
