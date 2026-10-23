/**
 * The daemon CLI bridge (v0.0.13, ADR 0009 §3): the few daemon acts the
 * in-process PaseoApi does not expose — setting a live agent's model, and
 * stopping a running agent — ride a child process into the paseo CLI's own
 * client (the PigMonitor-proven pattern): locate `paseo` on PATH, resolve
 * `<cli>/../dist/utils`, spawn node importing its `connectToDaemon` +
 * `selectDaemonTarget`, call the method, print JSON. `paseo agent stop` is a
 * plain CLI invocation. Both are best-effort callers: a failure is a named
 * reason in the reply, never a thrown error — the config of record stays
 * lanes.json either way.
 *
 * v0.0.17 (ADR 0012 §2–§4): the session WebSocket grew a payload-returning
 * core (`daemonWsRequestPayload`) and the plugin lifecycle trio
 * (`listDaemonPlugins` / `installDaemonPlugin` / `manageDaemonPlugin`) speaks
 * Paseo's native plugin.* messages over it, CLI fallbacks behind — every
 * function takes the daemon `home` first.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter as pathDelimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isElectronNodeBinary } from "./core/pi-home.ts";

export type DaemonReply = { ok: true } | { ok: false; reason: string };

/** How long a bridge call may take before the socket/child is closed. */
export const BRIDGE_TIMEOUT_MS = 30_000;

/** How long a plugin install/update may take — a Git clone/fetch over the network never times out prematurely (v0.0.17, ADR 0012 §4). */
export const PLUGIN_IO_TIMEOUT_MS = 300_000;

/** How long a daemon plugin list stays fresh (v0.0.20, ADR 0013 §1) — the 5s UI poll cadence shares one list. */
export const PLUGIN_LIST_TTL_MS = 15_000;

/** A daemon reply that also carries the response message's payload (v0.0.17). */
export type DaemonPayloadReply<T> = { ok: true; payload: T } | { ok: false; reason: string };

/**
 * Direct daemon WebSocket call using `<home>/paseo.pid` and `<home>/local-credential`
 * (same protocol as driver.mjs), returning the response payload.
 */
function daemonWsRequestPayload<T>(
  home: string,
  message: Record<string, unknown>,
  responseType: string,
  timeoutMs: number = BRIDGE_TIMEOUT_MS,
): Promise<DaemonPayloadReply<T>> | null {
  const pidPath = join(home, "paseo.pid");
  const credPath = join(home, "local-credential");
  if (!existsSync(pidPath) || !existsSync(credPath)) return null;
  let listen: string;
  let token: string;
  try {
    const pid = JSON.parse(readFileSync(pidPath, "utf8")) as { listen?: unknown };
    token = readFileSync(credPath, "utf8").trim();
    if (typeof pid.listen !== "string" || pid.listen === "" || token === "") return null;
    listen = pid.listen;
  } catch {
    return null;
  }
  const requestId = `factory-bridge-${randomUUID().slice(0, 8)}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${listen}/ws`);
    let settled = false;
    const finish = (reply: DaemonPayloadReply<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `no ${responseType} within ${timeoutMs}ms` }), timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: `paseo-factory-surface-${randomUUID().slice(0, 8)}`,
          clientType: "cli",
          protocolVersion: 1,
          auth: { kind: "localCredential", token },
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (envelope.type === "hello.rejected") {
        finish({ ok: false, reason: `daemon rejected hello: ${String(envelope.reason ?? "")}` });
        return;
      }
      if (envelope.type !== "session" || typeof envelope.message !== "object" || envelope.message === null) return;
      const msg = envelope.message as { type?: string; payload?: { status?: string; requestId?: string; error?: string | null } };
      if (msg.type === "status" && msg.payload?.status === "server_info") {
        ws.send(JSON.stringify({ type: "session", message: { ...message, requestId } }));
        return;
      }
      if (msg.type === "rpc_error" && msg.payload?.requestId === requestId) {
        finish({ ok: false, reason: msg.payload.error ?? "daemon rpc error" });
        return;
      }
      if (msg.type === responseType && msg.payload?.requestId === requestId) {
        if (typeof msg.payload.error === "string" && msg.payload.error !== "") {
          finish({ ok: false, reason: msg.payload.error });
        } else {
          finish({ ok: true, payload: msg.payload as T });
        }
      }
    });
    ws.addEventListener("error", () => finish({ ok: false, reason: `daemon socket error (ws://${listen}/ws)` }));
    ws.addEventListener("close", () => finish({ ok: false, reason: "daemon socket closed before response" }));
  });
}

/** The ok-only view of a WebSocket call — the payload-discarding wrapper the seat bridges keep. */
function daemonWsRequest(
  home: string,
  message: Record<string, unknown>,
  responseType: string,
): Promise<DaemonReply> | null {
  const call = daemonWsRequestPayload<unknown>(home, message, responseType);
  if (call === null) return null;
  return call.then((reply): DaemonReply => (reply.ok ? { ok: true } : { ok: false, reason: reply.reason }));
}

/** The bridge body: import the CLI's own daemon client, call one method, print JSON. */
const BRIDGE = `
const [utils, method] = process.argv.slice(1);
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const args = JSON.parse(Buffer.concat(input).toString("utf8"));
const { connectToDaemon } = await import(utils + "/client.js");
const { selectDaemonTarget } = await import(utils + "/daemon-target.js");
const client = await connectToDaemon({ target: selectDaemonTarget({}) });
try {
  const result = await client[method](...args);
  process.stdout.write(JSON.stringify(result ?? null));
} finally {
  await client.close();
}
`;

/**
 * Resolves the paseo CLI's `dist/utils` directory from PATH — null when the CLI or its utils are absent.
 * The search path splits on `node:path`'s `delimiter` (`:` on POSIX, `;` on Windows, v0.0.17) —
 * the separator is a parameter only so tests can exercise the Windows arm on any host.
 */
