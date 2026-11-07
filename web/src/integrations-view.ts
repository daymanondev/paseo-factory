/**
 * The Integrations screen's fold (T-09a, ADR 0051) — a PURE fold of the
 * EXISTING snapshot: the plugin roster (the Core plugin, the companion
 * tools, the companion catalog — each card's status word, version, and
 * on-demand update state), the host skill ecosystem's own rows (the skills
 * each provider carries, linked vs available in its own vocabulary), the
 * Helper MCP roster (name, transport, connection health), the scoped
 * Project's Open Design link (project name, screen count, synced-at,
 * digest — or the honest null), and the plugins-checked-at stamp. No new
 * door, no writes — the screen this feeds is read-only by construction
 * (install/manage/check-updates land in T-09b). Status vocabularies reuse
 * the RN client's own words (`plugin/client/factory/plugins.tsx`,
 * `helper-mcps.tsx`) so the console and the client can never disagree.
 */
import type { CompanionPluginView, CompanionStatus, FactoryView } from "../../plugin/shared/view.ts";

/** The roster's row shapes, indexed off the view the way the RN client does (`helper-mcps.tsx`'s own law). */
type HelperMcpRow0 = NonNullable<FactoryView["helperMcps"]>[number];
type HostItem0 = NonNullable<FactoryView["skillHub"]>["hostCatalog"][number];

/** The plugin card's own status faces — the RN roster's four words verbatim. */
const PLUGIN_STATUS: Record<CompanionStatus, { label: string; tone: "green" | "amber" | "red" | "muted" }> = {
  running: { label: "Running", tone: "green" },
  disabled: { label: "Disabled", tone: "amber" },
  failed: { label: "Failed", tone: "red" },
  not_installed: { label: "Not Installed", tone: "muted" },
};

/** The MCP card's health faces — the RN helper roster's five words verbatim (disabled reads "Local on Host"). */
const MCP_STATUS: Record<HelperMcpRow0["status"], { label: string; tone: "green" | "amber" | "muted" }> = {
  connected: { label: "Connected", tone: "green" },
  auth_expired: { label: "Auth Expired", tone: "amber" },
  missing_env: { label: "Missing Key", tone: "amber" },
  unreachable: { label: "Unreachable", tone: "amber" },
  disabled: { label: "Local on Host", tone: "muted" },
};

/** One plugin card row — the Core plugin, a companion tool, or a catalog companion. */
export interface IntegrationsPluginRow {
  id: string;
  title: string;
  description: string;
  /** The design's own icon tone — coral for the Core plugin, lime for the tools, cyan for the companions. */
  tone: "cyan" | "coral" | "lime";
  /** True for the Core plugin card — the catalog's own "CORE" mark. */
  core: boolean;
  status: CompanionStatus;
  statusLabel: string;
  statusTone: "green" | "amber" | "red" | "muted";
  /** `v0.2.3` — null when uninstalled or unknown, never a fabricated version. */
  versionLabel: string | null;
  /** The on-demand update check's own answer — null is unchecked or a local install. */
  updateAvailable: boolean | null;
  /** How many commits behind the remote head — null when unchecked or local. */
  commitsBehind: number | null;
}

/** One host-ecosystem row — the skills a provider carries, linked vs available in the hub's own vocabulary. */
export interface IntegrationsSkillRow {
  id: string;
  name: string;
  ecosystem: string;
  kind: HostItem0["kind"];
  skills: readonly string[];
  status: HostItem0["status"];
  mcpServers: readonly string[];
}

/** One Helper MCP card — name, transport, and the connection health fold. */
export interface IntegrationsMcpRow {
  name: string;
  transport: HelperMcpRow0["transport"];
  enabled: boolean;
  status: HelperMcpRow0["status"];
  statusLabel: string;
  statusTone: "green" | "amber" | "muted";
  statusDetail: string | null;
}

/** The scoped Project's Open Design link — the snapshot's own fields, dates pre-formatted. */
export interface IntegrationsOpenDesign {
  projectId: string;
  projectName: string;
  screenCount: number;
  syncedAt: string;
  syncedAtLabel: string;
  digest: string;
  digestShort: string;
}

