/**
 * The Settings screen (T-10a + T-10b + T-10c, ADR 0051) — the `/settings`
 * route: the read-only fold of T-10a (both panels from the existing snapshot,
 * the design's own settings look — `design/daemon-settings.css`
 * facts/disclosure, `design/management.css` vault summary + presence chips,
 * `design/styles.css` card/badge/dialog vocabulary; the design's JS is
 * mock-only and never ported) plus the Owner's vault writes through the
 * sidecar's allowlisted door: the stepped Vault setup dialog of T-10b
 * (`factory.vault.configure` — repo prefilled from suggestedRepo, branch, and
 * an optional passphrase whose "Leave unchanged" choice OMITS the field so
 * the persisted value survives) and the Pull / Push buttons
 * (`factory.vault.pull` / `factory.vault.push`, enabled only when configured),
 * each behind a confirm naming the act with its mergeLedgers / includeLedgers
 * checkbox, default off; and the two round-trip writes of T-10c — the Sync
 * button (`factory.vault.sync`, confirm with mergeLedgers / includeLedger /
 * overwriteConfigs checkboxes, default off) and the Hydrate button
 * (`factory.vault.hydrate`, confirm with mergeLedgers / overwriteConfigs
 * checkboxes, default off, overwriteConfigs visibly marked destructive). The
 * console's sync sends NO repo/branch/passphrase (configure owns those) and
 * its hydrate sends NO repo/ref (the configured vault is the one that
 * hydrates) — the door refuses both shapes and the dialogs never build them.
 * A sync success also folds the handler's createdRepo/pushed facts. The
 * passphrase is an `<input type="password">` that never echoes back into the
 * DOM after submit, never reaches localStorage/sessionStorage/URL, and
 * clears from component state on every close. Cancel sends nothing; a
 * success refreshes the snapshot so the panel's stamps update; refusals
 * (vault-* codes) render inline as data. Still NO seat start (ADR 0017), NO
 * key import (T-10d), NO project reset/delete danger zone (T-10e) — and no
 * credential or passphrase text ever reaches the DOM.
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/daemon-settings.css";
import "../../../design/management.css";
import { settingsScreenModel, type SettingsSecretChip } from "../settings-view.ts";
import {
  vaultConfigureViaSidecar,
  vaultHydrateViaSidecar,
  vaultPullViaSidecar,
  vaultPushViaSidecar,
  vaultSyncViaSidecar,
  type VaultConfigureInput,
  type VaultConfigureReply,
  type VaultHydrateInput,
  type VaultHydrateReply,
  type VaultPullInput,
  type VaultPullReply,
  type VaultPushInput,
  type VaultPushReply,
  type VaultSyncInput,
  type VaultSyncReply,
} from "../vault.ts";

/** Any of the screen's write replies — the banner renders whichever landed, verbatim. */
type VaultWriteReply = VaultConfigureReply | VaultPullReply | VaultPushReply | VaultSyncReply | VaultHydrateReply;

/** One shared-secret presence chip — the design's badge, lit green only when the secret exists. */
function SecretChip({ chip }: { chip: SettingsSecretChip }) {
  return (
    <span className={`badge${chip.present ? " green" : ""}`} aria-label={`${chip.label}${chip.present ? " present" : " absent"}`}>
      <span className={`dot ${chip.present ? "green" : "muted"}`} aria-hidden="true" />
      {chip.label}
    </span>
  );
}

// ---- the stepped Vault setup dialog (T-10b) ---------------------------------------------------------

/**
 * The Owner's configure dialog — two steps over the design's own
 * `.compact-vault` vocabulary: the connect step (repo prefilled from
 * suggestedRepo, branch) and the passphrase step, whose "Leave unchanged"
 * choice OMITS the field from `factory.vault.configure` (the schema's own
 * tri-state: absent preserves, an empty string clears, text sets) and whose
 * "Set a passphrase" choice reveals the one `<input type="password">`. The
 * passphrase never renders as text anywhere, clears from state on every
 * close AND after every submit (either arm), and never touches
 * localStorage/sessionStorage/URL. The final step's primary button IS the
 * confirm; Cancel (or the overlay, or Close) sends nothing.
 */
