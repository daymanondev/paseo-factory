/**
 * The Settings screen (T-10a + T-10b + T-10c + T-10d, ADR 0051) — the
 * `/settings` route: the read-only fold of T-10a (both panels from the
 * existing snapshot, the design's own settings look —
 * `design/daemon-settings.css` facts/disclosure, `design/management.css`
 * vault summary + presence chips, `design/styles.css` card/badge/dialog
 * vocabulary; the design's JS is mock-only and never ported) plus the
 * Owner's vault writes through the sidecar's allowlisted door: the stepped
 * Vault setup dialog of T-10b (`factory.vault.configure` — repo prefilled
 * from suggestedRepo, branch, and an optional passphrase whose "Leave
 * unchanged" choice OMITS the field so the persisted value survives), the
 * Pull / Push buttons (`factory.vault.pull` / `factory.vault.push`, enabled
 * only when configured), each behind a confirm naming the act with its
 * mergeLedgers / includeLedgers checkbox, default off, and the two
 * round-trip writes of T-10c — the Sync button (`factory.vault.sync`,
 * confirm with mergeLedgers / includeLedger / overwriteConfigs checkboxes,
 * default off) and the Hydrate button (`factory.vault.hydrate`, confirm with
 * mergeLedgers / overwriteConfigs checkboxes, default off, overwriteConfigs
 * visibly marked destructive). The console's sync sends NO
 * repo/branch/passphrase (configure owns those) and its hydrate sends NO
 * repo/ref (the configured vault is the one that hydrates) — the door
 * refuses both shapes and the dialogs never build them. A sync success also
 * folds the handler's createdRepo/pushed facts. T-10d adds the key-import
 * write: an "Import keys" button (enabled only when configured) opening a
 * stepped dialog over `factory.vault.import` — grouped optional fields (App
 * Store Connect, Google Play, Eye config, Android signing, Firebase) typed
 * as HOST file paths the daemon reads itself (the browser never reads or
 * uploads file contents), every empty field OMITTED from the wire, a
 * "Sync after import" checkbox default off (spelled explicitly — the core's
 * own omitted default is ON), and a confirm step summarizing which groups
 * will import by names/paths only. The keystore password is an
 * `<input type="password">` under the same law as T-10b's passphrase: never
 * echoed back into the DOM after submit, never in
 * localStorage/sessionStorage/URL, cleared from component state on every
 * close. Cancel sends nothing; a success refreshes the snapshot so the
 * panel's shared-secret chips update and folds the handler's
 * importedFiles; refusals (vault-* codes) render inline as data. Still NO
 * seat start (ADR 0017), NO project reset/delete danger zone (T-10e) — and
 * no credential or passphrase text ever reaches the DOM.
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/daemon-settings.css";
import "../../../design/management.css";
import { settingsScreenModel, type SettingsSecretChip } from "../settings-view.ts";
import {
  vaultConfigureViaSidecar,
  vaultHydrateViaSidecar,
  vaultImportViaSidecar,
  vaultPullViaSidecar,
  vaultPushViaSidecar,
  vaultSyncViaSidecar,
  type VaultConfigureInput,
  type VaultConfigureReply,
  type VaultHydrateInput,
  type VaultHydrateReply,
  type VaultImportInput,
  type VaultImportReply,
  type VaultPullInput,
  type VaultPullReply,
  type VaultPushInput,
  type VaultPushReply,
  type VaultSyncInput,
  type VaultSyncReply,
} from "../vault.ts";

/** Any of the screen's write replies — the banner renders whichever landed, verbatim. */
type VaultWriteReply = VaultConfigureReply | VaultPullReply | VaultPushReply | VaultSyncReply | VaultHydrateReply | VaultImportReply;

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

// ---- the key-import dialog (T-10d) --------------------------------------------------------------------

/** The import dialog's text fields — every wire field except the checkbox. */
type ImportTextField = Exclude<keyof VaultImportInput, "syncAfterImport">;

