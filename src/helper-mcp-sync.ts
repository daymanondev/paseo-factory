/** Peer-only Helper MCP discovery, credential reconciliation and bounded health checks (ADR 0039). */
import { createHash } from "node:crypto";
import { existsSync, accessSync, constants, readdirSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { readHelperJson as read, writeHelperJson as save } from "./helper-mcp-store.ts";

export type HelperMcpTargetProvider = "pi" | "claude" | "codex" | "opencode";
export const ALL_HELPER_TARGET_PROVIDERS: readonly HelperMcpTargetProvider[] = ["pi", "claude", "codex", "opencode"];
export interface HelperMcpConfigUpdate {
  enabled?: boolean;
  targetProviders?: HelperMcpTargetProvider[];
  vaultSync?: boolean;
}
export type HelperMcpTransport = "stdio" | "http";
export type HelperMcpHealthStatus = "connected" | "auth_expired" | "missing_env" | "unreachable" | "disabled";
export interface HelperMcpServerEntry {
  name: string; transport: HelperMcpTransport; command?: string; args?: string[];
  env?: Record<string, string>; url?: string; headers?: Record<string, string>;
  enabled: boolean; targetProviders: HelperMcpTargetProvider[]; vaultSync: boolean; sources: Array<"antigravity" | "pi" | "claude" | "vault" | "factory">;
  status: HelperMcpHealthStatus; statusDetail?: string; oauthExpiresAt?: number; timeout?: number;
  auth?: Record<string, unknown>;
  oauthRequired?: boolean;
}
export interface HelperMcpOptions { stateDir: string; userHome?: string; piAgentDir?: string; piOnly?: boolean }
export interface HelperMcpCatalogSnapshot { servers: HelperMcpServerEntry[] }
export interface HelperOAuthBundle {
  serverUrl: string; clientInfo?: { clientId?: string; clientSecret?: string; redirectUris?: string[] };
  tokenUrl?: string; tokens: { accessToken: string; refreshToken?: string; expiresAt?: number };
}
type ObjectMap = Record<string, any>;
function paths(options: HelperMcpOptions) {
  const userHome = options.userHome ?? homedir();
  return { userHome, pi: options.piAgentDir ?? join(userHome, ".pi/agent"), ag: join(userHome, ".gemini/antigravity/mcp_oauth_tokens.json") };
}
export function helperOAuthPath(agentDir: string, name: string): string {
  return join(agentDir, "mcp-oauth", `sha256-${createHash("sha256").update(name).digest("hex")}`, "tokens.json");
}
function endpoint(url: string): string { try { const u = new URL(url); return u.origin + u.pathname.replace(/\/$/, ""); } catch { return url; } }
function canonical(name: string, entry: ObjectMap): string {
  const invocation = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(" ");
  if (/\bchrome-devtools-mcp(?:@|\b)/.test(invocation)) return "chrome-devtools-mcp";
  if (invocation.includes("@z_ai/mcp-server")) return "zai-vision";
  return name;
}
function strings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
}
function expand(value: string): string { return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z_0-9]*)\}/g, (_, key) => process.env[key] ?? ""); }
function credentialScore(entry: HelperMcpServerEntry, options: HelperMcpOptions): number {
  return Object.entries(entry.env ?? {}).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|OPENAPI_MCP_HEADERS/.test(k) && expand(v).trim()).length + Object.values(entry.headers ?? {}).filter(v => expand(v).trim()).length + (entry.url?.includes("ApiKey=") ? 1 : 0) + (valid(readHelperOAuth(options, [entry])[entry.name]) ? 10 : 0);
}
export function discoverHelperMcps(options: HelperMcpOptions): HelperMcpCatalogSnapshot {
  const p = paths(options), persisted = read(join(options.stateDir, "helper-mcps.json"));
  const sources: Array<[HelperMcpServerEntry["sources"][number], ObjectMap]> = [];
  if (!options.piOnly) {
    const primary = join(p.userHome, ".gemini/config/mcp_config.json");
    sources.push(["antigravity", read(existsSync(primary) ? primary : join(p.userHome, ".gemini/antigravity/mcp_config.json")).mcpServers ?? {}]);
  }
  sources.push(["pi", read(join(p.pi, "mcp.json")).mcpServers ?? {}]);
  if (!options.piOnly) sources.push(["claude", read(join(p.userHome, ".claude.json")).mcpServers ?? {}]);
  const stored = Array.isArray(persisted.servers) ? Object.fromEntries(persisted.servers.map((s: ObjectMap) => [s.name, s])) : persisted.mcpServers ?? {};
  sources.push(["factory", stored]);
  const merged = new Map<string, HelperMcpServerEntry>(), disabled = new Set<string>();
  for (const [source, servers] of sources) for (const [alias, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || alias === "paseo_factory" || alias === "paseo-factory") continue;
    const value = raw as ObjectMap;
    let name = canonical(alias, value);
    const url = typeof (value.url ?? value.serverUrl) === "string" ? (value.url ?? value.serverUrl) as string : undefined;
    if (!url && typeof value.command !== "string") continue;
    if (url) name = [...merged.values()].find(s => s.url && endpoint(s.url) === endpoint(url))?.name ?? name;
    const entry: HelperMcpServerEntry = { targetProviders: [...ALL_HELPER_TARGET_PROVIDERS], vaultSync: false, name, transport: url ? "http" : "stdio", enabled: value.enabled !== false && value.disabled !== true,
      sources: source === "factory" && Array.isArray(value.sources) ? value.sources.filter((s: string) => ["antigravity", "pi", "claude", "vault", "factory"].includes(s)) : [source], status: "unreachable",
      ...(url ? { url } : { command: normalizeCommand(value.command as string, p.userHome), args: Array.isArray(value.args) ? value.args.filter((s: unknown) => typeof s === "string") : [] }),
      ...(strings(value.env) ? { env: strings(value.env) } : {}), ...(strings(value.headers) ? { headers: strings(value.headers) } : {}),
      ...((value.auth === "oauth" || value.oauthRequired === true) ? { oauthRequired: true } : {}),
      ...(typeof value.auth === "object" && value.auth !== null ? { auth: value.auth } : {}),
      ...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}), ...(name === "zai-vision" ? { timeout: 300 } : {}) };
    const previous = merged.get(name);
    const cachedDiscovery = source === "factory" && Array.isArray(value.sources) && !value.sources.some((s: string) => s === "factory" || s === "vault");
    if (previous && cachedDiscovery) { previous.sources = [...new Set([...previous.sources, ...entry.sources])]; continue; }
    if (!entry.enabled && source !== "factory") disabled.add(name);
    merged.set(name, previous ? { ...(credentialScore(entry, options) > credentialScore(previous, options) ? entry : previous), sources: [...new Set([...previous.sources, ...entry.sources])] } : entry);
  }
  // Existing Factory provider-key conveniences remain available across harnesses.
  const zaiKey = read(join(p.pi, "auth.json")).zai?.key;
  if (typeof zaiKey === "string" && zaiKey.trim()) {
    const prev = merged.get("zai-vision");
    merged.set("zai-vision", { targetProviders: [...ALL_HELPER_TARGET_PROVIDERS], vaultSync: false, name: "zai-vision", transport: "stdio", command: "npx", args: ["-y", "@z_ai/mcp-server"], enabled: true, status: "unreachable", ...prev, env: { ...prev?.env, Z_AI_API_KEY: zaiKey.trim(), Z_AI_MODE: prev?.env?.Z_AI_MODE ?? "ZAI" }, sources: [...new Set([...(prev?.sources ?? []), "pi" as const])], timeout: 300 });
  }
  if (!merged.has("exa")) {
    const key = read(join(p.pi, "web-search.json")).exaApiKey ?? read(join(dirname(p.pi), "web-search.json")).exaApiKey;
    if (typeof key === "string" && key.trim()) merged.set("exa", { targetProviders: [...ALL_HELPER_TARGET_PROVIDERS], vaultSync: false, name: "exa", transport: "http", url: `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key.trim())}`, enabled: true, sources: ["pi"], status: "unreachable" });
  }
  const servers = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of servers) {
    entry.enabled = typeof persisted.overrides?.[entry.name] === "boolean" ? persisted.overrides[entry.name]
      : !disabled.has(entry.name) && entry.sources.some(source => source === "pi" || source === "vault");
    const targets = persisted.targets?.[entry.name];
    entry.targetProviders = Array.isArray(targets) && targets.every(p => ALL_HELPER_TARGET_PROVIDERS.includes(p))
      ? [...new Set<HelperMcpTargetProvider>(targets)] : [...ALL_HELPER_TARGET_PROVIDERS];
    entry.vaultSync = typeof persisted.vaultSync?.[entry.name] === "boolean" ? persisted.vaultSync[entry.name] : entry.sources.includes("vault");
  }
  const bundles = readHelperOAuth(options, servers);
  return { servers: servers.map(entry => {
    const checked = classify(entry, bundles[entry.name], p.userHome), cached = persisted.health?.[entry.name];
    return checked.status === "connected" && cached && cached.fingerprint === fingerprint(entry, bundles[entry.name]) && Date.now() - cached.at < 300_000
      ? { ...checked, status: cached.status, statusDetail: cached.statusDetail } : checked;
  }) };
}
export function readHelperOAuth(options: HelperMcpOptions, servers: HelperMcpServerEntry[]): Record<string, HelperOAuthBundle> {
  const p = paths(options), ag = options.piOnly ? {} : read(p.ag), saved = read(join(options.stateDir, "helper-mcp-oauth.json"));
  const otherPiTokens = [p.pi, join(options.stateDir, "pi-agent/agent")].flatMap(agentDir => {
    try { return readdirSync(join(agentDir, "mcp-oauth")).filter(n => /^sha256-[a-f0-9]+$/.test(n)).map(n => read(join(agentDir, "mcp-oauth", n, "tokens.json"))); } catch { return []; }
  });
  const result: Record<string, HelperOAuthBundle> = {};
  for (const server of servers.filter(s => s.transport === "http")) {
    const candidates: HelperOAuthBundle[] = [];
    for (const [url, raw] of Object.entries(ag) as Array<[string, ObjectMap]>) if (endpoint(url) === endpoint(server.url!)) {
      if (!raw || typeof raw !== "object") continue;
      const token = raw.token ?? {};
      candidates.push({ serverUrl: server.url!, clientInfo: { ...(typeof raw.client_id === "string" ? { clientId: raw.client_id } : {}), ...(typeof raw.client_secret === "string" ? { clientSecret: raw.client_secret } : {}) }, tokenUrl: raw.token_url,
        tokens: { accessToken: typeof token.access_token === "string" ? token.access_token : "", refreshToken: token.refresh_token, ...(token.expiry ? { expiresAt: Date.parse(token.expiry) / 1000 } : {}) } });
    }
    for (const raw of [...otherPiTokens, saved[server.name], ...Object.values(saved).filter((v: any) => v?.serverUrl && endpoint(v.serverUrl) === endpoint(server.url!)), read(helperOAuthPath(p.pi, server.name)), read(helperOAuthPath(join(options.stateDir, "pi-agent/agent"), server.name))]) {
      if (raw?.tokens && raw.serverUrl && endpoint(raw.serverUrl) === endpoint(server.url!)) candidates.push({ ...raw, tokens: { ...raw.tokens, accessToken: typeof raw.tokens.accessToken === "string" ? raw.tokens.accessToken : "" } } as HelperOAuthBundle);
    }
    candidates.sort((a, b) => {
      const access = Number(!!b.tokens.accessToken) - Number(!!a.tokens.accessToken);
      if (access) return access;
      const expiry = (bundle: HelperOAuthBundle) => bundle.tokens.expiresAt === undefined && bundle.tokens.accessToken ? Infinity : Number.isFinite(bundle.tokens.expiresAt) ? bundle.tokens.expiresAt! : 0;
      return expiry(b) - expiry(a);
    });
    if (candidates.length) {
      const winner = candidates[0];
      // Refresh credentials belong to one client registration, even when harnesses omit metadata.
      const client = candidates.find(c => c.clientInfo?.clientId && (!winner.clientInfo?.clientId || c.clientInfo.clientId === winner.clientInfo.clientId));
      const clientInfo = { ...client?.clientInfo, ...winner.clientInfo };
      const compatible = candidates.filter(c => !clientInfo.clientId || c.clientInfo?.clientId === clientInfo.clientId);
      result[server.name] = { ...winner, serverUrl: server.url!, tokenUrl: winner.tokenUrl ?? compatible.find(c => c.tokenUrl)?.tokenUrl,
        clientInfo, tokens: { ...winner.tokens, refreshToken: winner.tokens.refreshToken ?? compatible.find(c => c.tokens.refreshToken)?.tokens.refreshToken } };
    }
  }
  return result;
}
function valid(bundle?: HelperOAuthBundle): boolean { return !!bundle?.tokens.accessToken && (bundle.tokens.expiresAt === undefined || (Number.isFinite(bundle.tokens.expiresAt) && bundle.tokens.expiresAt > Date.now() / 1000)); }
function candidateBinDirs(userHome = homedir()): string[] {
  const nvmRoot = join(userHome, ".nvm/versions/node");
  let nvmDirs: string[] = [];
  try { nvmDirs = readdirSync(nvmRoot).sort().reverse().map(v => join(nvmRoot, v, "bin")); } catch { nvmDirs = []; }
  return [...new Set([...(process.env.PATH ?? "").split(delimiter).filter(Boolean), dirname(process.execPath), ...nvmDirs, "/opt/homebrew/bin", "/usr/local/bin", join(userHome, ".local/bin")])];
}
function normalizeCommand(command: string, userHome = homedir()): string {
  if (!command || (!isAbsolute(command) && !command.includes("/"))) return command;
  try { accessSync(command, constants.X_OK); return command; } catch {
    const base = basename(command);
    if (["npx", "node", "npm", "uvx", "uv", "bunx", "bun"].includes(base) && commandExists(base, userHome)) return base;
    return command;
  }
}
function commandExists(command?: string, userHome = homedir()): boolean {
  if (!command) return false;
  return (isAbsolute(command) || command.includes("/") ? [command] : candidateBinDirs(userHome).map(p => join(p, command))).some(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
}
function classify(entry: HelperMcpServerEntry, bundle?: HelperOAuthBundle, userHome = homedir()): HelperMcpServerEntry {
  let status: HelperMcpHealthStatus = "connected", statusDetail: string | undefined;
  if (!entry.enabled) status = "disabled";
  else if (entry.transport === "stdio") {
    const required = new Set(Object.keys(entry.env ?? {}).filter(k => /KEY|TOKEN|SECRET|PASSWORD|OPENAPI_MCP_HEADERS/.test(k)));
    if (entry.name === "exa") required.add("EXA_API_KEY");
    if (entry.name === "zai-vision") required.add("Z_AI_API_KEY");
    const missing = [...required].filter(k => !expand(entry.env?.[k] ?? "").trim());
    const figma = entry.args?.findIndex(a => a === "--figma-api-key" || a.startsWith("--figma-api-key="));
    if (figma !== undefined && figma >= 0) {
      const key = expand(entry.args?.[figma].split("=").slice(1).join("=") || entry.args?.[figma + 1] || "").trim();
      if (!key || key.startsWith("--")) missing.push("--figma-api-key");
    }
    if (missing.length) { status = "missing_env"; statusDetail = `Missing credentials: ${missing.join(", ")}`; }
    else if (!commandExists(entry.command, userHome)) { status = "unreachable"; statusDetail = "Command unavailable on this host"; }
    else statusDetail = "Command and credentials present; server starts on first use";
  } else if ((bundle && !valid(bundle)) || ((entry.oauthRequired || /mcp\.supabase\.com/.test(entry.url ?? "") || entry.auth) && !valid(bundle) && !Object.entries(entry.headers ?? {}).some(([key, value]) => key.toLowerCase() === "authorization" && expand(value).trim()))) status = "auth_expired";
  else statusDetail = "Credentials checked; use Check Connectivity to verify connectivity";
  return { ...entry, status, statusDetail, ...(bundle?.tokens.expiresAt ? { oauthExpiresAt: bundle.tokens.expiresAt } : {}) };
}
/** Break legacy whole-store links before any managed token can be written. */
export function isolateHelperOAuthDirectory(options: HelperMcpOptions, managedNames: string[] = []): void {
  const target = join(options.stateDir, "pi-agent/agent/mcp-oauth");
  const unlink = (path: string) => {
    try { if (lstatSync(path).isSymbolicLink()) rmSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  unlink(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const managed = new Set([...Object.keys(read(join(options.stateDir, "helper-mcp-oauth.json"), true)), ...managedNames]
    .map(name => basename(dirname(helperOAuthPath("", name)))));
  for (const name of managed) unlink(join(target, name));
  const source = join(paths(options).pi, "mcp-oauth");
  let entries: string[] = [];
  try { entries = readdirSync(source); } catch { /* Host sources are optional and read-only. */ }
  for (const name of entries.filter(name => /^sha256-[a-f0-9]+$/.test(name) && !managed.has(name))) {
    const destination = join(target, name);
    try { lstatSync(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      symlinkSync(join(source, name), destination);
    }
  }
}
export function materializeHelperOAuth(options: HelperMcpOptions, bundles: Record<string, HelperOAuthBundle>): void {
  const stored = read(join(options.stateDir, "helper-mcp-oauth.json"), true);
  isolateHelperOAuthDirectory(options, Object.keys(bundles));
  save(join(options.stateDir, "helper-mcp-oauth.json"), { ...stored, ...bundles });
  for (const [name, bundle] of Object.entries(bundles)) {
    save(helperOAuthPath(join(options.stateDir, "pi-agent/agent"), name), bundle);
  }
}
async function refresh(bundle: HelperOAuthBundle): Promise<HelperOAuthBundle> {
  if (!bundle.tokens.refreshToken || (bundle.tokens.accessToken && (bundle.tokens.expiresAt ?? Infinity) > Date.now() / 1000 + 300)) return bundle;
  try {
    let tokenUrl = bundle.tokenUrl;
    if (!tokenUrl) {
      const metadata = new URL("/.well-known/oauth-authorization-server", bundle.serverUrl);
      const res = await fetch(metadata, { signal: AbortSignal.timeout(5000) });
      if (res.ok) tokenUrl = (await res.json() as ObjectMap).token_endpoint;
    }
    if (!tokenUrl) return bundle;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.tokens.refreshToken });
    if (bundle.clientInfo?.clientId) body.set("client_id", bundle.clientInfo.clientId);
    if (bundle.clientInfo?.clientSecret) body.set("client_secret", bundle.clientInfo.clientSecret);
    const response = await fetch(tokenUrl, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return bundle;
    const token = await response.json() as ObjectMap;
    if (typeof token.access_token !== "string" || !token.access_token) return bundle;
    return { ...bundle, tokenUrl, tokens: { accessToken: token.access_token, refreshToken: token.refresh_token ?? bundle.tokens.refreshToken,
      ...(typeof token.expires_in === "number" ? { expiresAt: Math.floor(Date.now() / 1000) + token.expires_in } : {}) } };
  } catch { return bundle; }
}
function helperHeaders(server: HelperMcpServerEntry, bundle?: HelperOAuthBundle): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => !valid(bundle) || key.toLowerCase() !== "authorization").map(([key, value]) => [key, expand(value)]));
  if (valid(bundle)) headers.Authorization = `Bearer ${bundle!.tokens.accessToken}`;
  return headers;
}
export async function probeHelperMcps(servers: HelperMcpServerEntry[], bundles: Record<string, HelperOAuthBundle> = {}): Promise<HelperMcpServerEntry[]> {
  return Promise.all(servers.map(async server => {
    const entry = classify(server, bundles[server.name]);
    if (entry.transport !== "http" || ["disabled", "auth_expired", "missing_env"].includes(entry.status)) return entry;
    try {
      const response = await fetch(expand(entry.url!), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...helperHeaders(entry, bundles[entry.name]) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "paseo-factory", version: "1" } } }), signal: AbortSignal.timeout(6000) });
      void response.body?.cancel().catch(() => {});
      return { ...entry, status: response.status === 401 || response.status === 403 ? "auth_expired" as const : response.ok ? "connected" as const : "unreachable" as const, statusDetail: `HTTP ${response.status}` };
    } catch { return { ...entry, status: "unreachable" as const, statusDetail: "Endpoint did not respond within 6 seconds" }; }
  }));
}
async function syncUnlocked(options: HelperMcpOptions & { probe?: boolean }): Promise<HelperMcpCatalogSnapshot> {
  // Validate writable aggregates before a refresh can rotate a token remotely.
  read(join(options.stateDir, "helper-mcp-oauth.json"), true);
  read(join(options.stateDir, "helper-mcps.json"), true);
  const catalog = discoverHelperMcps(options), bundles = readHelperOAuth(options, catalog.servers.filter(s => s.enabled));
  await Promise.all(Object.entries(bundles).map(async ([name, bundle]) => { bundles[name] = await refresh(bundle); }));
  materializeHelperOAuth(options, bundles);
  const servers = options.probe ? await probeHelperMcps(catalog.servers, bundles) : discoverHelperMcps(options).servers;
  const stored = read(join(options.stateDir, "helper-mcps.json"), true);
  save(join(options.stateDir, "helper-mcps.json"), { ...stored, servers, ...(options.probe ? { health: Object.fromEntries(servers.map(s => [s.name, { fingerprint: fingerprint(s, bundles[s.name]), at: Date.now(), status: s.status, statusDetail: s.statusDetail }])) } : {}) });
  provisionHelperMcpConfig(options);
  return { servers };
}
export function setHelperMcpEnabled(options: HelperMcpOptions, name: string, update: boolean | HelperMcpConfigUpdate): HelperMcpCatalogSnapshot {
  const previous = discoverHelperMcps(options).servers.find(s => s.name === name);
  if (!previous) throw new Error("Unknown Helper MCP server");
  const config = typeof update === "boolean" ? { enabled: update } : update;
  if (config.targetProviders && !config.targetProviders.every(p => ALL_HELPER_TARGET_PROVIDERS.includes(p))) throw new Error("Unknown Helper MCP target provider");
  const path = join(options.stateDir, "helper-mcps.json"), stored = read(path, true);
  read(join(options.stateDir, "helper-mcp-oauth.json"), true);
  save(path, { ...stored,
    ...(config.enabled !== undefined ? { overrides: { ...stored.overrides, [name]: config.enabled } } : {}),
    ...(config.targetProviders !== undefined ? { targets: { ...stored.targets, [name]: [...new Set(config.targetProviders)] } } : {}),
    ...(config.vaultSync !== undefined ? { vaultSync: { ...stored.vaultSync, [name]: config.vaultSync } } : {}),
  });
  const catalog = discoverHelperMcps(options);
  if (!previous.enabled && config.enabled === true) materializeHelperOAuth(options, readHelperOAuth(options, catalog.servers.filter(s => s.name === name)));
  provisionHelperMcpConfig(options);
  return catalog;
}
/** Keep the existing bridge while replacing the managed helper set. */
function provisionHelperMcpConfig(options: HelperMcpOptions): void {
  const path = join(options.stateDir, "pi-agent/agent/mcp.json"), config = read(path, true);
  const mcpServers = resolveRoleScopedMcpServers({ ...options, role: "agent", pi: true });
  if (config.mcpServers?.paseo_factory) mcpServers.paseo_factory = config.mcpServers.paseo_factory;
  save(path, { ...config, mcpServers });
}
export function resolveRoleScopedMcpServers(options: HelperMcpOptions & { role: string; pi?: boolean; provider?: string }): Record<string, unknown> {
  if (options.role !== "agent") return {};
  const { servers } = discoverHelperMcps(options), bundles = readHelperOAuth(options, servers);
  const provider = options.pi ? "pi" : options.provider;
  return Object.fromEntries(servers.filter(s => s.enabled && (provider
    ? s.targetProviders.includes(provider as HelperMcpTargetProvider) : s.targetProviders.length > 0)).map(s => [s.name, {
    ...(s.url ? { url: expand(s.url) } : { command: s.command, args: s.args?.map(expand) }),
    ...(s.env ? { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expand(v)])) } : {}),
    ...(s.auth ? { auth: s.auth } : {}), ...(s.timeout ? { timeout: s.timeout } : {}),
    ...((s.headers || valid(bundles[s.name])) ? { headers: helperHeaders(s, bundles[s.name]) } : {}),
    ...(options.pi ? { exposure: "direct", lifecycle: "lazy" } : { type: s.transport }),
  }]));
}
/** Public surface/prompt projection deliberately contains no credentials or endpoints. */
export function helperMcpRoster(servers: HelperMcpServerEntry[]) {
  return servers.map(({ name, transport, enabled, targetProviders, vaultSync, sources, status, statusDetail, oauthExpiresAt }) => ({ name, transport, enabled, targetProviders, vaultSync, sources, status, statusDetail, oauthExpiresAt }));
}
export function renderHelperMcpRoster(servers: Array<Pick<HelperMcpServerEntry, "name" | "transport" | "enabled" | "status">>): string {
  const enabled = servers.filter(s => s.enabled);
  return ["Available Peer Helper MCPs:", ...enabled.map(s => `${s.name} [${s.transport} · ${s.status}]${["auth_expired", "missing_env"].includes(s.status) ? " — WARNING: credentials need Owner attention before dependent dispatch" : ""}`), ...(enabled.length ? [] : ["none configured"])].join("\n");
}

function fingerprint(server: HelperMcpServerEntry, bundle?: HelperOAuthBundle): string {
  return createHash("sha256").update(JSON.stringify([server.command, server.args, server.env, server.url, server.headers, bundle?.tokens])).digest("hex");
}
const syncOperations = new Map<string, Promise<unknown>>();
/** Serialize refresh-token rotation across simultaneous Peer creates and Owner sync. */
export async function syncHelperMcps(options: HelperMcpOptions & { probe?: boolean }): Promise<HelperMcpCatalogSnapshot> {
  const previous = syncOperations.get(options.stateDir) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => syncUnlocked(options));
  syncOperations.set(options.stateDir, pending);
  try { return await pending; } finally { if (syncOperations.get(options.stateDir) === pending) syncOperations.delete(options.stateDir); }
}