export function cliUtils(searchPath: string = process.env.PATH ?? "", separator: string = pathDelimiter): string | null {
  for (const dir of searchPath.split(separator)) {
    if (dir === "") continue;
    const bin = join(dir, "paseo");
    if (!existsSync(bin)) continue;
    const utils = join(dirname(realpathSync(bin)), "..", "dist", "utils");
    if (existsSync(join(utils, "client.js")) && existsSync(join(utils, "daemon-target.js"))) return utils;
  }
  return null;
}

/** One bridge method call — JSON over stdio, one deadline, a named reason on any death. */
function bridgeCall(method: string, args: unknown[], home?: string): Promise<DaemonReply> {
  const utils = cliUtils();
  if (utils === null) {
    return Promise.resolve({ ok: false, reason: "the paseo CLI was not found on the plugin's PATH — cannot reach the daemon methods the in-process API lacks" });
  }
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ...(home === undefined ? {} : { PASEO_HOME: home }),
      NO_COLOR: "1",
      // Under Paseo Desktop process.execPath is the Electron helper — the
      // Node `-e` module eval aborts without Node mode (v0.0.27, ADR 0017 §2,
      // problem 3 — the bridge.mjs precedent).
      ...(isElectronNodeBinary(process.execPath) ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };
    const child = spawn(process.execPath, ["--input-type=module", "-e", BRIDGE, pathToFileURL(utils).href, method], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), BRIDGE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      const stderr = Buffer.concat(err).toString("utf8");
      const said = /^\w*Error: (.+)$/m.exec(stderr)?.[1] ?? stderr.trim();
      resolve({ ok: false, reason: said !== "" ? said : `the paseo CLI bridge exited with ${code ?? "a signal"}` });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(args));
  });
}

/** Updates a live agent's model over the daemon's WebSocket RPC (or CLI fallback). */
export function setAgentModelViaCli(agentId: string, model: string, home?: string): Promise<DaemonReply> {
  const targetHome = home ?? process.env.PASEO_HOME;
  if (targetHome !== undefined) {
    const wsCall = daemonWsRequest(targetHome, { type: "set_agent_model_request", agentId, modelId: model }, "set_agent_model_response");
    if (wsCall !== null) return wsCall;
  }
  return bridgeCall("setAgentModel", [agentId, model], home);
}

/** Updates a live agent's thinking option over the daemon's WebSocket RPC (or CLI fallback). */
export function setAgentThinkingViaCli(agentId: string, thinkingOptionId: string, home?: string): Promise<DaemonReply> {
  const targetHome = home ?? process.env.PASEO_HOME;
  if (targetHome !== undefined) {
    const wsCall = daemonWsRequest(targetHome, { type: "set_agent_thinking_request", agentId, thinkingOptionId }, "set_agent_thinking_response");
    if (wsCall !== null) return wsCall;
  }
  return bridgeCall("setAgentThinkingOption", [agentId, thinkingOptionId], home);
}

/** Cancels a running agent over the daemon's WebSocket RPC (or `paseo agent stop` fallback). */
export function stopAgentViaCli(agentId: string, home?: string): Promise<DaemonReply> {
  const targetHome = home ?? process.env.PASEO_HOME;
  if (targetHome !== undefined) {
    const wsCall = daemonWsRequest(targetHome, { type: "cancel_agent_request", agentId }, "cancel_agent_response");
    if (wsCall !== null) return wsCall;
  }
  return new Promise((resolve) => {
    const argv = home === undefined ? ["agent", "stop", agentId] : ["--home", home, "agent", "stop", agentId];
    const env = home === undefined ? process.env : { ...process.env, PASEO_HOME: home };
    const probe = spawnSync("paseo", argv, { encoding: "utf8", timeout: BRIDGE_TIMEOUT_MS, env });
    if (probe.status === 0) return resolve({ ok: true });
    const detail = (probe.stderr || probe.stdout || "").trim().split("\n")[0] ?? "";
    resolve({ ok: false, reason: detail !== "" ? detail : `paseo agent stop exited with ${probe.status ?? "a signal"}` });
  });
}

// ---- the plugin lifecycle bridge (v0.0.17, ADR 0012 §2–§4) ---------------------------------
//
// Paseo's native plugin lifecycle, spoken over the same session WebSocket
// (`<home>/paseo.pid` + `<home>/local-credential`) with the paseo CLI as the
// fallback when no daemon answers. Every function takes the daemon `home`
// first — trial (`~/.paseo-factory`) and production (`~/.paseo`) plugin
// state never cross-contaminate.

/** How a plugin was installed — the protocol's `PluginSourceIdentity` kinds. */
export type DaemonPluginIdentity =
  | { kind: "directory"; path: string }
  | { kind: "git"; remote: string; pluginPath?: string; registry?: { url: string; id: string } }
  | { kind: "npm"; packageName: string; pluginPath?: string; registry?: { url: string; id: string } };

/** A daemon plugin list item — the structural slice of the protocol's `PluginListItem` the surface reads. */
export interface DaemonPluginItem {
  id: string;
  name?: string;
  path: string;
  enabled: boolean;
  status: "running" | "failed" | "disabled";
  source?: "git" | "directory";
  npm?: { packageName: string; requestedSpec?: string; version?: string; integrity?: string };
  installation?: { identity: DaemonPluginIdentity; currentRevision?: string };
  remote?: string;
  ref?: string;
  commit?: string;
  /** Semantic version resolved from npm metadata or <path>/package.json / <path>/../package.json (v0.0.25, ADR 0012 §3). */
  version?: string;
  error?: string;
}

/** One plugin's remote update status from `plugin.source.status.response` (v0.0.25, ADR 0012 §4). */
export interface DaemonPluginSourceStatus {
  id: string;
  currentRevision: string | null;
  latestRevision: string | null;
  commitsBehind: number | null;
  updateAvailable: boolean | null;
}

/** Cached on-demand update check result for a daemon home (v0.0.25, ADR 0012 §4). */
export interface DaemonPluginUpdateCheckSnapshot {
  statuses: ReadonlyMap<string, DaemonPluginSourceStatus>;
  checkedAt: string;
}

/**
 * Reads the semantic `"version"` field from `<pluginPath>/package.json`,
 * `<pluginPath>/../package.json`, or `<pluginPath>/paseo-plugin.json` when
 * present on disk (v0.0.25, ADR 0012 §3). Never throws.
 */