/** One optional import field — the label the Owner reads and the wire key the handler reads. */
interface ImportFieldSpec {
  field: ImportTextField;
  label: string;
  placeholder: string;
  hint: string;
  /** storePass — the one password input, under the T-10b passphrase law. */
  password?: boolean;
}

/** One group of optional fields — the design's own grouped import form, rendered under one name. */
interface ImportGroupSpec {
  name: string;
  fields: readonly ImportFieldSpec[];
}

/** The five groups the shared schema's own fields spell (T-10d) — every field optional, every empty one omitted. */
const IMPORT_GROUPS: readonly ImportGroupSpec[] = [
  {
    name: "App Store Connect",
    fields: [
      { field: "ascKeyPath", label: "ASC .p8 key path", placeholder: "/path/to/AuthKey_XYZ.p8", hint: "ascKeyPath — the private key file on this machine; the daemon reads it, the browser never does." },
      { field: "ascKeyId", label: "ASC key ID", placeholder: "KEY123456", hint: "ascKeyId — the key's ID from App Store Connect." },
      { field: "ascIssuer", label: "ASC issuer ID", placeholder: "ISSUER-999", hint: "ascIssuer — the issuer ID from App Store Connect." },
    ],
  },
  {
    name: "Google Play",
    fields: [{ field: "gplayKeyPath", label: "Google Play service account JSON path", placeholder: "/path/to/gplay-sa.json", hint: "gplayKeyPath — the service account key file on this machine." }],
  },
  {
    name: "Eye config",
    fields: [{ field: "eyeConfigPath", label: "Eye config path", placeholder: "/path/to/eye.json", hint: "eyeConfigPath — the Eye CLI's config file on this machine." }],
  },
  {
    name: "Android signing",
    fields: [
      { field: "appKey", label: "App key", placeholder: "my-app", hint: "appKey — the app namespace the signing files seal under; empty picks the first registered Project." },
      { field: "keystorePath", label: "Android release keystore path", placeholder: "/path/to/release.keystore", hint: "keystorePath — the release keystore file on this machine." },
      { field: "storePass", label: "Keystore password", placeholder: "The keystore's store password", hint: "storePass — rides the request body once and is never displayed again; cleared on every close.", password: true },
      { field: "keyAlias", label: "Key alias", placeholder: "upload", hint: "keyAlias — the key's alias inside the keystore." },
    ],
  },
  {
    name: "Firebase",
    fields: [
      { field: "firebaseProjectId", label: "Firebase project ID", placeholder: "my-firebase-project", hint: "firebaseProjectId — written into the app's google-services.json." },
      { field: "googleServicesJsonPath", label: "google-services.json path", placeholder: "/path/to/google-services.json", hint: "googleServicesJsonPath — the Android config file on this machine." },
      { field: "googleServiceInfoPlistPath", label: "GoogleService-Info.plist path", placeholder: "/path/to/GoogleService-Info.plist", hint: "googleServiceInfoPlistPath — the iOS config file on this machine." },
    ],
  },
];

/** Every import field spec flattened — the value state and the input builder share the one list. */
const IMPORT_FIELDS: readonly ImportFieldSpec[] = IMPORT_GROUPS.flatMap((group) => group.fields);

/**
 * The Owner's key-import dialog (T-10d) — two steps over the design's own
 * `.compact-vault` vocabulary: the fields step (the five groups of OPTIONAL
 * host file paths and ids — the browser never reads or uploads any file's
 * contents; the daemon reads the paths itself — plus the "Sync after import"
 * checkbox, default off) and the confirm step, which summarizes exactly
 * which groups will import by names/paths only. Every empty field is OMITTED
 * from `factory.vault.import` (absent from the wire, never an empty string);
 * Review stays disabled until at least one field is filled. The keystore
 * password is an `<input type="password">` under the T-10b passphrase law:
 * never echoed back into the DOM after submit (the confirm step shows a
 * masked marker, never the text), never in localStorage/sessionStorage/URL,
 * and cleared from component state on every close AND after every submit
 * (either arm — a refusal keeps the typed paths for another try, never the
 * password). Cancel, Close, and the overlay send nothing.
 */
