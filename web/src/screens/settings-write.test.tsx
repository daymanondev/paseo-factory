/**
 * The Settings screen's write journeys (T-10b): the Owner's three vault acts
 * through their transport slots — the stepped setup dialog
 * (`factory.vault.configure`: repo prefilled from suggestedRepo, branch, and
 * the optional passphrase whose "Leave unchanged" choice OMITS the field so
 * the persisted value survives) and the Pull / Push confirms
 * (`factory.vault.pull` / `factory.vault.push`, each naming the act with its
 * mergeLedgers / includeLedgers checkbox, default off). Cancel sends nothing
 * at every step; the confirm sends exactly the act's input — `{}` or the one
 * boolean, never a developer field. Every reply arm renders verbatim as
 * data: the success banner carries the handler's own `summary` and fires the
 * shell's refresh (`onChanged`), a refusal carries its code and sentence with
 * the dialog kept for another try. The passphrase law is asserted hard: an
 * `<input type="password">` while editing, never echoed back into the DOM
 * after submit (no element's value, no text node), never in
 * localStorage/sessionStorage, never in the URL, and cleared from state on
 * every close — success, refusal, or cancel.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView, VaultStatusView } from "../../../plugin/shared/view.ts";
import type { VaultConfigureInput, VaultConfigureReply, VaultPullReply, VaultPushReply } from "../vault.ts";
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

/** The unconfigured home with a suggested repo — the setup dialog's own prefill facts. */
const suggestedView = (): FactoryView => {
  const view = fixtureView();
  view.vault = vault({ ghInstalled: true, ghAuthenticated: true, ghUser: "octocat", suggestedRepo: "octocat/factory-vault" });
  return view;
};

/** The configured vault — Pull and Push's own facts. */
const configuredView = (): FactoryView => {
  const view = fixtureView();
  view.vault = vault({ configured: true, repo: "octocat/factory-vault", branch: "release", hasPassphrase: true, cloneExists: true });
  return view;
};

/** The whole DOM's text and every input's value — the passphrase can hide in neither. */
const domHolds = (needle: string): boolean => {
  if ((document.body.textContent ?? "").includes(needle)) return true;
  return Array.from(document.querySelectorAll("input")).some((input) => input.value === needle);
};

