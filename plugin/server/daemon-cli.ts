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
    const env = home === undefined ? { ...process.env, NO_COLOR: "1" } : { ...process.env, PASEO_HOME: home, NO_COLOR: "1" };
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

function extractUpdateRow(raw: unknown, pluginId: string): DaemonPluginUpdateRow | undefined {
  const rows = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { plugins?: unknown }).plugins)
      ? (raw as { plugins: unknown[] }).plugins
      : [];
  return rows.find((entry): entry is DaemonPluginUpdateRow => {
    if (typeof entry !== "object" || entry === null) return false;
    const typed = entry as { id?: unknown; updated?: unknown };
    return typed.id === pluginId && typeof typed.updated === "boolean";
  });
}

/**
 * Manages an installed plugin: enable/disable/reload speak `plugin.<action>.request`,
 * remove speaks `plugin.remove.request` (its response carries no plugin — the frame
 * arriving is the success), update speaks `plugin.source.update.request` on the 300s
 * plugin-IO timeout and answers with the payload row matching the pluginId.
 */
export async function manageDaemonPlugin(
  home: string,
  pluginId: string,
  action: DaemonPluginAction,
): Promise<{ ok: true; plugin?: DaemonPluginItem; update?: DaemonPluginUpdateRow } | { ok: false; reason: string }> {
  invalidatePluginListCache(home);
  const requestType = action === "update" ? "plugin.source.update.request" : `plugin.${action}.request`;
  const responseType = requestType.replace(".request", ".response");
  const timeoutMs = action === "update" ? PLUGIN_IO_TIMEOUT_MS : BRIDGE_TIMEOUT_MS;
  const wsCall = daemonWsRequestPayload<Record<string, unknown>>(home, { type: requestType, pluginId }, responseType, timeoutMs);
  if (wsCall !== null) {
    const reply = await wsCall;
    if (!reply.ok) return { ok: false, reason: reply.reason };
    if (action === "update") {
      const row = extractUpdateRow(reply.payload, pluginId);
      return row === undefined ? { ok: true } : { ok: true, update: row };
    }
    if (action === "remove") return { ok: true };
    const plugin = (reply.payload as { plugin?: unknown }).plugin;
    if (!isDaemonPluginItem(plugin)) return { ok: false, reason: `the daemon's ${responseType} carried no plugin` };
    return { ok: true, plugin };
  }
  // `--yes` on update: the bridge is non-interactive, and the flag is the CLI's own skip-confirmation switch.
  const argv = ["--home", home, "plugin", action, pluginId, ...(action === "update" ? ["--yes"] : []), "--json"];
  const cli = pluginCliJson(home, argv, timeoutMs);
  if (!cli.ok) return { ok: false, reason: cli.reason };
  if (action === "update") {
    const row = extractUpdateRow(cli.value, pluginId);
    return row === undefined ? { ok: true } : { ok: true, update: row };
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
 * Checks remote update availability for all installed plugins on `home` via
 * `plugin.source.status.request` over the daemon WebSocket (falling back to
 * `paseo --home <home> plugin update --all --check --json`), caching the
 * result per `home` for subsequent snapshot reads (v0.0.25, ADR 0012 §4).
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
    if (!reply.ok) return { ok: false, reason: reply.reason };
    rows = parseSourceStatusRows(reply.payload);
    if (rows === null) return { ok: false, reason: "the daemon's plugin.source.status.response carried no plugins array" };
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
