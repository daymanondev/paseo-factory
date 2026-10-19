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
export interface CompanionCatalogEntry {
  id: "factory-burn-lab" | "factory-connector" | "factory-release-lab";
  title: string;
  tagline: string;
  description: string;
  canonicalSource: string;
  sidebarLabel: string;
  sidebarIcon: string;
  capabilities: readonly string[];
}

/** The official Factory companion family — catalog order is the card order. */
export const COMPANION_CATALOG: readonly CompanionCatalogEntry[] = [
  {
    id: "factory-burn-lab",
    title: "Burn Lab",
    tagline: "The autonomous OpenCode free-model burner.",
    description:
      "An autonomous OpenCode free-model burner supervised by each Project's Supervisor — it takes factory work through free-model burns under the standing Supervisor seat's watch.",
    canonicalSource: "git:daymanondev/factory-burn-lab:plugin",
    sidebarLabel: "Burn Lab",
    sidebarIcon: "Flame",
    capabilities: ["Scout Pool", "OSS Lab", "Proto Arena", "Night Shift", "Self-Evolve"],
  },
  {
    id: "factory-connector",
    title: "Fleet Connector",
    tagline: "The symmetric peer Fleet over Tailscale.",
    description:
      "A symmetric peer Fleet over Tailscale with 1-click Handoff, Burst, and Git-native sync — it connects this factory to peer factories for handoffs and cooperative bursts.",
    canonicalSource: "git:daymanondev/factory-connector:plugin",
    sidebarLabel: "Fleet Connector",
    sidebarIcon: "Network",
    capabilities: ["Tailscale Fleet Surface", "1-Click Handoff", "Cooperative Burst", "Git Mirror & Ref Sync"],
  },
  {
    id: "factory-release-lab",
    title: "Release Lab",
    tagline: "The sequential iOS & Android store-ops and release workflow lab.",
    description:
      "An agent-managed 7-phase iOS (App Store Connect) and Android (Google Play) release workflow engine with Day-0 bootstrap, signing & Firebase SHA hygiene, Screenshot Studio, and idempotent IAP reconciliation.",
    canonicalSource: "git:daymanondev/factory-release-lab:plugin",
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
