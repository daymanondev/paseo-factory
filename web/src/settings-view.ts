/**
 * The Settings screen's fold (T-10a, ADR 0051) — a PURE fold of the EXISTING
 * snapshot's two settings halves: the `Private vault` status card
 * (`view.vault`, the same `VaultStatusView` the RN client's Vault tab reads)
 * and the scoped Project's own identity (name/slug/root, or the honest null
 * on the unscoped global view). The fold's own laws, the task's own words:
 * the passphrase appears as a boolean only — no credential or passphrase
 * text is ever carried, so none can ever reach the DOM — the hydrate/push
 * stamps render as deterministic UTC labels or "Never" (the integrations
 * fold's own `utcStamp` string law), and every shared secret renders as a
 * presence chip, never a value. The T-10b/T-10c vault writes and the T-10e
 * danger zone belong to the screen's dialogs, not the fold: nothing here is
 * a transport or a write.
 */
import type { FactoryView, VaultStatusView } from "../../plugin/shared/view.ts";
import { utcStamp } from "./integrations-view.ts";

/** One shared-secret presence chip — the label the RN Vault bar's own vocabulary spells. */
export interface SettingsSecretChip {
  id: keyof VaultStatusView["sharedSecrets"];
  label: string;
  /** Present in the vault's secrets dir — the chip's only fact, never a value. */
  present: boolean;
}

/** The Private Vault panel — every field the card renders, dates pre-formatted, secrets as booleans. */
export interface SettingsVaultPanel {
  configured: boolean;
  /** "Configured" / "Not configured" — the card-top badge's own two faces. */
  configuredLabel: string;
  /** The configured repo (`owner/factory-vault`), or null when unconfigured — the card's honest "Not configured" title. */
  repo: string | null;
  branch: string;
  nodeId: string;
  /** Boolean only — "Set" / "Not set"; the passphrase value never exists in this model. */
  passphraseLabel: string;
  /** "Present" / "Absent" — the `<home>/vault/.git` clone probe's own answer. */
  cloneLabel: string;
  lastHydratedAt: string | null;
  /** `2026-11-08 09:00 UTC · sync` or "Never" — the stamp plus the mode that wrote it. */
  lastHydratedLabel: string;
  lastPushedAt: string | null;
  lastPushedLabel: string;
  /** The four shared-secret presence chips, the RN pills' own labels. */
  secrets: readonly SettingsSecretChip[];
  /** The hydrated app keys — an honest empty list renders "None hydrated yet". */
  hydratedApps: readonly string[];
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  /** `@<login>` or null — the gh probe's own greeting shape. */
  ghUser: string | null;
  suggestedRepo: string | null;
  /** The gather's degraded half — the panel renders it as a notice, never a failed screen. */
  error: string | null;
}

/** The scoped Project's identity — the panel's whole world, or null unscoped. */
export interface SettingsProjectPanel {
  name: string;
  slug: string;
  root: string;
  /** "SLP" / "Agile Scrum" — the Project row's own mode word (the Overview's vocabulary). */
  modeLabel: string;
}

/** The Settings screen's whole world — folds from any snapshot, scoped or not. */
export interface SettingsScreenModel {
  /** The selected Project's display name, or "All projects" — the screen renders either way. */
  scope: string;
  vault: SettingsVaultPanel;
  /** Null on the unscoped global view — the panel's honest "No project selected". */
  project: SettingsProjectPanel | null;
  /** The snapshot-level daemon degradation line, the Integrations screen's own law. */
  daemonError: string | null;
}

/** The hydrate mode's own word — `direct` reads "direct", `sync` reads "sync"; null rides no suffix. */
function hydrateModeSuffix(mode: VaultStatusView["lastHydrateMode"]): string {
  return mode === null ? "" : ` · ${mode}`;
}

/**
 * The Settings fold (T-10a): the vault card's every honest field — configured
 * face first, the repo/branch/node facts, the passphrase as a boolean and the
 * clone as a presence, the hydrate/push stamps in deterministic UTC (mode
 * beside the hydrate), the four shared-secret chips, the hydrated apps list,
 * and the gh probe's installed/login/user/suggested line — plus the scoped
 * Project's name/slug/root (or the honest null). No write, no secret value,
 * no fabricated stamp: absent halves fold to their own "Never"/"None" words.
 */
export function settingsScreenModel(view: FactoryView): SettingsScreenModel {
  const vault = view.vault;
  const project: SettingsProjectPanel | null =
    view.project === null
      ? null
      : {
          name: view.project.name ?? view.project.slug,
          slug: view.project.slug,
          root: view.project.root,
          modeLabel: view.project.executionMode === "scrum" ? "Agile Scrum" : "SLP",
        };
  return {
    scope: view.project === null ? "All projects" : (view.project.name ?? view.project.slug),
    vault: {
      configured: vault.configured,
      configuredLabel: vault.configured ? "Configured" : "Not configured",
      repo: vault.repo,
      branch: vault.branch,
      nodeId: vault.nodeId,
      passphraseLabel: vault.hasPassphrase ? "Set" : "Not set",
      cloneLabel: vault.cloneExists ? "Present" : "Absent",
      lastHydratedAt: vault.lastHydratedAt,
      lastHydratedLabel: vault.lastHydratedAt === null ? "Never" : `${utcStamp(vault.lastHydratedAt)}${hydrateModeSuffix(vault.lastHydrateMode)}`,
      lastPushedAt: vault.lastPushedAt,
      lastPushedLabel: vault.lastPushedAt === null ? "Never" : utcStamp(vault.lastPushedAt),
      secrets: [
        { id: "ascKey", label: "ASC key", present: vault.sharedSecrets.ascKey },
        { id: "ascCredentials", label: "ASC credentials", present: vault.sharedSecrets.ascCredentials },
        { id: "gplayServiceAccount", label: "Google Play", present: vault.sharedSecrets.gplayServiceAccount },
        { id: "eyeConfig", label: "Eye config", present: vault.sharedSecrets.eyeConfig },
      ],
      hydratedApps: [...vault.hydratedApps],
      ghInstalled: vault.ghInstalled,
      ghAuthenticated: vault.ghAuthenticated,
      ghUser: vault.ghUser,
      suggestedRepo: vault.suggestedRepo,
      error: vault.error,
    },
    project,
    daemonError: view.daemonError,
  };
}