export function readPluginVersionFromDisk(pluginPath: string): string | undefined {
  if (typeof pluginPath !== "string" || pluginPath.trim() === "") return undefined;
  const candidates = [
    join(pluginPath, "package.json"),
    join(pluginPath, "..", "package.json"),
    join(pluginPath, "paseo-plugin.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed?.version === "string" && parsed.version.trim() !== "") {
        return parsed.version.trim();
      }
    } catch {
      // ignore unreadable or malformed manifest
    }
  }
  return undefined;
}

function enrichDaemonPluginItem(item: DaemonPluginItem): DaemonPluginItem {
  const version = item.version ?? item.npm?.version ?? readPluginVersionFromDisk(item.path);
  return version === undefined ? item : { ...item, version };
}

/** One row of a `plugin.source.update.response` — what changed for one plugin id. */
export interface DaemonPluginUpdateRow {
  id: string;
  previousCommit?: string;
  currentCommit?: string;
  commits?: number;
  updated: boolean;
}

/** The manage actions the bridge speaks (spec §Implementation Decisions 4). */
export type DaemonPluginAction = "enable" | "disable" | "reload" | "update" | "remove";

function isDaemonPluginItem(value: unknown): value is DaemonPluginItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { id?: unknown; path?: unknown };
  return typeof item.id === "string" && typeof item.path === "string";
}

/** One `paseo` CLI invocation answering parsed `--json` stdout — a named reason on any death. */
function pluginCliJson(home: string, argv: string[], timeoutMs: number): { ok: true; value: unknown } | { ok: false; reason: string } {
  const env = { ...process.env, PASEO_HOME: home, NO_COLOR: "1" };
  const probe = spawnSync("paseo", argv, { encoding: "utf8", timeout: timeoutMs, env });
  if (probe.error !== undefined) return { ok: false, reason: probe.error.message };
  if (probe.status !== 0) {
    const detail = (probe.stderr || probe.stdout || "").trim().split("\n")[0] ?? "";
    return { ok: false, reason: detail !== "" ? detail : `paseo ${argv.join(" ")} exited with ${probe.status ?? "a signal"}` };
  }
  try {
    return { ok: true, value: JSON.parse(probe.stdout) };
  } catch {
    const detail = probe.stdout.trim().split("\n")[0] ?? "";
    return { ok: false, reason: detail !== "" ? `paseo ${argv.join(" ")} printed non-JSON output: ${detail}` : `paseo ${argv.join(" ")} printed no output` };
  }
}

/** Unwraps a CLI `--json` answer that may be the item itself or wrapped as `{ plugin }` / listed under `plugins`. */
function pluginsFromCliJson(value: unknown): DaemonPluginItem[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { plugins?: unknown }).plugins)
      ? ((value as { plugins: unknown[] }).plugins)
      : typeof value === "object" && value !== null && isDaemonPluginItem((value as { plugin?: unknown }).plugin)
        ? [(value as { plugin: unknown }).plugin]
        : [value];
  return candidates.filter(isDaemonPluginItem);
}

/**
 * The per-`home` plugin-list cache (v0.0.20, ADR 0013 §1): a 15s TTL plus an
 * in-flight Promise map, so concurrent `factory.surface.snapshot` calls share
 * one WebSocket `plugin.list.request` — the providers precedent
 * (`PROVIDERS_TTL_MS`/`cachedProviders`/`inFlightProviders` in
 * surface-rpc.ts) restated for the bridge. Keyed per `home` (the bridge's own
 * trial/prod isolation law above); only ok replies are cached — a
 * `{ ok: false }` answer returns uncached so the surface's degrade law keeps
 * retrying on the next snapshot. `installDaemonPlugin` and
 * `manageDaemonPlugin` drop their `home` entry at entry, so a failed mutation
 * still costs at most one re-list.
 */
interface PluginListCacheEntry {
  plugins: DaemonPluginItem[];
  cachedAt: number;
}
const pluginListCache = new Map<string, PluginListCacheEntry>();
const pluginListInFlight = new Map<string, Promise<{ ok: true; plugins: DaemonPluginItem[] } | { ok: false; reason: string }>>();
const pluginListGeneration = new Map<string, number>();
const pluginUpdateCache = new Map<string, DaemonPluginUpdateCheckSnapshot>();

/**
 * Drops the cached plugin list (and cached update statuses) for `home` — and
 * bumps its generation, so a pre-mutation list still in flight when the
 * mutation began cannot land in the cache behind the mutation's back.
 */
function invalidatePluginListCache(home: string): void {
  pluginListCache.delete(home);
  pluginUpdateCache.delete(home);
  pluginListGeneration.set(home, (pluginListGeneration.get(home) ?? 0) + 1);
}

/** Returns the cached on-demand update check snapshot for `home`, or `null` if not yet checked (v0.0.25, ADR 0012 §4). */
export function getCachedPluginUpdateStatus(home: string): DaemonPluginUpdateCheckSnapshot | null {
  return pluginUpdateCache.get(home) ?? null;
}

/** The uncached bridge body: `plugin.list.request` → `payload.plugins`, falling back to `paseo --home <home> plugin ls --json`. */
async function listDaemonPluginsUncached(home: string): Promise<{ ok: true; plugins: DaemonPluginItem[] } | { ok: false; reason: string }> {
  const wsCall = daemonWsRequestPayload<{ plugins?: unknown }>(home, { type: "plugin.list.request" }, "plugin.list.response");
  if (wsCall !== null) {
    const reply = await wsCall;
    if (!reply.ok) return { ok: false, reason: reply.reason };
    const plugins = Array.isArray(reply.payload?.plugins) ? reply.payload.plugins.filter(isDaemonPluginItem).map(enrichDaemonPluginItem) : null;
    if (plugins === null) return { ok: false, reason: "the daemon's plugin.list.response carried no plugins array" };
    return { ok: true, plugins };
  }
  const cli = pluginCliJson(home, ["--home", home, "plugin", "ls", "--json"], BRIDGE_TIMEOUT_MS);
  if (!cli.ok) return { ok: false, reason: cli.reason };
  return { ok: true, plugins: pluginsFromCliJson(cli.value).map(enrichDaemonPluginItem) };
}

