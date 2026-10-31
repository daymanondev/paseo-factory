/** Private vault projection: operational definitions and secret bundles travel separately. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readHelperJson as read, writeHelperJson as write } from "./helper-mcp-store.ts";
import { discoverHelperMcps, materializeHelperOAuth, readHelperOAuth } from "./helper-mcp-sync.ts";
import type { HelperMcpOptions, HelperMcpServerEntry, HelperOAuthBundle } from "./helper-mcp-sync.ts";
export function collectHelperMcpVault(options: HelperMcpOptions, runtime: string): void {
  const { servers } = discoverHelperMcps(options);
  if (servers.length === 0) return;
  const fields: Record<string, Partial<HelperMcpServerEntry>> = {};
  const sanitized = servers.map(server => {
    const copy = { ...server }, secret: Partial<HelperMcpServerEntry> = {};
    for (const key of ["env", "headers", "auth"] as const) if (copy[key]) { Object.assign(secret, { [key]: copy[key] }); delete copy[key]; }
    if (server.env) copy.env = Object.fromEntries(Object.keys(server.env).map(key => [key, ""]));
    if (copy.url) {
      try {
        const url = new URL(copy.url);
        if (url.search || url.username || url.password) { secret.url = copy.url; url.search = ""; url.username = ""; url.password = ""; copy.url = url.toString(); }
      } catch { /* Invalid endpoints remain visible as unreachable and never prevent vault sync. */ }
    }
    if (copy.args?.some(arg => /key|token|secret|password/i.test(arg))) { secret.args = copy.args; copy.args = []; }
    fields[server.name] = secret;
    return copy;
  });
  const stored = read(join(options.stateDir, "helper-mcps.json"), true);
  write(join(runtime, "config/helper-mcps.json"), { servers: sanitized, overrides: stored.overrides ?? {} });
  write(join(runtime, "secrets/shared/mcp-oauth.json"), { oauth: readHelperOAuth(options, servers), fields });
}
export function hydrateHelperMcpVault(options: HelperMcpOptions, runtime: string, overwrite: boolean): void {
  const configPath = join(runtime, "config/helper-mcps.json");
  if (!existsSync(configPath)) return;
  const config = read(configPath, true), secrets = read(join(runtime, "secrets/shared/mcp-oauth.json"), true);
  const local = discoverHelperMcps(options).servers;
  const byName = new Map(local.map(s => [s.name, s]));
  for (const server of config.servers ?? []) {
    const remote = { ...server, ...secrets.fields?.[server.name], sources: [...new Set([...(server.sources ?? []), "vault"])] };
    const existing = byName.get(server.name);
    if (!overwrite && existing) {
      const merged = { ...existing, sources: [...new Set([...existing.sources, ...remote.sources])] };
      for (const key of ["env", "headers"] as const) {
        const values = { ...existing[key] };
        for (const [name, value] of Object.entries(remote[key] ?? {})) if (!values[name]?.trim()) values[name] = value as string;
        if (Object.keys(values).length) merged[key] = values;
      }
      byName.set(server.name, merged);
    } else byName.set(server.name, remote);
  }
  const stored = read(join(options.stateDir, "helper-mcps.json"), true);
  write(join(options.stateDir, "helper-mcps.json"), { servers: [...byName.values()], overrides: overwrite ? { ...stored.overrides, ...config.overrides } : { ...config.overrides, ...stored.overrides } });
  const bundles = readHelperOAuth(options, [...byName.values()]);
  for (const [name, remote] of Object.entries(secrets.oauth ?? {}) as Array<[string, HelperOAuthBundle]>) {
    if (!bundles[name] || (remote.tokens.expiresAt ?? 0) > (bundles[name].tokens.expiresAt ?? 0)) bundles[name] = remote;
  }
  materializeHelperOAuth(options, bundles);
}