describe("the configure gate — the stepped setup dialog", () => {
  it("prefills the connect step from suggestedRepo and the fold's branch — Cancel sends nothing", async () => {
    const vaultConfigure = vi.fn(async (): Promise<VaultConfigureReply> => ({ ok: true, vault: vault(), summary: "saved" }));
    render(<SettingsScreen view={suggestedView()} vaultConfigure={vaultConfigure} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure vault" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Private Vault" });
    expect((within(dialog).getByLabelText("Private repository") as HTMLInputElement).value).toBe("octocat/factory-vault");
    expect((within(dialog).getByLabelText("Branch") as HTMLInputElement).value).toBe("main");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(vaultConfigure).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Continue reaches the passphrase step — Leave unchanged (the default) sends NO passphrase field", async () => {
    const vaultConfigure = vi.fn(async (input: VaultConfigureInput): Promise<VaultConfigureReply> => ({
      ok: true,
      vault: vault({ configured: true, repo: input.repo }),
      summary: `Saved vault config for ${input.repo} (branch main).`,
    }));
    const onChanged = vi.fn();
    render(<SettingsScreen view={suggestedView()} vaultConfigure={vaultConfigure} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure vault" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Private Vault" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    // The default choice is Leave unchanged — no password input exists yet.
    expect((within(dialog).getByLabelText(/^(Leave unchanged)/) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryByLabelText("Vault passphrase")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(vaultConfigure).toHaveBeenCalledTimes(1));
    expect(vaultConfigure).toHaveBeenCalledWith({ repo: "octocat/factory-vault", branch: "main" });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Configuring the vault");
    expect(status.textContent).toContain("Saved vault config for octocat/factory-vault");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Set a passphrase reveals the password input — the text never echoes back after the submit", async () => {
    const SECRET = "correct-horse-battery-staple";
    const vaultConfigure = vi.fn(async (input: VaultConfigureInput): Promise<VaultConfigureReply> => ({
      ok: true,
      vault: vault({ configured: true, repo: input.repo, hasPassphrase: input.passphrase !== undefined }),
      summary: "Saved vault config",
    }));
    render(<SettingsScreen view={suggestedView()} vaultConfigure={vaultConfigure} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure vault" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Private Vault" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.click(within(dialog).getByLabelText("Set a passphrase"));
    const input = within(dialog).getByLabelText("Vault passphrase") as HTMLInputElement;
    expect(input.type).toBe("password");
    // Save disabled until the passphrase is nonempty — an honest gate, not a silent omit.
    expect(within(dialog).getByRole("button", { name: "Save configuration" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: SECRET } });
    expect(within(dialog).getByRole("button", { name: "Save configuration" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(vaultConfigure).toHaveBeenCalledTimes(1));
    expect(vaultConfigure).toHaveBeenCalledWith({ repo: "octocat/factory-vault", branch: "main", passphrase: SECRET });
    // After the submit: no text node, no input value, no storage, no URL — the passphrase is gone.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(domHolds(SECRET), "the passphrase never echoes back into the DOM").toBe(false);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("a refusal renders verbatim, keeps the dialog for another try, and clears the typed passphrase", async () => {
    const SECRET = "never-lands-anywhere";
    const vaultConfigure = vi.fn(async (): Promise<VaultConfigureReply> => ({
      ok: false,
      code: "vault-invalid-repo",
      error: "the vault repo cannot be blank — pass the GitHub owner/repo slug (or a local git path for tests)",
    }));
    render(<SettingsScreen view={suggestedView()} vaultConfigure={vaultConfigure} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure vault" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Private Vault" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.click(within(dialog).getByLabelText("Set a passphrase"));
    fireEvent.change(within(dialog).getByLabelText("Vault passphrase"), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (vault-invalid-repo)");
    expect(alert.textContent).toContain("pass the GitHub owner/repo slug");
    // The dialog reverted to its passphrase step — the act can be retried or cancelled.
    const retry = screen.getByRole("dialog", { name: "Configure Private Vault" });
    expect(within(retry).getByRole("button", { name: "Save configuration" })).toBeTruthy();
    // The typed text cleared with the submit — the choice reset to Leave unchanged.
    expect((within(retry).getByLabelText(/^(Leave unchanged)/) as HTMLInputElement).checked).toBe(true);
    expect(within(retry).queryByLabelText("Vault passphrase")).toBeNull();
    expect(domHolds(SECRET), "the refused passphrase cleared from state and DOM").toBe(false);
    // Cancel after a refusal still sends nothing more.
    fireEvent.click(within(retry).getByRole("button", { name: "Cancel" }));
    expect(vaultConfigure).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel at the passphrase step sends nothing — and Back returns to the connect step", async () => {
    const vaultConfigure = vi.fn(async (): Promise<VaultConfigureReply> => ({ ok: true, vault: vault(), summary: "saved" }));
    render(<SettingsScreen view={suggestedView()} vaultConfigure={vaultConfigure} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure vault" }));
    let dialog = screen.getByRole("dialog", { name: "Configure Private Vault" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    dialog = screen.getByRole("dialog", { name: "Configure Private Vault" });
    expect(within(dialog).getByLabelText("Private repository")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(vaultConfigure).not.toHaveBeenCalled();
  });
});

describe("the pull and push gates — each confirm names the act", () => {
  it("Pull confirms with the checkbox default off — Cancel sends nothing, confirm sends {}", async () => {
    const vaultPull = vi.fn(async (): Promise<VaultPullReply> => ({ ok: true, vault: vault({ configured: true }), hydratedFiles: [], summary: "Pulled and hydrated 0 file(s) from octocat/factory-vault" }));
    render(<SettingsScreen view={configuredView()} vaultPull={vaultPull} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull vault" }));
    const dialog = screen.getByRole("dialog", { name: "Pull vault now?" });
    // The confirm names the act and carries the configured facts.
    expect(within(dialog).getByText(/pulls octocat\/factory-vault and hydrates/)).toBeTruthy();
    expect(within(dialog).getAllByText("release").length).toBeGreaterThan(0);
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(vaultPull).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the unchecked confirm sends {} — checked sends exactly mergeLedgers", async () => {
    const vaultPull = vi.fn(async (): Promise<VaultPullReply> => ({ ok: true, vault: vault({ configured: true }), hydratedFiles: [], summary: "Pulled and hydrated 0 file(s)" }));
    const onChanged = vi.fn();
    const first = render(<SettingsScreen view={configuredView()} vaultPull={vaultPull} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull vault" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Pull vault now?" })).getByRole("button", { name: "Pull vault now" }));
    await waitFor(() => expect(vaultPull).toHaveBeenCalledTimes(1));
    expect(vaultPull).toHaveBeenCalledWith({});
    expect((await screen.findByRole("status")).textContent).toContain("Pulled and hydrated 0 file(s)");
    expect(onChanged).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = render(<SettingsScreen view={configuredView()} vaultPull={vaultPull} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull vault" }));
    const dialog = screen.getByRole("dialog", { name: "Pull vault now?" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Pull vault now" }));
    await waitFor(() => expect(vaultPull).toHaveBeenCalledTimes(2));
    expect(vaultPull).toHaveBeenLastCalledWith({ mergeLedgers: true });
    second.unmount();
  });

  it("Push confirms the same law — {} unchecked, includeLedgers when checked", async () => {
    const vaultPush = vi.fn(async (): Promise<VaultPushReply> => ({ ok: true, vault: vault({ configured: true }), pushedFiles: [], summary: "Vault octocat/factory-vault is already up to date (0 file(s) tracked)." }));
    const onChanged = vi.fn();
    render(<SettingsScreen view={configuredView()} vaultPush={vaultPush} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Push vault" }));
    const dialog = screen.getByRole("dialog", { name: "Push vault now?" });
    expect(within(dialog).getByText(/pushes a commit to octocat\/factory-vault/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Push vault now" }));
    await waitFor(() => expect(vaultPush).toHaveBeenCalledTimes(1));
    expect(vaultPush).toHaveBeenCalledWith({ includeLedgers: true });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Pushing the vault");
    expect(status.textContent).toContain("already up to date");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a pull refusal rides as data and keeps the confirm for another try", async () => {
    const vaultPull = vi.fn(async (): Promise<VaultPullReply> => ({
      ok: false,
      code: "vault-not-configured",
      error: "Private vault is not configured yet — click Enable & Sync Vault or save a repository in Vault settings",
    }));
    render(<SettingsScreen view={configuredView()} vaultPull={vaultPull} />);
    fireEvent.click(screen.getByRole("button", { name: "Pull vault" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Pull vault now?" })).getByRole("button", { name: "Pull vault now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (vault-not-configured)");
    expect(alert.textContent).toContain("save a repository in Vault settings");
    const dialog = screen.getByRole("dialog", { name: "Pull vault now?" });
    expect(within(dialog).getByRole("button", { name: "Pull vault now" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(vaultPull).toHaveBeenCalledTimes(1);
  });

  it("disables every act while a write is in flight", async () => {
    let release: (() => void) | undefined;
    const vaultConfigure = vi.fn(
      () =>
        new Promise<VaultConfigureReply>((resolve) => {
          release = () => resolve({ ok: true, vault: vault(), summary: "Saved vault config" });
        }),
    );
    render(<SettingsScreen view={configuredView()} vaultConfigure={vaultConfigure} />);
    const pull = screen.getByRole("button", { name: "Pull vault" });
    fireEvent.click(screen.getByRole("button", { name: "Configure vault" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Private Vault" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(vaultConfigure).toHaveBeenCalledTimes(1));
    expect(pull.hasAttribute("disabled"), "pull disabled while the configure is in flight").toBe(true);
    release!();
    await waitFor(() => expect(pull.hasAttribute("disabled")).toBe(false));
  });
});
