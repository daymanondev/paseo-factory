/**
 * The Settings screen's History imports journeys (T-14a): the read-only
 * section beside the vault card, fed by its own transport slot
 * (`factory.history.imports`, a plain door entry). Every arm renders as
 * data — loading while the first read is in flight (Refresh held), the
 * empty "No history imports recorded", a refusal's code and sentence, and
 * the rows themselves: the schema's own status word (a green badge only
 * when applied, red when conflicted), the short id, the target ledger and
 * its Project/node label, the added/duplicates counts the writer counted,
 * the conflict reasons, the diagnostics, and the materialization hold.
 * Refresh is a READ — it re-runs the transport with no confirm — and a
 * successful vault import re-reads the section by folding the reply's own
 * `historyImports` copy (the door is not re-asked for what the reply
 * already answers). No write control exists: no Import/Start/Ensure button
 * anywhere in the section (ADR 0017 + the deferred wave).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView, VaultStatusView } from "../../../plugin/shared/view.ts";
import type { HistoryImportStatus, HistoryImportsReply } from "../history.ts";
import type { VaultImportReply } from "../vault.ts";
import { historyImportsModel } from "../settings-view.ts";
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

/** The configured vault — the import act's own facts (the re-read journey needs the dialog). */
const configuredView = (): FactoryView => {
  const view = fixtureView();
  view.vault = vault({ configured: true, repo: "octocat/factory-vault", branch: "release" });
  return view;
};

/** An applied root import — the writer's own honest counts and diagnostic. */
const APPLIED: HistoryImportStatus = {
  id: "1a2b3c4d5e6f" + "0".repeat(52),
  target: "/tmp/paseo-home/plugin-state/paseo-factory/ledger.jsonl",
  status: "applied",
  added: 12,
  duplicates: 3,
  diagnostics: ["history admitted by the live writer"],
};

/** A conflicted import — the plan's own refusal reasons, counted events kept honest. */
const CONFLICTED: HistoryImportStatus = {
  id: "2b3c4d5e6f70" + "1".repeat(52),
  target: "/tmp/paseo-home/plugin-state/paseo-factory/ledger.jsonl",
  status: "conflicted",
  added: 0,
  duplicates: 7,
  conflicts: [{ reason: "duplicate event ids", sourceId: "node-b" }],
  diagnostics: ["import refused: 1 conflict(s)"],
};

/** A staged per-Project import held on its vault materialization — the writer has not admitted it yet. */
const STAGED: HistoryImportStatus = {
  id: "3c4d5e6f7081" + "2".repeat(52),
  target: "/tmp/paseo-home/plugin-state/paseo-factory/projects/patigame/ledger.jsonl",
  status: "staged",
  diagnostics: ["snapshot fetched and staged; Ledger owner admission pending"],
  materialization: { status: "pending", diagnostics: ["vault materialization waits on the writer"] },
};

describe("the History imports fold (pure)", () => {
  it("carries every row verbatim — the status word, the target's Project/node label, and honest nulls", () => {
    const model = historyImportsModel([APPLIED, STAGED]);
    expect(model.rows).toHaveLength(2);
    const [applied, staged] = model.rows;
    expect(applied!.id).toBe(APPLIED.id);
    expect(applied!.shortId).toBe("1a2b3c4d5e6f");
    expect(applied!.targetLabel).toBe("root Factory");
    expect(applied!.statusLabel).toBe("applied");
    expect(applied!.added).toBe(12);
    expect(applied!.duplicates).toBe(3);
    expect(applied!.conflicts).toEqual([]);
    expect(applied!.materialization).toBeNull();
    expect(staged!.targetLabel).toBe("patigame");
    expect(staged!.materialization).toEqual({ status: "pending", diagnostics: ["vault materialization waits on the writer"] });
    // Absent optionals fold to their honest nulls — never invented counts.
    const bare = historyImportsModel([{ id: "4d5e6f708192" + "3".repeat(52), target: "/tmp/x/ledger.jsonl", status: "pending", diagnostics: [] }]);
    expect(bare.rows[0]!.added).toBeNull();
    expect(bare.rows[0]!.duplicates).toBeNull();
    expect(bare.rows[0]!.conflicts).toEqual([]);
  });

  it("folds the empty list to the empty list — the section's own empty word owns that state", () => {
    expect(historyImportsModel([]).rows).toEqual([]);
  });
});