function VaultSetupDialog({
  model,
  submit,
  close,
}: {
  model: ReturnType<typeof settingsScreenModel>;
  submit: (input: VaultConfigureInput) => Promise<VaultConfigureReply>;
  close: () => void;
}) {
  const vault = model.vault;
  const [step, setStep] = useState<"connect" | "passphrase">("connect");
  const [repo, setRepo] = useState(vault.suggestedRepo ?? vault.repo ?? "");
  const [branch, setBranch] = useState(vault.branch);
  const [passChoice, setPassChoice] = useState<"leave" | "set">("leave");
  const [passphrase, setPassphrase] = useState("");
  const [phase, setPhase] = useState<"editing" | "saving">("editing");

  /** Every close path — Cancel, Close, the overlay, a success — lands here: no passphrase survives. */
  const closeClean = () => {
    setPassphrase("");
    setPassChoice("leave");
    close();
  };

  const run = async () => {
    setPhase("saving");
    // "Leave unchanged" omits the field — the persisted passphrase survives.
    const input: VaultConfigureInput =
      passChoice === "set" ? { repo: repo.trim(), branch: branch.trim(), passphrase } : { repo: repo.trim(), branch: branch.trim() };
    const reply = await submit(input);
    // The typed text never lingers past the submit — either arm clears it.
    setPassphrase("");
    setPassChoice("leave");
    setPhase("editing");
    if (reply.ok) closeClean();
    else setStep("passphrase");
  };

  const connectReady = repo.trim() !== "" && branch.trim() !== "";
  const saveReady = passChoice === "leave" || passphrase !== "";
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : closeClean}>
      <div className="dialog console-dialog" role="dialog" aria-modal="true" aria-label="Configure Private Vault" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Private Vault</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={closeClean} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <div className="compact-vault">
            <div className="vault-dialog-status">
              <span className={`dot ${vault.configured ? "green" : "amber"}`} aria-hidden="true" />
              {vault.configuredLabel}
            </div>
            {step === "connect" ? (
              <>
                <p className="vault-dialog-intro">
                  Point this home's private vault at a private GitHub repository (owner/repo) or a local git path — the daemon clones it on the first pull or push.
                </p>
                <div className="field">
                  <label htmlFor="vault-repository">Private repository</label>
                  <input
                    id="vault-repository"
                    value={repo}
                    placeholder="owner/factory-vault"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setRepo(event.target.value)}
                  />
                  <small>Use owner/repository format, or a local git path for a private host.</small>
                </div>
                <div className="field">
                  <label htmlFor="vault-branch">Branch</label>
                  <input id="vault-branch" value={branch} autoComplete="off" spellCheck={false} onChange={(event) => setBranch(event.target.value)} />
                  <small>The branch the vault tracks — usually main.</small>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn ghost" onClick={closeClean}>
                    Cancel
                  </button>
                  <button type="button" className="btn primary" disabled={!connectReady} onClick={() => setStep("passphrase")}>
                    Continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="vault-dialog-intro">
                  Saving connects this home's vault to <span className="mono">{repo.trim()}</span> (branch <span className="mono">{branch.trim()}</span>) — the panel's repository and branch facts refresh when it lands.
                </p>
                <div className="field">
                  <label>
                    <input
                      type="radio"
                      name="vault-passphrase"
                      value="leave"
                      checked={passChoice === "leave"}
                      onChange={() => {
                        setPassChoice("leave");
                        setPassphrase("");
                      }}
                    />{" "}
                    Leave unchanged{vault.passphraseLabel === "Set" ? " (a passphrase is set)" : " (no passphrase)"}
                  </label>
                  <label>
                    <input type="radio" name="vault-passphrase" value="set" checked={passChoice === "set"} onChange={() => setPassChoice("set")} /> Set a passphrase
                  </label>
                  {passChoice === "set" ? (
                    <input
                      type="password"
                      aria-label="Vault passphrase"
                      value={passphrase}
                      autoComplete="new-password"
                      onChange={(event) => setPassphrase(event.target.value)}
                      placeholder="Seals the vault's shared secrets"
                    />
                  ) : null}
                  <small>Optional — seals the vault's files end to end. Leave unchanged keeps whatever is persisted.</small>
                </div>
                {phase === "editing" ? (
                  <div className="dialog-actions">
                    <button type="button" className="btn ghost" onClick={() => setStep("connect")}>
                      Back
                    </button>
                    <button type="button" className="btn ghost" onClick={closeClean}>
                      Cancel
                    </button>
                    <button type="button" className="btn primary" disabled={!saveReady} onClick={() => void run()}>
                      Save configuration
                    </button>
                  </div>
                ) : (
                  <p className="small muted" role="status">
                    Saving configuration…
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- the pull / push confirm (T-10b) ----------------------------------------------------------------

/**
 * The one confirm BOTH transport acts pass through — it names the act (Pull or
 * Push), carries the configured repo/branch facts, states the honest outcome,
 * and holds the act's own optional checkbox (pull: mergeLedgers, push:
 * includeLedgers), default OFF — unchecked sends the empty input, checked
 * sends exactly the one boolean. Cancel sends nothing; a refusal keeps the
 * dialog for another try, a success closes it (the snapshot refreshes behind
 * it).
 */
function VaultActDialog({
  act,
  repo,
  branch,
  submit,
  close,
}: {
  act: "pull" | "push";
  repo: string | null;
  branch: string;
  submit: (withLedgers: boolean) => Promise<VaultWriteReply>;
  close: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [phase, setPhase] = useState<"confirm" | "saving">("confirm");
  const run = async () => {
    setPhase("saving");
    const reply = await submit(checked);
    if (reply.ok) close();
    else setPhase("confirm");
  };
  const isPull = act === "pull";
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : close}>
      <div
        className="dialog console-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isPull ? "Pull vault now?" : "Push vault now?"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <strong>{isPull ? "Pull vault now?" : "Push vault now?"}</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <div className="compact-vault">
            <p>
              {isPull
                ? `The daemon pulls ${repo ?? "the vault"} and hydrates this machine's vault-runtime from the checkout — the panel's Last hydrated stamp refreshes when it lands.`
                : `The daemon packages this machine's vault-runtime and pushes a commit to ${repo ?? "the vault"} — the panel's Last pushed stamp refreshes when it lands.`}
            </p>
            <dl className="data-list">
              <div>
                <dt>Repository</dt>
                <dd className="mono">{repo ?? "—"}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd className="mono">{branch}</dd>
              </div>
            </dl>
            <div className="field">
              <label>
                <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />{" "}
                {isPull ? "Merge the vault's node ledger snapshots into this machine's ledgers after hydrating" : "Snapshot this machine's ledgers under this node's namespace before pushing"}
              </label>
              <small>{isPull ? "mergeLedgers — off by default; on reconciles the vault's ledger history into this home." : "includeLedgers — off by default; on shares this node's ledger history with the vault."}</small>
            </div>
            {phase === "confirm" ? (
              <div className="dialog-actions">
                <button type="button" className="btn ghost" onClick={close}>
                  Cancel
                </button>
                <button type="button" className="btn primary" onClick={() => void run()}>
                  {isPull ? "Pull vault now" : "Push vault now"}
                </button>
              </div>
            ) : (
              <p className="small muted" role="status">
                {isPull ? "Pulling vault…" : "Pushing vault…"}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- the sync / hydrate confirm (T-10c) --------------------------------------------------------------

/** The one checkbox input shape both round-trip writes build — only checked fields ride, as `true`. */
type RoundtripChecks = { mergeLedgers: boolean; includeLedger: boolean; overwriteConfigs: boolean };

/** One confirm checkbox — the field it carries, its honest sentence, and its destructive marking. */
interface RoundtripOption {
  field: keyof RoundtripChecks;
  label: string;
  hint: string;
  /** overwriteConfigs — the design's red vocabulary, the only visibly destructive checkbox. */
  destructive?: boolean;
}

/** The sync confirm's three checkboxes (T-10c) — the ledger merge, the ledger snapshot, and the destructive config overwrite. */
const SYNC_OPTIONS: readonly RoundtripOption[] = [
  {
    field: "mergeLedgers",
    label: "Merge the vault's node ledger snapshots into this machine's ledgers after hydrating",
    hint: "mergeLedgers — off by default; on reconciles the vault's ledger history into this home.",
  },
  {
    field: "includeLedger",
    label: "Snapshot this machine's ledgers under this node's namespace before pushing",
    hint: "includeLedger — off by default; on shares this node's ledger history with the vault.",
  },
  {
    field: "overwriteConfigs",
    label: "Overwrite this machine's vault-backed configs with the remote's copies",
    hint: "overwriteConfigs — DESTRUCTIVE: on replaces this machine's configs with the vault's copies; off keeps local edits.",
    destructive: true,
  },
];

/** The hydrate confirm's two checkboxes (T-10c) — the ledger merge and the destructive config overwrite. */
const HYDRATE_OPTIONS: readonly RoundtripOption[] = [SYNC_OPTIONS[0]!, SYNC_OPTIONS[2]!];

/**
 * The one confirm BOTH round-trip acts pass through (the T-10b dialog law): it
 * names the act (Sync or Hydrate), carries the configured repo/branch facts —
 * the only vault either act can touch, because the console's sync never sends
 * repo/branch/passphrase and its hydrate never sends repo/ref — states the
 * honest outcome, and holds the act's own checkboxes, every one default OFF.
 * Every checkbox rides EXPLICITLY (true or false): the core's own sync
 * defaults turn an omitted mergeLedgers/includeLedger ON, so the confirm
 * spells each leg's truth and the wire's answer is the checkbox's promise.
 * Cancel sends nothing; a refusal keeps the dialog for another try, a
 * success closes it (the snapshot refreshes behind it).
 */
function VaultRoundtripDialog({
  act,
  repo,
  branch,
  submit,
  close,
}: {
  act: "sync" | "hydrate";
  repo: string | null;
  branch: string;
  submit: (checks: RoundtripChecks) => Promise<VaultWriteReply>;
  close: () => void;
}) {
  const options = act === "sync" ? SYNC_OPTIONS : HYDRATE_OPTIONS;
  const [checks, setChecks] = useState<RoundtripChecks>({ mergeLedgers: false, includeLedger: false, overwriteConfigs: false });
  const [phase, setPhase] = useState<"confirm" | "saving">("confirm");
  const run = async () => {
    setPhase("saving");
    const reply = await submit(checks);
    if (reply.ok) close();
    else setPhase("confirm");
  };
  const isSync = act === "sync";
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : close}>
      <div
        className="dialog console-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isSync ? "Sync vault now?" : "Hydrate vault now?"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <strong>{isSync ? "Sync vault now?" : "Hydrate vault now?"}</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <div className="compact-vault">
            <p>
              {isSync
                ? `The daemon runs the unified bidirectional sync against ${repo ?? "the vault"} — hydrating this machine's vault-runtime from the remote and pushing a commit when this machine has new files. The configured repository and branch ride the persisted config; this dialog never sends them. The panel's Last hydrated and Last pushed stamps refresh when it lands.`
                : `The daemon streams ${repo ?? "the vault"}'s tarball directly and unpacks it into this machine's vault-runtime — no clone is left behind. The configured repository and branch ride the persisted config; this dialog never sends them. The panel's Last hydrated stamp refreshes when it lands.`}
            </p>
            <dl className="data-list">
              <div>
                <dt>Repository</dt>
                <dd className="mono">{repo ?? "—"}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd className="mono">{branch}</dd>
              </div>
            </dl>
            {options.map((option) => (
              <div className="field" key={option.field}>
                <label>
                  <input
                    type="checkbox"
                    checked={checks[option.field]}
                    onChange={(event) => setChecks({ ...checks, [option.field]: event.target.checked })}
                  />{" "}
                  {option.label}
                </label>
                <small className={option.destructive === true ? "red" : undefined}>{option.hint}</small>
              </div>
            ))}
            {phase === "confirm" ? (
              <div className="dialog-actions">
                <button type="button" className="btn ghost" onClick={close}>
                  Cancel
                </button>
                <button type="button" className="btn primary" onClick={() => void run()}>
                  {isSync ? "Sync vault now" : "Hydrate vault now"}
                </button>
              </div>
            ) : (
              <p className="small muted" role="status">
                {isSync ? "Syncing vault…" : "Hydrating vault…"}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- the panels --------------------------------------------------------------------------------------

/** The Private Vault card — the design's own card-top + `.vault-summary` facts + `.vault-items` chips + the T-10b/T-10c Owner acts. */
function VaultPanel({
  model,
  pending,
  onConfigure,
  onPull,
  onPush,
  onSync,
  onHydrate,
}: {
  model: ReturnType<typeof settingsScreenModel>;
  pending: boolean;
  onConfigure: () => void;
  onPull: () => void;
  onPush: () => void;
  onSync: () => void;
  onHydrate: () => void;
}) {
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
      {/* The Owner's five vault acts (T-10b + T-10c) — Configure always offered; the four transports need a configured vault. */}
      <div className="vault-secondary" aria-label="Vault actions">
        <button type="button" className="btn ghost" aria-label="Configure vault" disabled={pending} onClick={onConfigure}>
          Configure
        </button>
        <button type="button" className="btn ghost" aria-label="Pull vault" disabled={pending || !vault.configured} onClick={onPull}>
          Pull
        </button>
        <button type="button" className="btn ghost" aria-label="Push vault" disabled={pending || !vault.configured} onClick={onPush}>
          Push
        </button>
        <button type="button" className="btn ghost" aria-label="Sync vault" disabled={pending || !vault.configured} onClick={onSync}>
          Sync
        </button>
        <button type="button" className="btn ghost" aria-label="Hydrate vault" disabled={pending || !vault.configured} onClick={onHydrate}>
          Hydrate
        </button>
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
      <p className="small muted">Read-only — project writes arrive in a later wave.</p>
    </div>
  );
}

// ---- the screen --------------------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: FactoryView;
  /** The configure transport (T-10b) — the sidecar RPC door by default, a fixture in tests. */
  vaultConfigure?: (input: VaultConfigureInput) => Promise<VaultConfigureReply>;
  /** The pull transport (T-10b) — the two-way sync's hydrating leg. */
  vaultPull?: (input: VaultPullInput) => Promise<VaultPullReply>;
  /** The push transport (T-10b) — the two-way sync's publishing leg. */
  vaultPush?: (input: VaultPushInput) => Promise<VaultPushReply>;
  /** The sync transport (T-10c) — the unified bidirectional round-trip (checkboxes only, never repo/branch/passphrase). */
  vaultSync?: (input: VaultSyncInput) => Promise<VaultSyncReply>;
  /** The hydrate transport (T-10c) — the zero-clone direct hydrate (checkboxes only, never repo/ref). */
  vaultHydrate?: (input: VaultHydrateInput) => Promise<VaultHydrateReply>;
  /** Fired after a successful write — the shell refreshes the snapshot (and so the panel's stamps). */
  onChanged?: () => void;
}

/** The sync reply's own two facts the banner appends — the core's createdRepo and whether a commit moved. */
function syncOutcomeNote(reply: VaultWriteReply): string {
  if (!reply.ok || !("createdRepo" in reply)) return "";
  return ` (${reply.createdRepo ? "repo created; " : ""}${reply.pushed ? "pushed" : "nothing to push"})`;
}

export function SettingsScreen({
  view,
  vaultConfigure = vaultConfigureViaSidecar,
  vaultPull = vaultPullViaSidecar,
  vaultPush = vaultPushViaSidecar,
  vaultSync = vaultSyncViaSidecar,
  vaultHydrate = vaultHydrateViaSidecar,
  onChanged = () => {},
}: SettingsScreenProps) {
  const model = settingsScreenModel(view);
  const [pending, setPending] = useState(false);
  /** The open dialog — "setup" (configure), "pull", "push", "sync", "hydrate", or null. */
  const [dialog, setDialog] = useState<"setup" | "pull" | "push" | "sync" | "hydrate" | null>(null);
  /** The last write's reply — both arms render verbatim; the dialog act closes on success. */
  const [status, setStatus] = useState<{ act: string; reply: VaultWriteReply } | null>(null);

  const run = async <R extends VaultWriteReply>(act: string, write: () => Promise<R>): Promise<R> => {
    setPending(true);
    const reply = await write();
    setPending(false);
    setStatus({ act, reply });
    if (reply.ok) onChanged();
    return reply;
  };

  return (
    <section aria-label="Settings" className="console-settings">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p className="muted">{model.scope} · Private Vault writes</p>
        </div>
      </div>
      {model.daemonError !== null ? (
        <div className="notice" role="status">
          Live settings are degraded ({model.daemonError}) — the screen renders the last known snapshot.
        </div>
      ) : null}
      {status !== null ? (
        status.reply.ok ? (
          <div className="console-banner console-banner-ok" role="status">
            {status.act} — {status.reply.summary}
            {syncOutcomeNote(status.reply)}. Refreshing…
          </div>
        ) : (
          <div className="console-banner console-banner-error" role="alert">
            {status.act} refused ({status.reply.code}): {status.reply.error}
          </div>
        )
      ) : null}
      <div className="settings-grid">
        <VaultPanel
          model={model}
          pending={pending}
          onConfigure={() => setDialog("setup")}
          onPull={() => setDialog("pull")}
          onPush={() => setDialog("push")}
          onSync={() => setDialog("sync")}
          onHydrate={() => setDialog("hydrate")}
        />
        <ProjectPanel model={model} />
      </div>
      {dialog === "setup" ? (
        <VaultSetupDialog
          model={model}
          close={() => setDialog(null)}
          submit={(input) => run("Configuring the vault", () => vaultConfigure(input))}
        />
      ) : null}
      {dialog === "pull" ? (
        <VaultActDialog
          act="pull"
          repo={model.vault.repo}
          branch={model.vault.branch}
          close={() => setDialog(null)}
          submit={(withLedgers) => run("Pulling the vault", () => vaultPull(withLedgers ? { mergeLedgers: true } : {}))}
        />
      ) : null}
      {dialog === "push" ? (
        <VaultActDialog
          act="push"
          repo={model.vault.repo}
          branch={model.vault.branch}
          close={() => setDialog(null)}
          submit={(withLedgers) => run("Pushing the vault", () => vaultPush(withLedgers ? { includeLedgers: true } : {}))}
        />
      ) : null}
      {dialog === "sync" ? (
        <VaultRoundtripDialog
          act="sync"
          repo={model.vault.repo}
          branch={model.vault.branch}
          close={() => setDialog(null)}
          submit={(checks) =>
            run("Syncing the vault", () =>
              vaultSync({ mergeLedgers: checks.mergeLedgers, includeLedger: checks.includeLedger, overwriteConfigs: checks.overwriteConfigs }),
            )
          }
        />
      ) : null}
      {dialog === "hydrate" ? (
        <VaultRoundtripDialog
          act="hydrate"
          repo={model.vault.repo}
          branch={model.vault.branch}
          close={() => setDialog(null)}
          submit={(checks) => run("Hydrating the vault", () => vaultHydrate({ mergeLedgers: checks.mergeLedgers, overwriteConfigs: checks.overwriteConfigs }))}
        />
      ) : null}
    </section>
  );
}
