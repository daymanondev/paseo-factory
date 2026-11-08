/**
 * The Settings screen (T-10a, ADR 0051) — the `/settings` route, read-only
 * and folded entirely from the existing snapshot. Two panels in the design's
 * own settings look (`design/daemon-settings.css` facts/disclosure,
 * `design/management.css` vault summary + presence chips, `design/styles.css`
 * card/badge vocabulary — its JS is mock-only and never ported): the
 * `Private vault (GitHub)` card from `view.vault` — the configured face
 * first, the repo/branch/node facts, the passphrase as a boolean and the
 * clone as a presence, the hydrate/push stamps in deterministic UTC or
 * "Never", the four shared-secret presence chips (never values), the
 * hydrated apps list, and the gh probe's installed/login/user/suggested
 * line inside the diagnostics disclosure — and the scoped Project's
 * name/slug/root card, or the honest "No project selected" when the console
 * runs unscoped. The screen carries NO write controls: no vault
 * configure/hydrate/sync/import (T-10b), no reset/delete danger zone
 * (T-10c), no seat start (ADR 0017) — the disclosure is the only moving
 * part, and no credential or passphrase text ever reaches the DOM.
 */
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/daemon-settings.css";
import "../../../design/management.css";
import { settingsScreenModel, type SettingsSecretChip } from "../settings-view.ts";

/** One shared-secret presence chip — the design's badge, lit green only when the secret exists. */
function SecretChip({ chip }: { chip: SettingsSecretChip }) {
  return (
    <span className={`badge${chip.present ? " green" : ""}`} aria-label={`${chip.label}${chip.present ? " present" : " absent"}`}>
      <span className={`dot ${chip.present ? "green" : "muted"}`} aria-hidden="true" />
      {chip.label}
    </span>
  );
}

/** The Private Vault card — the design's own card-top + `.vault-summary` facts + `.vault-items` chips + a daemon-settings disclosure. */
function VaultPanel({ model }: { model: ReturnType<typeof settingsScreenModel> }) {
  const vault = model.vault;
  return (
    <div className="panel content-card console-settings-vault" aria-label="Private vault">
      <div className="card-top">
        <div>
          <span className="eyebrow">PRIVATE VAULT (GITHUB)</span>
          <h2>{vault.repo ?? "Not configured"}</h2>
        </div>
        <span className={`badge${vault.configured ? " green" : ""}`}>
          <span className={`dot ${vault.configured ? "green" : "muted"}`} aria-hidden="true" />
          {vault.configuredLabel}
        </span>
      </div>
      {vault.error !== null ? (
        <div className="notice" role="status">
          Vault status degraded ({vault.error}) — the card renders the last known gather.
        </div>
      ) : null}
      <dl className="vault-summary">
        <div>
          <dt>Repository</dt>
          <dd className="mono">{vault.repo ?? "—"}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd className="mono">{vault.branch}</dd>
        </div>
        <div>
          <dt>Passphrase</dt>
          <dd>{vault.passphraseLabel}</dd>
        </div>
        <div>
          <dt>Last hydrated</dt>
          <dd>{vault.lastHydratedLabel}</dd>
        </div>
        <div>
          <dt>Last pushed</dt>
          <dd>{vault.lastPushedLabel}</dd>
        </div>
        <div>
          <dt>Hydrated apps</dt>
          <dd>{vault.hydratedApps.length > 0 ? vault.hydratedApps.join(", ") : "None hydrated yet"}</dd>
        </div>
      </dl>
      <div className="vault-items" aria-label="Shared secrets">
        {vault.secrets.map((chip) => (
          <SecretChip key={chip.id} chip={chip} />
        ))}
      </div>
      <details className="daemon-settings-diagnostics">
        <summary>
          <span>Vault transport details</span>
          <span className="settings-disclosure-chevron" aria-hidden="true">
            ›
          </span>
        </summary>
        <dl className="daemon-settings-facts">
          <div>
            <dt>Node ID</dt>
            <dd className="mono">{vault.nodeId}</dd>
          </div>
          <div>
            <dt>Clone</dt>
            <dd>{vault.cloneLabel}</dd>
          </div>
          <div>
            <dt>GitHub CLI</dt>
            <dd>{vault.ghInstalled ? "Installed" : "Not installed"}</dd>
          </div>
          <div>
            <dt>GitHub login</dt>
            <dd>{vault.ghUser !== null ? `@${vault.ghUser}` : vault.ghAuthenticated ? "Authenticated" : "Not authenticated"}</dd>
          </div>
          <div>
            <dt>Suggested repository</dt>
            <dd className="mono">{vault.suggestedRepo ?? "—"}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

/** The scoped Project card — the design's project settings rows, read from the snapshot alone. */
function ProjectPanel({ model }: { model: ReturnType<typeof settingsScreenModel> }) {
  const project = model.project;
  if (project === null) {
    return (
      <div className="panel content-card console-settings-project" aria-label="Project settings">
        <div className="card-top">
          <div>
            <span className="eyebrow">PROJECT</span>
            <h2>No project selected</h2>
          </div>
        </div>
        <p>The console is running on the global view — choose a Project in the switcher to read its settings here. Project writes arrive in a later wave.</p>
      </div>
    );
  }
  return (
    <div className="panel content-card console-settings-project" aria-label="Project settings">
      <div className="card-top">
        <div>
          <span className="eyebrow">PROJECT</span>
          <h2>{project.name}</h2>
        </div>
        <span className="badge cyan">{project.modeLabel}</span>
      </div>
      <dl className="project-settings-list">
        <div className="project-setting-row">
          <dt>Name</dt>
          <dd>
            <strong>{project.name}</strong>
          </dd>
        </div>
        <div className="project-setting-row">
          <dt>Slug</dt>
          <dd className="mono">{project.slug}</dd>
        </div>
        <div className="project-setting-row">
          <dt>Root</dt>
          <dd className="setting-path mono">{project.root}</dd>
        </div>
      </dl>
      <p className="small muted">Read-only — vault and project writes arrive in later waves.</p>
    </div>
  );
}

export interface SettingsScreenProps {
  view: FactoryView;
}

export function SettingsScreen({ view }: SettingsScreenProps) {
  const model = settingsScreenModel(view);
  return (
    <section aria-label="Settings" className="console-settings">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p className="muted">{model.scope} · Read-only</p>
        </div>
      </div>
      {model.daemonError !== null ? (
        <div className="notice" role="status">
          Live settings are degraded ({model.daemonError}) — the screen renders the last known snapshot.
        </div>
      ) : null}
      <div className="settings-grid">
        <VaultPanel model={model} />
        <ProjectPanel model={model} />
      </div>
    </section>
  );
}