/**
 * Lists the daemon's plugins through the per-`home` cache: a fresh-enough
 * entry answers from memory, callers racing the same refresh share one
 * in-flight request, and only an ok reply lands in the cache (v0.0.20,
 * ADR 0013 §1).
 */
export async function listDaemonPlugins(home: string): Promise<{ ok: true; plugins: DaemonPluginItem[] } | { ok: false; reason: string }> {
  const cached = pluginListCache.get(home);
  if (cached !== undefined && Date.now() - cached.cachedAt < PLUGIN_LIST_TTL_MS) {
    return { ok: true, plugins: cached.plugins };
  }
  const inFlight = pluginListInFlight.get(home);
  if (inFlight !== undefined) return inFlight;
  const generation = pluginListGeneration.get(home) ?? 0;
  const job = (async () => {
    const reply = await listDaemonPluginsUncached(home);
    if (reply.ok && (pluginListGeneration.get(home) ?? 0) === generation) {
      pluginListCache.set(home, { plugins: reply.plugins, cachedAt: Date.now() });
    }
    return reply;
  })().finally(() => {
    if (pluginListInFlight.get(home) === job) pluginListInFlight.delete(home);
  });
  pluginListInFlight.set(home, job);
  return job;
}

/**
 * An explicit local path source — routes the install to the directory request.
 * `/`, `.`, `~`, or a Windows drive path (`C:\…` / `C:/…`); `~` stays literal,
 * the daemon resolves it (spec §Implementation Decisions 4).
 */
function isLocalPathSource(source: string): boolean {
  return source.startsWith("/") || source.startsWith(".") || source.startsWith("~") || /^[A-Za-z]:[\\/]/.test(source);
}

/** Installs a plugin (`plugin.source.install.request` / `plugin.directory.install.request`), falling back to the paseo CLI. */
export async function installDaemonPlugin(
  home: string,
  input: { id: string; source: string; ref?: string },
): Promise<{ ok: true; plugin: DaemonPluginItem } | { ok: false; reason: string }> {
  invalidatePluginListCache(home);
  const request = isLocalPathSource(input.source)
    ? { type: "plugin.directory.install.request", path: input.source, id: input.id }
    : { type: "plugin.source.install.request", source: input.source, id: input.id, ...(input.ref ? { ref: input.ref } : {}) };
  const responseType = request.type.replace(".request", ".response");
  const wsCall = daemonWsRequestPayload<{ plugin?: unknown }>(home, request, responseType, PLUGIN_IO_TIMEOUT_MS);
  if (wsCall !== null) {
    const reply = await wsCall;
    if (!reply.ok) return { ok: false, reason: reply.reason };
    const plugin = (reply.payload as { plugin?: unknown } | undefined)?.plugin;
    if (!isDaemonPluginItem(plugin)) return { ok: false, reason: `the daemon's ${responseType} carried no plugin` };
    return { ok: true, plugin };
  }
  const argv = ["--home", home, "plugin", "install", input.source, "--id", input.id, ...(input.ref ? ["--ref", input.ref] : []), "--json"];
  const cli = pluginCliJson(home, argv, PLUGIN_IO_TIMEOUT_MS);
  if (!cli.ok) return { ok: false, reason: cli.reason };
  const plugin = pluginsFromCliJson(cli.value)[0];
  if (plugin === undefined) return { ok: false, reason: `paseo plugin install printed no plugin JSON` };
  return { ok: true, plugin };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function extractTargetRevision(target: unknown): string | undefined {
  if (!isRecord(target)) return undefined;
  if (target.kind === "git") return nonEmptyString(target.commit);
  return nonEmptyString(target.version) ?? nonEmptyString(target.commit);
}

function findPluginUpdateEntry(raw: unknown, pluginId: string): Record<string, unknown> | undefined {
  const rows = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.plugins)
      ? raw.plugins
      : [];
  const entries = rows.filter(isRecord);
  const byId = entries.find((entry) => entry.id === pluginId);
  if (byId !== undefined) return byId;
  if (entries.length === 1 && typeof entries[0]!.id !== "string") return entries[0];
  return undefined;
}

function extractUpdateRow(
  entry: Record<string, unknown>,
  pluginId: string,
  options?: { fallbackEntry?: Record<string, unknown>; defaultUpdated?: boolean },
): DaemonPluginUpdateRow | undefined {
  const fallback = options?.fallbackEntry;
  const currentObj = isRecord(entry.current) ? entry.current : isRecord(fallback?.current) ? fallback.current : undefined;
  const proposalObj = isRecord(entry.proposal) ? entry.proposal : isRecord(fallback?.proposal) ? fallback.proposal : undefined;
  const proposalExpected = isRecord(proposalObj?.expected) ? proposalObj.expected : undefined;
  const pluginObj = isRecord(entry.plugin) ? entry.plugin : undefined;
  const installObj = isRecord(pluginObj?.installation) ? pluginObj.installation : undefined;

  if (typeof entry.outcome === "string") {
    if (entry.outcome === "error" || entry.outcome === "local") return undefined;
    if (entry.outcome === "update" && isRecord(entry.proposal) && options?.defaultUpdated !== true) {
      return undefined;
    }
    if (entry.outcome === "current" || entry.outcome === "installed-newer" || (entry.outcome === "update" && !isRecord(entry.proposal))) {
      const currentCommit =
        nonEmptyString(currentObj?.currentRevision) ??
        nonEmptyString(installObj?.currentRevision) ??
        nonEmptyString(pluginObj?.commit) ??
        extractTargetRevision(entry.target) ??
        nonEmptyString(entry.currentCommit);
      return {
        id: pluginId,
        ...(currentCommit !== undefined ? { previousCommit: currentCommit, currentCommit } : {}),
        commits: 0,
        updated: false,
      };
    }
  } else if (typeof entry.updated === "boolean") {
    const previousCommit = nonEmptyString(entry.previousCommit);
    const currentCommit = nonEmptyString(entry.currentCommit);
    return {
      id: pluginId,
      ...(previousCommit !== undefined ? { previousCommit } : {}),
      ...(currentCommit !== undefined ? { currentCommit } : {}),
      ...(typeof entry.commits === "number" ? { commits: entry.commits } : {}),
      updated: entry.updated,
    };
  }

  if (entry.outcome === "updated" || options?.defaultUpdated === true) {
    const previousCommit =
      nonEmptyString(proposalExpected?.revision) ??
      nonEmptyString(currentObj?.currentRevision) ??
      nonEmptyString(entry.previousCommit) ??
      nonEmptyString(fallback?.previousCommit);
    const currentCommit =
      nonEmptyString(installObj?.currentRevision) ??
      nonEmptyString(pluginObj?.commit) ??
      extractTargetRevision(entry.target) ??
      extractTargetRevision(proposalObj?.target) ??
      extractTargetRevision(fallback?.target) ??
      nonEmptyString(entry.currentCommit);
    return {
      id: pluginId,
      ...(previousCommit !== undefined ? { previousCommit } : {}),
      ...(currentCommit !== undefined ? { currentCommit } : {}),
      ...(typeof entry.commits === "number" ? { commits: entry.commits } : {}),
      updated: true,
    };
  }
  return undefined;
}