describe("the History imports section — the states", () => {
  it("loads on mount — the honest loading word while the first read is in flight, Refresh held", async () => {
    const historyImports = vi.fn(() => new Promise<HistoryImportsReply>(() => {}));
    render(<SettingsScreen view={fixtureView()} historyImports={historyImports} />);
    expect(screen.getByText("Loading history imports…")).toBeTruthy();
    expect(historyImports).toHaveBeenCalledTimes(1);
    expect(historyImports).toHaveBeenCalledWith({});
    expect(screen.getByRole("button", { name: "Refresh history imports" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the rows — the schema's own status words, the short ids, the targets, counts, conflicts, diagnostics, and the hold", async () => {
    const historyImports = vi.fn(async (): Promise<HistoryImportsReply> => ({ ok: true, imports: [APPLIED, CONFLICTED, STAGED] }));
    render(<SettingsScreen view={fixtureView()} historyImports={historyImports} />);
    const card = await screen.findByLabelText("History imports");
    expect(within(card).getByText("3 imports recorded", { selector: "h2" })).toBeTruthy();
    // Every status renders as the schema's own word — applied twice, conflicted once, staged once.
    for (const word of ["applied", "conflicted", "staged"]) {
      expect(within(card).getAllByText(word).length).toBeGreaterThan(0);
    }
    expect(within(card).getByText("1a2b3c4d5e6f")).toBeTruthy();
    expect(within(card).getByText("2b3c4d5e6f70")).toBeTruthy();
    // The target ledgers verbatim, and their Project/node labels.
    expect(within(card).getAllByText("/tmp/paseo-home/plugin-state/paseo-factory/ledger.jsonl")).toHaveLength(2);
    expect(within(card).getByText("/tmp/paseo-home/plugin-state/paseo-factory/projects/patigame/ledger.jsonl")).toBeTruthy();
    expect(within(card).getAllByText("root Factory")).toHaveLength(2);
    expect(within(card).getByText("patigame")).toBeTruthy();
    // The counts, the conflict sentence, the diagnostics, and the materialization hold — all verbatim.
    expect(within(card).getByText("Conflict: duplicate event ids (source node-b)")).toBeTruthy();
    expect(within(card).getByText("history admitted by the live writer")).toBeTruthy();
    expect(within(card).getByText("snapshot fetched and staged; Ledger owner admission pending")).toBeTruthy();
    expect(within(card).getByText("Materialization: vault materialization waits on the writer")).toBeTruthy();
    expect(within(card).getByText("12")).toBeTruthy();
    expect(within(card).getByText("7")).toBeTruthy();
  });

  it("renders the honest empty — no imports recorded", async () => {
    const historyImports = vi.fn(async (): Promise<HistoryImportsReply> => ({ ok: true, imports: [] }));
    render(<SettingsScreen view={fixtureView()} historyImports={historyImports} />);
    const card = await screen.findByLabelText("History imports");
    expect(within(card).getByText("No history imports recorded")).toBeTruthy();
    expect(within(card).getByText("0 imports recorded", { selector: "h2" })).toBeTruthy();
  });

  it("renders a refusal as data — the code and sentence, with Refresh still offered", async () => {
    const historyImports = vi.fn(async (): Promise<HistoryImportsReply> => ({ ok: false, code: "unreachable", error: "fetch failed" }));
    render(<SettingsScreen view={fixtureView()} historyImports={historyImports} />);
    const card = await screen.findByLabelText("History imports");
    expect(within(card).getByText("The history imports read refused (unreachable): fetch failed")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Refresh history imports" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("the History imports section — refresh and the re-read", () => {
  it("Refresh re-reads — a read needs no confirm, and the new rows land", async () => {
    let calls = 0;
    const historyImports = vi.fn(async (): Promise<HistoryImportsReply> => {
      calls += 1;
      return calls === 1 ? { ok: true, imports: [] } : { ok: true, imports: [APPLIED] };
    });
    render(<SettingsScreen view={fixtureView()} historyImports={historyImports} />);
    const card = await screen.findByLabelText("History imports");
    expect(within(card).getByText("No history imports recorded")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Refresh history imports" }));
    expect(await within(card).findByText("1a2b3c4d5e6f")).toBeTruthy();
    expect(historyImports).toHaveBeenCalledTimes(2);
  });

  it("a successful vault import re-reads the section from the reply's own historyImports — the door is not re-asked", async () => {
    const historyImports = vi.fn(async (): Promise<HistoryImportsReply> => ({ ok: true, imports: [] }));
    const vaultImport = vi.fn(async (): Promise<VaultImportReply> => ({
      ok: true,
      vault: vault({ configured: true }),
      importedFiles: ["secrets/shared/asc-api-key.p8"],
      pushed: false,
      summary: "Imported 1 secret file(s).",
      historyImports: [STAGED],
    }));
    render(<SettingsScreen view={configuredView()} vaultImport={vaultImport} historyImports={historyImports} />);
    const card = await screen.findByLabelText("History imports");
    expect(within(card).getByText("No history imports recorded")).toBeTruthy();
    // Drive the real import dialog — one filled path, the default arm.
    fireEvent.click(screen.getByRole("button", { name: "Import vault keys" }));
    const dialog = screen.getByRole("dialog", { name: "Import vault keys" });
    fireEvent.change(within(dialog).getByLabelText("ASC .p8 key path"), { target: { value: "/tmp/AuthKey_XYZ.p8" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review import" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Import vault keys" })).getByRole("button", { name: "Import keys now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The section folded the reply's own copy — the staged row lands without a second door read.
    expect(await within(card).findByText("3c4d5e6f7081")).toBeTruthy();
    expect(within(card).getByText("1 import recorded", { selector: "h2" })).toBeTruthy();
    expect(within(card).getByText("patigame")).toBeTruthy();
    expect(historyImports, "the reply WAS the re-read").toHaveBeenCalledTimes(1);
  });

  it("carries no write control — Refresh is the section's only button, no Import/Start/Ensure anywhere", async () => {
    const historyImports = vi.fn(async (): Promise<HistoryImportsReply> => ({ ok: true, imports: [APPLIED] }));
    render(<SettingsScreen view={configuredView()} historyImports={historyImports} />);
    const card = await screen.findByLabelText("History imports");
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Refresh history imports"]);
    for (const word of ["Import history", "Start history", "Ensure", "Upgrade"]) {
      expect(screen.queryByRole("button", { name: new RegExp(word, "i") }), word).toBeNull();
    }
  });
});
