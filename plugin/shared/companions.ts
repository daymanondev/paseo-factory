/**
 * The Factory companion plugin catalog (v0.0.17, ADR 0012 §2) — the pure
 * declarative vocabulary of the official first-party companions both halves
 * of the plugin share: the server folds it against the daemon's plugin list
 * into `FactoryView.companions`, the client renders it as the Plugins tab's
 * cards. Plain data only — `shared/` may be imported by both bundles, so this
 * module names no SDK surface, no node built-in, and imports nothing at all.
 *
 * The catalog is the single source of install truth: no code path probes or
 * prefers `../` sibling directories on the host disk, so installation behaves
 * identically on user and developer machines, macOS and Windows alike.
 */
/**
 * A companion's access tier (v0.0.30, ADR 0012 §2 / ADR 0014 §1): `public`
 * repos install for anyone (and ride `Install All`); `private` repos are
 * invite-only — skipped by `Install All` and gated on a pull-access pre-flight
 * when explicitly installed.
 */
export type PluginAccessTier = "public" | "private";

export interface CompanionCatalogEntry {
  id: "factory-burn-lab" | "factory-release-lab";
  title: string;
  tagline: string;
  description: string;
  canonicalSource: string;
  /** Who may install this repository — public open-source or private invite-only (v0.0.30). */
  access: PluginAccessTier;
  sidebarLabel: string;
  sidebarIcon: string;
  capabilities: readonly string[];
}

export interface CorePluginCatalogEntry {
  id: "paseo-factory";
  title: string;
  tagline: string;
  description: string;
  canonicalSource: string;
  /** The Core plugin is always publicly installable — the tier rides the card like any companion (v0.0.30). */
  access: PluginAccessTier;
  sidebarLabel: string;
  sidebarIcon: string;
  capabilities: readonly string[];
}

/** Default semantic version for the Core plugin when the daemon list does not carry a disk path (e.g. unit test fixtures). */
export const CORE_PLUGIN_DEFAULT_VERSION = "0.0.26";

/** The Core Factory plugin entry — rendered at the top of the Plugins tab above the companion catalog (v0.0.25, ADR 0012 §2). */
export const CORE_PLUGIN_ENTRY: CorePluginCatalogEntry = {
  id: "paseo-factory",
  title: "Factory Core",
  tagline: "The verification core — Contracts, Gates, Fresh-eyes, Watch, Retro, and Project seats.",
  description:
    "Verification core for Paseo agents: owner-set contracts, a gate the agent cannot grade itself with, an append-only ledger, and standing Supervisor/Lead project seats.",
  canonicalSource: "git:daymanondev/paseo-factory:plugin",
  access: "public",
  sidebarLabel: "Factory",
  sidebarIcon: "Blocks",
  capabilities: ["Contracts & Gates", "Append-Only Ledger", "Supervisor & Lead Seats", "Fresh-Eyes & Watch", "Private Vault Sync"],
};

/** Every plugin id the Plugins tab can manage (Core + Companions). */
export type ManageablePluginId = CorePluginCatalogEntry["id"] | CompanionCatalogEntry["id"];

/** Set of every plugin id managed by the Factory surface (Core + Companions). */
export const MANAGEABLE_PLUGIN_IDS: ReadonlySet<string> = new Set<string>([
  "paseo-factory",
  "factory-burn-lab",
  "factory-release-lab",
]);

/** The official Factory companion family — catalog order is the card order. */
export const COMPANION_CATALOG: readonly CompanionCatalogEntry[] = [
  {
    id: "factory-burn-lab",
    title: "Burn Lab",
    tagline: "The autonomous OpenCode free-model burner.",
    description:
      "An autonomous OpenCode free-model burner supervised by each Project's Supervisor — it takes factory work through free-model burns under the standing Supervisor seat's watch.",
    canonicalSource: "git:daymanondev/factory-burn-lab:plugin",
    access: "public",
    sidebarLabel: "Burn Lab",
    sidebarIcon: "Flame",
    capabilities: ["Scout Pool", "OSS Lab", "Proto Arena", "Night Shift", "Self-Evolve"],
  },
  {
    id: "factory-release-lab",
    title: "Release Lab",
    tagline: "The sequential iOS & Android store-ops and release workflow lab.",
    description:
      "An agent-managed 7-phase iOS (App Store Connect) and Android (Google Play) release workflow engine with Day-0 bootstrap, signing & Firebase SHA hygiene, Screenshot Studio, and idempotent IAP reconciliation.",
    canonicalSource: "git:daymanondev/factory-release-lab:plugin",
    access: "private",
    sidebarLabel: "Release Lab",
    sidebarIcon: "Rocket",
    capabilities: [
      "7-Phase Release Pipeline",
      "ASC & Google Play IAP Sync",
      "Signing & Firebase SHA Bridge",
      "Screenshot Studio",
    ],
  },
];