function extractUpdateOutcome(
  raw: unknown,
  pluginId: string,
  options?: {
    fallbackEntry?: Record<string, unknown>;
    missingReason?: string;
    errorPrefix?: string;
    defaultUpdated?: boolean;
  },
): { ok: true; entry?: Record<string, unknown>; plugin?: DaemonPluginItem; update?: DaemonPluginUpdateRow } | { ok: false; reason: string } {
  const entry = findPluginUpdateEntry(raw, pluginId);
  if (entry === undefined) {
    if (options?.missingReason !== undefined) return { ok: false, reason: options.missingReason };
    return { ok: true };
  }
  if (entry.outcome === "error") {
    return { ok: false, reason: nonEmptyString(entry.error) ?? `${options?.errorPrefix ?? "update failed"} for ${pluginId}` };
  }
  if (entry.outcome === "local") {
    return { ok: false, reason: `${pluginId} is installed from a local directory — use Reload after editing` };
  }
  const row = extractUpdateRow(entry, pluginId, options);
  const plugin = isDaemonPluginItem(entry.plugin) ? enrichDaemonPluginItem(entry.plugin) : undefined;
  return {
    ok: true,
    entry,
    ...(plugin !== undefined ? { plugin } : {}),
    ...(row !== undefined ? { update: row } : {}),
  };
}

function toManageReply(
  outcome: { ok: true; entry?: Record<string, unknown>; plugin?: DaemonPluginItem; update?: DaemonPluginUpdateRow } | { ok: false; reason: string },
): { ok: true; plugin?: DaemonPluginItem; update?: DaemonPluginUpdateRow } | { ok: false; reason: string } {
  if (!outcome.ok) return outcome;
  const { entry: _entry, ...rest } = outcome;
  return rest;
}

function isUnknownUpdatePreviewRequestError(reason: string): boolean {
  return /(?:unknown|unsupported|unhandled|unrecognized).*(?:message|request|type)|invalid.*type.*plugin\.source\.update\.preview\.request/i.test(
    reason,
  );
}

/**
 * Manages an installed plugin: enable/disable/reload speak `plugin.<action>.request`,
 * remove speaks `plugin.remove.request` (its response carries no plugin — the frame
 * arriving is the success), update speaks the two-phase reviewed protocol
 * (`plugin.source.update.preview.request` → `plugin.source.update.apply.request`)
 * on the 300s plugin-IO timeout and answers with the payload row matching the pluginId.
 */
export async function manageDaemonPlugin(
  home: string,
  pluginId: string,
  action: DaemonPluginAction,
): Promise<{ ok: true; plugin?: DaemonPluginItem; update?: DaemonPluginUpdateRow } | { ok: false; reason: string }> {
  invalidatePluginListCache(home);
  const timeoutMs = action === "update" ? PLUGIN_IO_TIMEOUT_MS : BRIDGE_TIMEOUT_MS;
  if (action === "update") {
    const previewCall = daemonWsRequestPayload<Record<string, unknown>>(
      home,
      { type: "plugin.source.update.preview.request", pluginId },
      "plugin.source.update.preview.response",
      timeoutMs,
    );
    if (previewCall !== null) {
      const previewReply = await previewCall;
      if (!previewReply.ok) {
        if (isUnknownUpdatePreviewRequestError(previewReply.reason)) {
          const legacyCall = daemonWsRequestPayload<Record<string, unknown>>(
            home,
            { type: "plugin.source.update.request", pluginId },
            "plugin.source.update.response",
            timeoutMs,
          );
          if (legacyCall === null) return { ok: false, reason: previewReply.reason };
          const legacyReply = await legacyCall;
          if (!legacyReply.ok) return { ok: false, reason: legacyReply.reason };
          return toManageReply(extractUpdateOutcome(legacyReply.payload, pluginId));
        }
        return { ok: false, reason: previewReply.reason };
      }
      const previewOutcome = extractUpdateOutcome(previewReply.payload, pluginId, {
        missingReason: `the daemon's plugin.source.update.preview.response carried no entry for ${pluginId}`,
        errorPrefix: "update preview failed",
      });
      if (!previewOutcome.ok) return previewOutcome;
      const item = previewOutcome.entry;
      if (item?.outcome === "update" && isRecord(item.proposal)) {
        const applyCall = daemonWsRequestPayload<Record<string, unknown>>(
          home,
          { type: "plugin.source.update.apply.request", proposals: [item.proposal] },
          "plugin.source.update.apply.response",
          timeoutMs,
        );
        if (applyCall === null) {
          return { ok: false, reason: "daemon socket unavailable for plugin.source.update.apply.request" };
        }
        const applyReply = await applyCall;
        if (!applyReply.ok) return { ok: false, reason: applyReply.reason };
        return toManageReply(
          extractUpdateOutcome(applyReply.payload, pluginId, {
            fallbackEntry: item,
            missingReason: `the daemon's plugin.source.update.apply.response carried no entry for ${pluginId}`,
            errorPrefix: "update apply failed",
            defaultUpdated: true,
          }),
        );
      }
      return toManageReply(previewOutcome);
    }
  } else {
    const requestType = `plugin.${action}.request`;
    const responseType = requestType.replace(".request", ".response");
    const wsCall = daemonWsRequestPayload<Record<string, unknown>>(home, { type: requestType, pluginId }, responseType, timeoutMs);
    if (wsCall !== null) {
      const reply = await wsCall;
      if (!reply.ok) return { ok: false, reason: reply.reason };
      if (action === "remove") return { ok: true };
      const plugin = (reply.payload as { plugin?: unknown }).plugin;
      if (!isDaemonPluginItem(plugin)) return { ok: false, reason: `the daemon's ${responseType} carried no plugin` };
      return { ok: true, plugin };
    }
  }
  // `--yes` on update: the bridge is non-interactive, and the flag is the CLI's own skip-confirmation switch.
  const argv = ["--home", home, "plugin", action, pluginId, ...(action === "update" ? ["--yes"] : []), "--json"];
  const cli = pluginCliJson(home, argv, timeoutMs);
  if (!cli.ok) return { ok: false, reason: cli.reason };
  if (action === "update") {
    return toManageReply(extractUpdateOutcome(cli.value, pluginId));
  }
  return { ok: true };
}