function VaultImportDialog({
  submit,
  close,
}: {
  submit: (input: VaultImportInput) => Promise<VaultImportReply>;
  close: () => void;
}) {
  const [step, setStep] = useState<"fields" | "confirm">("fields");
  const [values, setValues] = useState<Record<ImportTextField, string>>(Object.fromEntries(IMPORT_FIELDS.map((spec) => [spec.field, ""])) as Record<ImportTextField, string>);
  const [syncAfter, setSyncAfter] = useState(false);
  const [phase, setPhase] = useState<"editing" | "saving">("editing");

  /** The one field the Owner may not want to retype — gone from state on every path out. */
  const clearPassword = () => setValues((current) => ({ ...current, storePass: "" }));

  /** Every close path — Cancel, Close, the overlay, a success — lands here: no password survives. */
  const closeClean = () => {
    clearPassword();
    close();
  };

  const trimmed = (field: ImportTextField): string => values[field].trim();
  const anyFieldFilled = IMPORT_FIELDS.some((spec) => trimmed(spec.field) !== "");
  /** The groups the confirm summarizes — only the ones carrying at least one filled field. */
  const activeGroups = IMPORT_GROUPS.map((group) => ({ group, fields: group.fields.filter((spec) => trimmed(spec.field) !== "") })).filter((entry) => entry.fields.length > 0);

  /** The wire input — every empty field omitted, the checkbox spelled explicitly (the core's omitted default is ON). */
  const buildInput = (): VaultImportInput => {
    const input: VaultImportInput = { syncAfterImport: syncAfter };
    for (const spec of IMPORT_FIELDS) {
      const value = trimmed(spec.field);
      if (value !== "") input[spec.field] = value;
    }
    return input;
  };

  const run = async () => {
    setPhase("saving");
    const reply = await submit(buildInput());
    // The typed password never lingers past the submit — either arm clears it.
    clearPassword();
    setPhase("editing");
    if (reply.ok) closeClean();
    else setStep("fields");
  };

  /** The confirm's display for one field — the value for names and paths, a masked marker for the password. */
  const displayValue = (spec: ImportFieldSpec): string => (spec.password === true ? "•••••••• (hidden)" : trimmed(spec.field));

  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : closeClean}>
      <div className="dialog console-dialog" role="dialog" aria-modal="true" aria-label="Import vault keys" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Import vault keys</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={closeClean} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <div className="compact-vault">
            {step === "fields" ? (
              <>
                <p className="vault-dialog-intro">
                  Point the daemon at key files on this machine — the paths are read by the daemon itself; the browser never reads or uploads any file's contents. Every empty field is simply omitted; fill at least one to continue.
                </p>
                {IMPORT_GROUPS.map((group) => (
                  <div className="field" key={group.name}>
                    <strong>{group.name}</strong>
                    {group.fields.map((spec) => (
                      <div className="field" key={spec.field}>
                        <label htmlFor={`vault-import-${spec.field}`}>{spec.label}</label>
                        <input
                          id={`vault-import-${spec.field}`}
                          type={spec.password === true ? "password" : "text"}
                          value={values[spec.field]}
                          placeholder={spec.placeholder}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => setValues((current) => ({ ...current, [spec.field]: event.target.value }))}
                        />
                        <small>{spec.hint}</small>
                      </div>
                    ))}
                  </div>
                ))}
                <div className="field">
                  <label>
                    <input type="checkbox" checked={syncAfter} onChange={(event) => setSyncAfter(event.target.checked)} /> Sync after import
                  </label>
                  <small>syncAfterImport — off by default; on runs the unified sync against the configured vault once the keys land.</small>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn ghost" onClick={closeClean}>
                    Cancel
                  </button>
                  <button type="button" className="btn primary" disabled={!anyFieldFilled} onClick={() => setStep("confirm")}>
                    Review import
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="vault-dialog-intro">
                  The daemon imports the filled fields below into this home's vault-runtime{syncAfter ? " and then runs the unified sync against the configured vault" : " — no sync runs; the Sync after import checkbox is off"}. Recheck the paths, then confirm.
                </p>
                <dl className="data-list">
                  {activeGroups.map(({ group, fields }) => (
                    <div key={group.name}>
                      <dt>{group.name}</dt>
                      <dd>
                        {fields.map((spec) => (
                          <div key={spec.field}>
                            {spec.label}: <span className="mono">{displayValue(spec)}</span>
                          </div>
                        ))}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>Sync after import</dt>
                    <dd>{syncAfter ? "On — the unified sync runs once the keys land" : "Off"}</dd>
                  </div>
                </dl>
                {phase === "editing" ? (
                  <div className="dialog-actions">
                    <button type="button" className="btn ghost" onClick={() => setStep("fields")}>
                      Back
                    </button>
                    <button type="button" className="btn ghost" onClick={closeClean}>
                      Cancel
                    </button>
                    <button type="button" className="btn primary" onClick={() => void run()}>
                      Import keys now
                    </button>
                  </div>
                ) : (
                  <p className="small muted" role="status">
                    Importing keys…
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

// ---- the panels --------------------------------------------------------------------------------------

/** The Private Vault card — the design's own card-top + `.vault-summary` facts + `.vault-items` chips + the T-10b/T-10c/T-10d Owner acts. */
function VaultPanel({
  model,
  pending,
  onConfigure,
  onPull,
  onPush,
  onSync,
  onHydrate,
  onImport,
}: {
  model: ReturnType<typeof settingsScreenModel>;
  pending: boolean;
  onConfigure: () => void;
  onPull: () => void;
  onPush: () => void;
  onSync: () => void;
  onHydrate: () => void;
  onImport: () => void;
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
      {/* The Owner's six vault acts (T-10b + T-10c + T-10d) — Configure always offered; the five transports need a configured vault. */}
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
        <button type="button" className="btn ghost" aria-label="Import vault keys" disabled={pending || !vault.configured} onClick={onImport}>
          Import keys
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
  /** The key-import transport (T-10d) — the filled fields only, every empty one omitted from the wire. */
  vaultImport?: (input: VaultImportInput) => Promise<VaultImportReply>;
  /** Fired after a successful write — the shell refreshes the snapshot (and so the panel's stamps). */
  onChanged?: () => void;
}

/** The sync reply's own two facts the banner appends — the core's createdRepo and whether a commit moved. */
function syncOutcomeNote(reply: VaultWriteReply): string {
  if (!reply.ok || !("createdRepo" in reply)) return "";
  return ` (${reply.createdRepo ? "repo created; " : ""}${reply.pushed ? "pushed" : "nothing to push"})`;
}

/** The import reply's own fact the banner appends — the handler's importedFiles list (the shared-secret chips' new truth). */
function importOutcomeNote(reply: VaultWriteReply): string {
  if (!reply.ok || !("importedFiles" in reply)) return "";
  return ` (imported: ${reply.importedFiles.length > 0 ? reply.importedFiles.join(", ") : "nothing new"})`;
}

export function SettingsScreen({
  view,
  vaultConfigure = vaultConfigureViaSidecar,
  vaultPull = vaultPullViaSidecar,
  vaultPush = vaultPushViaSidecar,
  vaultSync = vaultSyncViaSidecar,
  vaultHydrate = vaultHydrateViaSidecar,
  vaultImport = vaultImportViaSidecar,
  onChanged = () => {},
}: SettingsScreenProps) {
  const model = settingsScreenModel(view);
  const [pending, setPending] = useState(false);
  /** The open dialog — "setup" (configure), "pull", "push", "sync", "hydrate", "import", or null. */
  const [dialog, setDialog] = useState<"setup" | "pull" | "push" | "sync" | "hydrate" | "import" | null>(null);
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
            {syncOutcomeNote(status.reply)}
            {importOutcomeNote(status.reply)}. Refreshing…
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
          onImport={() => setDialog("import")}
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
      {dialog === "import" ? <VaultImportDialog close={() => setDialog(null)} submit={(input) => run("Importing keys", () => vaultImport(input))} /> : null}
    </section>
  );
}
