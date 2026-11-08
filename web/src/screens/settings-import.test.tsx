/**
 * The Settings screen's key-import journeys (T-10d): the Owner's sixth vault
 * act through its transport slot — the stepped import dialog
 * (`factory.vault.import`: the five groups of optional fields — App Store
 * Connect, Google Play, Eye config, Android signing, Firebase — every empty
 * field OMITTED from the wire, the "Sync after import" checkbox default off
 * and spelled explicitly because the core's own omitted default is ON). The
 * fields step gates Review on at least one filled field; the confirm step
 * summarizes exactly which groups will import by names/paths only — the
 * keystore password renders a masked marker, never its text. Cancel sends
 * nothing at every step; the confirm sends exactly the filled fields plus
 * the checkbox. The storePass law is asserted hard (the T-10b passphrase
 * law): an `<input type="password">` while editing, never echoed back into
 * the DOM after submit (no element's value, no text node), never in
 * localStorage/sessionStorage, never in the URL, and cleared from state on
 * every close — success, refusal, or cancel; a refusal keeps the typed
 * paths for another try but never the password. A success closes the
 * dialog, fires the shell's refresh (`onChanged`), and the banner carries
 * the handler's own `summary` plus its `importedFiles` list.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView, VaultStatusView } from "../../../plugin/shared/view.ts";
import type { VaultImportReply } from "../vault.ts";
import { fixtureView } from "../test/fixture-view.ts";
import { SettingsScreen } from "./settings.tsx";

afterEach(() => {
  cleanup();
});

/** A vault half — every field honest, the shared secrets booleans only (never a value). */
function vault(over: Partial<VaultStatusView> = {}): VaultStatusView {
  return {
    configured: false,
    repo: null,
    branch: "main",
    nodeId: "node-1",
    hasPassphrase: false,
    cloneExists: false,
    lastHydratedAt: null,
    lastHydrateMode: null,
    lastPushedAt: null,
    sharedSecrets: { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
    hydratedApps: [],
    ghInstalled: false,
    ghAuthenticated: false,
    ghUser: null,
    suggestedRepo: null,
    error: null,
    ...over,
  };
}

/** The configured vault — the import act's own facts. */
const configuredView = (): FactoryView => {
  const view = fixtureView();
  view.vault = vault({ configured: true, repo: "octocat/factory-vault", branch: "release", hasPassphrase: true, cloneExists: true });
  return view;
};

/** The handler's own import sentence — the banner carries it verbatim. */
const IMPORT_SUMMARY = "Imported 1 secret file(s) (secrets/shared/asc-api-key.p8) into local vault-runtime.";

/** The whole DOM's text and every input's value — the keystore password can hide in neither. */
const domHolds = (needle: string): boolean => {
  if ((document.body.textContent ?? "").includes(needle)) return true;
  return Array.from(document.querySelectorAll("input")).some((input) => input.value === needle);
};

describe("the import gate — the stepped dialog", () => {
  it("opens with every group's fields empty and Review disabled — Cancel sends nothing", async () => {
    const vaultImport = vi.fn(async (): Promise<VaultImportReply> => ({ ok: true, vault: vault({ configured: true }), importedFiles: [], pushed: false, summary: IMPORT_SUMMARY }));
    render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    const dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    // The five groups the shared schema spells — every field present, every one empty.
    for (const group of ["App Store Connect", "Google Play", "Eye config", "Android signing", "Firebase"]) {
      expect(within(dialog).getAllByText(group).length).toBeGreaterThan(0);
    }
    for (const label of [
      "ASC .p8 key path",
      "ASC key ID",
      "ASC issuer ID",
      "Google Play service account JSON path",
      "Eye config path",
      "App key",
      "Android release keystore path",
      "Keystore password",
      "Key alias",
      "Firebase project ID",
      "google-services.json path",
      "GoogleService-Info.plist path",
    ]) {
      expect((within(dialog).getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
    // Review stays disabled until at least one field is filled — an honest gate, not a silent omit.
    expect(within(dialog).getByRole("button", { name: "Review import" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("ASC key ID"), { target: { value: "KEY123456" } });
    expect(within(dialog).getByRole("button", { name: "Review import" }).hasAttribute("disabled")).toBe(false);
    // The sync checkbox is off by default — the core's own omitted default is ON, so off must be explicit.
    expect((within(dialog).getByRole("checkbox", { name: "Sync after import" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(vaultImport).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the confirm summarizes the groups by names/paths only — storePass renders a masked marker, never its text", async () => {
    const SECRET = "keystore-secret-pass";
    const vaultImport = vi.fn(async (): Promise<VaultImportReply> => ({ ok: true, vault: vault({ configured: true }), importedFiles: [], pushed: false, summary: IMPORT_SUMMARY }));
    render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    const dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    const password = within(dialog).getByLabelText("Keystore password") as HTMLInputElement;
    expect(password.type, "the keystore password is the one password input").toBe("password");
    fireEvent.change(within(dialog).getByLabelText("ASC .p8 key path"), { target: { value: "/tmp/AuthKey_XYZ.p8" } });
    fireEvent.change(within(dialog).getByLabelText("ASC key ID"), { target: { value: "KEY123456" } });
    fireEvent.change(within(dialog).getByLabelText("App key"), { target: { value: "patigame" } });
    fireEvent.change(within(dialog).getByLabelText("Android release keystore path"), { target: { value: "/tmp/release.keystore" } });
    fireEvent.change(password, { target: { value: SECRET } });
    fireEvent.change(within(dialog).getByLabelText("Key alias"), { target: { value: "upload" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review import" }));
    // The confirm names only the groups carrying a filled field — the three empty groups never appear as facts.
    const confirm = screen.getByRole("dialog", { name: "Import vault keys" });
    expect(within(confirm).getAllByText("App Store Connect").length).toBeGreaterThan(0);
    expect(within(confirm).getAllByText("Android signing").length).toBeGreaterThan(0);
    expect(within(confirm).queryAllByText(/Google Play|Eye config|Firebase/).length).toBe(0);
    expect(within(confirm).getAllByText("/tmp/AuthKey_XYZ.p8").length).toBeGreaterThan(0);
    expect(within(confirm).getAllByText("/tmp/release.keystore").length).toBeGreaterThan(0);
    expect(within(confirm).getAllByText("upload").length).toBeGreaterThan(0);
    // The password shows its masked marker — its text exists nowhere in the confirm.
    expect(within(confirm).getByText(/••••••••/)).toBeTruthy();
    expect(within(confirm).getByText("Sync after import")).toBeTruthy();
    expect(domHolds(SECRET), "the confirm never spells the keystore password").toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(vaultImport).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("empty fields are omitted from the wire and syncAfterImport rides explicitly — off sends false, checked sends true", async () => {
    const vaultImport = vi.fn(async (): Promise<VaultImportReply> => ({ ok: true, vault: vault({ configured: true }), importedFiles: ["secrets/shared/gplay-service-account.json"], pushed: false, summary: "Imported 1 secret file(s)." }));
    const first = render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    let dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    // One filled path beside five left empty — the empty ones never ride.
    fireEvent.change(within(dialog).getByLabelText("Google Play service account JSON path"), { target: { value: "  /tmp/gplay-sa.json  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review import" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Import vault keys" })).getByRole("button", { name: "Import keys now" }));
    await waitFor(() => expect(vaultImport).toHaveBeenCalledTimes(1));
    // Exactly the trimmed path and the explicit off — no empty strings, no omitted-flag default.
    expect(vaultImport).toHaveBeenCalledWith({ gplayKeyPath: "/tmp/gplay-sa.json", syncAfterImport: false });
    first.unmount();
    const second = render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    fireEvent.change(within(dialog).getByLabelText("Eye config path"), { target: { value: "/tmp/eye.json" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sync after import" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Review import" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Import vault keys" })).getByRole("button", { name: "Import keys now" }));
    await waitFor(() => expect(vaultImport).toHaveBeenCalledTimes(2));
    expect(vaultImport).toHaveBeenLastCalledWith({ eyeConfigPath: "/tmp/eye.json", syncAfterImport: true });
    second.unmount();
  });

  it("a success closes the dialog, fires the refresh, and the banner folds the summary with its importedFiles", async () => {
    const vaultImport = vi.fn(async (): Promise<VaultImportReply> => ({
      ok: true,
      vault: vault({ configured: true, sharedSecrets: { ascKey: true, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false } }),
      importedFiles: ["secrets/shared/asc-api-key.p8"],
      pushed: false,
      summary: IMPORT_SUMMARY,
    }));
    const onChanged = vi.fn();
    render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    const dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    fireEvent.change(within(dialog).getByLabelText("ASC .p8 key path"), { target: { value: "/tmp/AuthKey_XYZ.p8" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review import" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Import vault keys" })).getByRole("button", { name: "Import keys now" }));
    await waitFor(() => expect(vaultImport).toHaveBeenCalledTimes(1));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Importing keys");
    expect(status.textContent).toContain(IMPORT_SUMMARY);
    expect(status.textContent).toContain("(imported: secrets/shared/asc-api-key.p8)");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the storePass law on the submit — the typed password never echoes back after success", async () => {
    const SECRET = "never-lands-anywhere";
    const vaultImport = vi.fn(async (): Promise<VaultImportReply> => ({ ok: true, vault: vault({ configured: true }), importedFiles: ["secrets/apps/patigame/signing.json"], pushed: false, summary: "Imported 1 secret file(s)." }));
    render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    const dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    fireEvent.change(within(dialog).getByLabelText("Keystore password"), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review import" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Import vault keys" })).getByRole("button", { name: "Import keys now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // After the submit: no text node, no input value, no storage, no URL — the password is gone.
    expect(domHolds(SECRET), "the keystore password never echoes back into the DOM").toBe(false);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("a refusal rides as data, keeps the typed paths for another try, and clears the password", async () => {
    const SECRET = "refused-and-cleared";
    let refuse = true;
    const vaultImport = vi.fn(async (): Promise<VaultImportReply> =>
      refuse
        ? { ok: false, code: "vault-import-file-not-found", error: 'ASC .p8 key file not found at "/tmp/AuthKey_XYZ.p8"' }
        : { ok: true, vault: vault({ configured: true }), importedFiles: ["secrets/shared/asc-api-key.p8"], pushed: false, summary: IMPORT_SUMMARY },
    );
    render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    const dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    fireEvent.change(within(dialog).getByLabelText("ASC .p8 key path"), { target: { value: "/tmp/AuthKey_XYZ.p8" } });
    fireEvent.change(within(dialog).getByLabelText("Keystore password"), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review import" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Import vault keys" })).getByRole("button", { name: "Import keys now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (vault-import-file-not-found)");
    expect(alert.textContent).toContain("key file not found");
    // The refusal reverts to the fields step — the typed path survives for another try, the password never.
    const retry = screen.getByRole("dialog", { name: "Import vault keys" });
    expect((within(retry).getByLabelText("ASC .p8 key path") as HTMLInputElement).value).toBe("/tmp/AuthKey_XYZ.p8");
    expect((within(retry).getByLabelText("Keystore password") as HTMLInputElement).value).toBe("");
    expect(domHolds(SECRET), "the refused password cleared from state and DOM").toBe(false);
    // The retry lands once the handler stops refusing.
    refuse = false;
    fireEvent.click(within(retry).getByRole("button", { name: "Review import" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Import vault keys" })).getByRole("button", { name: "Import keys now" }));
    await waitFor(() => expect(vaultImport).toHaveBeenCalledTimes(2));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(IMPORT_SUMMARY);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