function parseSourceStatusRows(raw: unknown): DaemonPluginSourceStatus[] | null {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { plugins?: unknown }).plugins)
      ? (raw as { plugins: unknown[] }).plugins
      : null;
  if (list === null) return null;
  const rows: DaemonPluginSourceStatus[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as {
      id?: unknown;
      source?: unknown;
      outcome?: unknown;
      currentCommit?: unknown;
      latestCommit?: unknown;
      commitsBehind?: unknown;
      updateAvailable?: unknown;
      target?: { commit?: unknown; version?: unknown } | null;
    };
    if (typeof entry.id !== "string" || entry.id === "") continue;
    const isDirectoryOnly = entry.source === "directory" && entry.latestCommit === undefined && entry.target === undefined;
    const currentRevision = typeof entry.currentCommit === "string" && entry.currentCommit !== "" ? entry.currentCommit : null;
    const latestRevision =
      typeof entry.latestCommit === "string" && entry.latestCommit !== ""
        ? entry.latestCommit
        : typeof entry.target?.commit === "string" && entry.target.commit !== ""
          ? entry.target.commit
          : typeof entry.target?.version === "string" && entry.target.version !== ""
            ? entry.target.version
            : null;
    const commitsBehind = typeof entry.commitsBehind === "number" ? entry.commitsBehind : null;
    const updateAvailable = isDirectoryOnly
      ? null
      : typeof entry.updateAvailable === "boolean"
        ? entry.updateAvailable
        : entry.outcome === "update"
          ? true
          : entry.outcome === "current" || entry.outcome === "installed-newer"
            ? false
            : null;
    rows.push({
      id: entry.id,
      currentRevision,
      latestRevision,
      commitsBehind,
      updateAvailable,
    });
  }
  return rows;
}

/**
 * The per-plugin fallback for a failed batch status request (v0.0.30, spec
 * Implementation Decision 4): `@getpaseo/server`'s `statusSources` loops the
 * batch `plugin.source.status.request` without per-plugin isolation, so one
 * inaccessible private repo (an expired token on `factory-release-lab`)
 * aborts the whole `Check for updates` call. Re-asking each installed plugin
 * individually keeps every healthy plugin's row: per-plugin failures are
 * dropped, and the check only fails when the plugin list itself is
 * unreachable or no installed plugin could be queried at all.
 */
async function checkDaemonPluginUpdatesPerPlugin(
  home: string,
  batchReason: string,
): Promise<{ ok: true; statuses: DaemonPluginSourceStatus[]; checkedAt: string } | { ok: false; reason: string }> {
  const list = await listDaemonPlugins(home);
  if (!list.ok) {
    return {
      ok: false,
      reason: `the batch plugin update check failed (${batchReason}) and listing installed plugins failed too (${list.reason})`,
    };
  }
  const rows: DaemonPluginSourceStatus[] = [];
  for (const item of list.plugins) {
    const wsCall = daemonWsRequestPayload<{ plugins?: unknown }>(
      home,
      { type: "plugin.source.status.request", pluginId: item.id },
      "plugin.source.status.response",
      PLUGIN_IO_TIMEOUT_MS,
    );
    if (wsCall === null) continue;
    const reply = await wsCall;
    if (!reply.ok) continue; // one inaccessible repo never hides the others
    const parsed = parseSourceStatusRows(reply.payload);
    if (parsed !== null) rows.push(...parsed);
  }
  if (rows.length === 0 && list.plugins.length > 0) {
    return {
      ok: false,
      reason: `the batch plugin update check failed (${batchReason}) and every per-plugin status query failed too`,
    };
  }
  return { ok: true, statuses: rows, checkedAt: new Date().toISOString() };
}

/**
 * Checks remote update availability for all installed plugins on `home` via
 * `plugin.source.status.request` over the daemon WebSocket (falling back to
 * `paseo --home <home> plugin update --all --check --json`), caching the
 * result per `home` for subsequent snapshot reads (v0.0.25, ADR 0012 §4).
 * When the batch request errors, it retries plugin-by-plugin so a single
 * inaccessible repository cannot hide updates for the rest (v0.0.30, spec
 * Implementation Decision 4).
 */