/** The Integrations screen's whole world — folds from any snapshot, scoped or not. */
export interface IntegrationsScreenModel {
  /** The selected Project's display name, or "All projects" — the screen renders either way. */
  scope: string;
  /** The Core plugin first, then the companion tools, then the catalog companions. */
  plugins: readonly IntegrationsPluginRow[];
  skills: readonly IntegrationsSkillRow[];
  mcps: readonly IntegrationsMcpRow[];
  /** Null when the scoped Project carries no link — the card's honest "Not linked". */
  openDesign: IntegrationsOpenDesign | null;
  pluginsCheckedAt: string | null;
  pluginsCheckedAtLabel: string;
  daemonError: string | null;
  /** How many plugin cards hold an available update — the Plugins tab's own dot. */
  updateCount: number;
}

/**
 * Renders an ISO timestamp as a deterministic UTC label (`2026-11-08 09:00 UTC`)
 * — pure string work, never `toLocaleString`, so jsdom, node, and the browser
 * can never disagree about the stamp.
 */
export function utcStamp(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match === null ? iso : `${match[1]} ${match[2]} UTC`;
}

/** One `CompanionPluginView` → one card row, the tone decided by the caller's roster slot. */
function pluginRow(plugin: CompanionPluginView, tone: "cyan" | "coral" | "lime", core: boolean): IntegrationsPluginRow {
  const status = PLUGIN_STATUS[plugin.status];
  return {
    id: plugin.id,
    title: plugin.title,
    description: plugin.description,
    tone,
    core,
    status: plugin.status,
    statusLabel: status.label,
    statusTone: status.tone,
    versionLabel: plugin.version === null ? null : `v${plugin.version.replace(/^v/, "")}`,
    updateAvailable: plugin.updateAvailable,
    commitsBehind: plugin.commitsBehind,
  };
}

/**
 * The Integrations fold (T-09a) — everything the read-only screen renders
 * from the snapshot alone: plugin cards (Core coral-first, then the lime
 * companion tools, then the cyan catalog), the host skill ecosystem's own
 * rows with their linked/available state, the Helper MCP roster, the scoped
 * Project's Open Design link, and the checked-at stamp with its honest
 * "Never checked". Absent optional halves fold to empty lists — each
 * section's empty state is the screen's own, never a fabricated row.
 */
export function integrationsScreenModel(view: FactoryView): IntegrationsScreenModel {
  const plugins: IntegrationsPluginRow[] = [
    pluginRow(view.corePlugin, "coral", true),
    ...(view.companionTools ?? []).map((tool) => pluginRow(tool, "lime", false)),
    ...view.companions.map((companion) => pluginRow(companion, "cyan", false)),
  ];
  const link = view.execution?.openDesignLink;
  const openDesign: IntegrationsOpenDesign | null =
    link === undefined
      ? null
      : {
          projectId: link.projectId,
          projectName: link.projectName,
          screenCount: link.screenCount,
          syncedAt: link.syncedAt,
          syncedAtLabel: utcStamp(link.syncedAt),
          digest: link.digest,
          digestShort: link.digest.slice(0, 12),
        };
  return {
    scope: view.project === null ? "All projects" : (view.project.name ?? view.project.slug),
    plugins,
    skills: (view.skillHub?.hostCatalog ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      ecosystem: item.ecosystem,
      kind: item.kind,
      skills: [...item.skills],
      status: item.status,
      mcpServers: [...item.mcpServers],
    })),
    mcps: (view.helperMcps ?? []).map((mcp) => {
      const status = MCP_STATUS[mcp.status];
      return {
        name: mcp.name,
        transport: mcp.transport,
        enabled: mcp.enabled,
        status: mcp.status,
        statusLabel: status.label,
        statusTone: status.tone,
        statusDetail: mcp.statusDetail ?? null,
      };
    }),
    openDesign,
    pluginsCheckedAt: view.pluginsCheckedAt,
    pluginsCheckedAtLabel: view.pluginsCheckedAt === null ? "Never checked" : `Checked ${utcStamp(view.pluginsCheckedAt)}`,
    daemonError: view.daemonError,
    updateCount: plugins.filter((plugin) => plugin.updateAvailable === true).length,
  };
}