export async function checkDaemonPluginUpdates(
  home: string,
): Promise<{ ok: true; statuses: DaemonPluginSourceStatus[]; checkedAt: string } | { ok: false; reason: string }> {
  const wsCall = daemonWsRequestPayload<{ plugins?: unknown }>(
    home,
    { type: "plugin.source.status.request" },
    "plugin.source.status.response",
    PLUGIN_IO_TIMEOUT_MS,
  );
  let rows: DaemonPluginSourceStatus[] | null = null;
  if (wsCall !== null) {
    const reply = await wsCall;
    if (!reply.ok) {
      // Per-plugin fault isolation: the daemon's batch status loop threw on
      // one installed plugin — re-ask each plugin individually and keep
      // whichever rows answer (v0.0.30, spec Implementation Decision 4).
      const perPlugin = await checkDaemonPluginUpdatesPerPlugin(home, reply.reason);
      if (!perPlugin.ok) return { ok: false, reason: perPlugin.reason };
      rows = perPlugin.statuses;
    } else {
      rows = parseSourceStatusRows(reply.payload);
      if (rows === null) return { ok: false, reason: "the daemon's plugin.source.status.response carried no plugins array" };
    }
  } else {
    const cli = pluginCliJson(home, ["--home", home, "plugin", "update", "--all", "--check", "--json"], PLUGIN_IO_TIMEOUT_MS);
    if (!cli.ok) return { ok: false, reason: cli.reason };
    rows = parseSourceStatusRows(cli.value) ?? [];
  }
  const checkedAt = new Date().toISOString();
  const map = new Map<string, DaemonPluginSourceStatus>();
  for (const row of rows) map.set(row.id, row);
  pluginUpdateCache.set(home, { statuses: map, checkedAt });
  return { ok: true, statuses: rows, checkedAt };
}

// ---- the config reload + worktree cleanup bridge (v0.0.27, ADR 0017 §1/§4) ------------------
//
// The role-provider reconcile rewrites `<home>/config.json` behind the
// daemon's back, and removed Task worktree directories strand workspace and
// project records in Paseo Desktop. Both ride the same session WebSocket the
// plugin lifecycle speaks: `daemon.config.reload.request` makes the daemon
// re-read its config, and `archive_workspace_request` +
// `project.remove.request` are the daemon's delete acts for a workspace and
// a project (there is no literal `workspace.delete.request` in the protocol
// — archiving the workspace record is the daemon's own deletion path, the
// one `handleProjectRemoveRequest` itself walks per workspace).

/**
 * Asks the daemon to reload its config (`daemon.config.reload.request`) after
 * `<home>/config.json` changed — fire-and-forget by design: the reconcile
 * never blocks on the daemon, and a daemon that cannot answer (down, busy,
 * no socket yet) simply picks the config up on its next restart.
 */
export function reloadDaemonConfigViaWs(home: string): void {
  const call = daemonWsRequestPayload(home, { type: "daemon.config.reload.request" }, "daemon.config.reload.response");
  if (call === null) return;
  void call.catch(() => {}); // a failed reload is never the caller's failure
}

/**
 * Fires a lightweight loopback `factory.snapshot` RPC over the daemon WebSocket
 * right after plugin boot/reload so `registerSurfaceRpc` immediately captures
 * `context.paseo` before any Spool request arrives.
 */
export function warmPluginDaemonApiViaWs(home: string): void {
  const call = daemonWsRequestPayload(
    home,
    { type: "plugin.rpc.invoke.request", pluginId: "paseo-factory", method: "factory.snapshot", input: {} },
    "plugin.rpc.invoke.response",
    5_000,
  );
  if (call === null) return;
  void call.catch(() => {});
}

/** True for a plain object — the narrowing helper the cleanup slices use. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One workspace row from `fetch_workspaces_response` — the structural slice the cleanup reads. */
export interface DaemonWorkspaceEntry {
  id: string;
  projectId?: string | null;
  projectRootPath?: string | null;
  workspaceDirectory?: string | null;
  archivingAt?: string | null;
}

/** One project row from `project.list.response` — the structural slice the cleanup reads. */
export interface DaemonProjectEntry {
  projectId: string;
  projectRootPath?: string | null;
}

function daemonWorkspaceEntries(raw: unknown): DaemonWorkspaceEntry[] | null {
  const entries = isRecord(raw) && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : null;
  if (entries === null) return null;
  const out: DaemonWorkspaceEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") continue;
    out.push({
      id: entry.id,
      ...(typeof entry.projectId === "string" ? { projectId: entry.projectId } : {}),
      ...(typeof entry.projectRootPath === "string" ? { projectRootPath: entry.projectRootPath } : {}),
      ...(typeof entry.workspaceDirectory === "string" ? { workspaceDirectory: entry.workspaceDirectory } : {}),
      ...(typeof entry.archivingAt === "string" ? { archivingAt: entry.archivingAt } : {}),
    });
  }
  return out;
}

function daemonProjectEntries(raw: unknown): DaemonProjectEntry[] | null {
  const projects = isRecord(raw) && Array.isArray((raw as { projects?: unknown }).projects) ? (raw as { projects: unknown[] }).projects : null;
  if (projects === null) return null;
  const out: DaemonProjectEntry[] = [];
  for (const entry of projects) {
    if (!isRecord(entry) || typeof entry.projectId !== "string" || entry.projectId === "") continue;
    out.push({ projectId: entry.projectId, ...(typeof entry.projectRootPath === "string" ? { projectRootPath: entry.projectRootPath } : {}) });
  }
  return out;
}

/** True when a recorded root sits under the factory worktrees dir or no longer exists on disk. */
function underWorktreesOrMissing(path: string | null | undefined, worktreesDir: string): boolean {
  if (typeof path !== "string" || path === "") return false;
  return path === worktreesDir || path.startsWith(`${worktreesDir}/`) || !existsSync(path);
}

/**
 * A recorded root's comparison form (v0.0.31, ADR 0017 §5): the physical path
 * when the directory exists (a symlinked `/tmp` never splits two spellings of
 * one worktree), the recorded string otherwise — a missing root compares raw
 * against missing roots, never against a realpath'd live one.
 */
function normalizedRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `root` is `dir` itself or nested under it — raw or normalized compare. */
function rootInsideDir(root: string, dir: string): boolean {
  if (root === dir || root.startsWith(`${dir}/`)) return true;
  const normalized = normalizedRoot(root);
  const normalizedDir = normalizedRoot(dir);
  return normalized === normalizedDir || normalized.startsWith(`${normalizedDir}/`);
}

/** True when two recorded roots name the same directory — raw or normalized compare. */
function rootsEqual(left: string, right: string): boolean {
  return left === right || normalizedRoot(left) === normalizedRoot(right);
}

/** The workspace/project record sweep's input (v0.0.31, ADR 0017 §4–§5). */
export interface CleanupDaemonWorkspacesInput {
  worktreesDir: string;
  /** Specific task worktree path being retired (optional). */
  targetWorktreePath?: string;
  /** Project root path when sweeping orphaned local_checkout workspaces (optional). */
  projectRoot?: string;
  /** Workspace IDs that must never be archived (e.g., active Supervisor/Lead workspace). */
  keepWorkspaceIds?: readonly string[];
  /** Workspace IDs that currently host at least one non-archived agent. */
  activeWorkspaceIds?: readonly string[];
}

/**
 * Sweeps the daemon's broken worktree leftovers (v0.0.27, ADR 0017 §4) and —
 * since v0.0.31 (ADR 0017 §4–§5) — the Project's orphaned `local_checkout`
 * workspaces, all over the daemon WebSocket (`archive_workspace_request` /
 * `project.remove.request`). Three rules, strictly separated:
 *
 * - **Task worktree workspaces** (root under `worktreesDir`) archive ONLY
 *   when their directory no longer exists on disk or the root IS the
 *   explicitly retired `targetWorktreePath` — sibling worktree workspaces
 *   whose directories still exist (parallel Tasks with live Peers) are NEVER
 *   archived, so accepting one task never kills the rest of a wave.
 * - **Top-level Project rows** whose `projectRootPath` sits under
 *   `worktreesDir` or is missing on disk are always removed (a Task worktree
 *   must never be a standalone Project row), plus any workspace row whose
 *   root is gone from disk (the v0.0.27 broken-record law).
 * - **Orphaned `local_checkout` workspaces**: when `projectRoot` AND
 *   `activeWorkspaceIds` are provided, a workspace rooted at `projectRoot`
 *   archives exactly when its id is in neither `keepWorkspaceIds` (the active
 *   Supervisor/Lead workspace) nor `activeWorkspaceIds` (zero non-archived
 *   agents reside there) — an active user chat is never touched.
 *
 * A daemon with no session socket (`<home>/paseo.pid` absent — tests, a dev
 * shell) has nothing to sweep and answers ok with empty lists; every delete
 * is best-effort — one stuck row never fails the sweep.
 */
export async function cleanupDaemonWorkspacesAndProjectsViaWs(
  home: string | undefined,
  input: CleanupDaemonWorkspacesInput,
): Promise<{ ok: true; removedWorkspaceIds: string[]; removedProjectIds: string[] } | { ok: false; reason: string }> {
  const targetHome = home ?? process.env.PASEO_HOME;
  if (targetHome === undefined) {
    return { ok: false, reason: "no daemon home to sweep — pass home or set PASEO_HOME" };
  }
  const listWorkspaces = daemonWsRequestPayload<unknown>(targetHome, { type: "fetch_workspaces_request" }, "fetch_workspaces_response");
  if (listWorkspaces === null) return { ok: true, removedWorkspaceIds: [], removedProjectIds: [] }; // no daemon socket — nothing to sweep
  const listProjects = daemonWsRequestPayload<unknown>(targetHome, { type: "project.list.request" }, "project.list.response");
  const keepIds = input.keepWorkspaceIds === undefined ? null : new Set(input.keepWorkspaceIds);
  const activeIds = input.activeWorkspaceIds === undefined ? null : new Set(input.activeWorkspaceIds);
  const removedWorkspaceIds: string[] = [];
  const removedProjectIds: string[] = [];
  try {
    const workspacesReply = await listWorkspaces;
    if (!workspacesReply.ok) return { ok: false, reason: workspacesReply.reason };
    const workspaces = daemonWorkspaceEntries(workspacesReply.payload) ?? [];
    for (const workspace of workspaces) {
      if (workspace.archivingAt !== null && workspace.archivingAt !== undefined) continue; // already on its way out
      if (keepIds !== null && keepIds.has(workspace.id)) continue; // never archived — the active Supervisor/Lead workspace
      const root = workspace.workspaceDirectory ?? workspace.projectRootPath ?? null;
      if (typeof root !== "string" || root === "") continue;
      const retiredTarget = input.targetWorktreePath !== undefined && rootsEqual(root, input.targetWorktreePath);
      // Rule 1 (ADR 0017 §4): a Task worktree workspace archives only when its
      // directory is gone or it is the explicitly retired target — siblings on
      // disk stay. Rule 2 (the v0.0.27 broken-record law): any root missing
      // from disk is a dead record. Rule 3 (ADR 0017 §5): an orphaned
      // local_checkout at projectRoot archives exactly when no live agent and
      // no keep-set entry holds it.
      const worktreeRetired = rootInsideDir(root, input.worktreesDir) && (!existsSync(root) || retiredTarget);
      const missingRecord = !existsSync(root);
      const orphanedCheckout =
        input.projectRoot !== undefined && activeIds !== null && rootsEqual(root, input.projectRoot) && !activeIds.has(workspace.id);
      if (!worktreeRetired && !missingRecord && !orphanedCheckout) continue;
      const archive = daemonWsRequest(targetHome, { type: "archive_workspace_request", workspaceId: workspace.id }, "archive_workspace_response");
      if (archive === null) continue;
      const reply = await archive;
      if (reply.ok) removedWorkspaceIds.push(workspace.id);
    }
  } catch {
    // best-effort — the project sweep below still runs
  }
  try {
    if (listProjects !== null) {
      const projectsReply = await listProjects;
      if (projectsReply.ok) {
        const projects = daemonProjectEntries(projectsReply.payload) ?? [];
        for (const project of projects) {
          if (!underWorktreesOrMissing(project.projectRootPath ?? null, input.worktreesDir)) continue;
          const remove = daemonWsRequest(targetHome, { type: "project.remove.request", projectId: project.projectId }, "project.remove.response");
          if (remove === null) continue;
          const reply = await remove;
          if (reply.ok) removedProjectIds.push(project.projectId);
        }
      }
    }
  } catch {
    // best-effort — a stuck project row never fails the reset/archive that called
  }
  return { ok: true, removedWorkspaceIds, removedProjectIds };
}
