/**
 * The ⌘K command palette's journeys (T-14c, ADR 0051 §7) — navigation only,
 * rendered through the App shell with fixture transports: the chord (⌘K and
 * Ctrl+K) and the topbar affordance open it anywhere; the filter matches
 * case-insensitively with an honest "No matching commands" row; ↑/↓ move and
 * Enter runs — a screen command changes the route, a scope command rides the
 * ProjectSwitcher's own setter (the switcher's select reflects it and the
 * snapshot re-keys on the new scope), and "Add project…" opens the T-12
 * wizard; Escape closes and restores focus to the opener; a click outside
 * closes. The palette holds no write command (ADR 0017) and issues no RPC of
 * its own; the chord does nothing while the palette is already open and
 * stays inert while another dialog holds the console.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { navigate } from "../router.ts";
import { fixtureView } from "../test/fixture-view.ts";

const fixtureSnapshot = async () => ({ ok: true as const, view: fixtureView() });

/** The chord — the same listener the App pins on `document`. */
const pressCommandK = (chord: "meta" | "ctrl" = "meta") =>
  fireEvent.keyDown(document, chord === "meta" ? { key: "k", metaKey: true } : { key: "k", ctrlKey: true });

const palette = () => screen.getByRole("dialog", { name: "Command palette" });
const paletteInput = () => within(palette()).getByRole("combobox") as HTMLInputElement;
const paletteRows = () => Array.from(palette().querySelectorAll('[role="option"]'));
const rowText = (row: Element) => row.textContent ?? "";
const type = (text: string) => fireEvent.change(paletteInput(), { target: { value: text } });

afterEach(() => {
  cleanup();
  navigate("/");
});

describe("opening and closing", () => {
  it("⌘K and Ctrl+K open the palette anywhere; the topbar affordance carries the shortcut hint", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp"); // the snapshot has landed — the scope commands are live
    // The visible affordance — the design's `.search-trigger` vocabulary.
    const trigger = screen.getByRole("button", { name: /Search commands/ });
    expect(trigger.textContent).toContain("⌘K");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    pressCommandK("meta");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    fireEvent.keyDown(paletteInput(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    pressCommandK("ctrl");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    // The affordance opens the same palette.
    fireEvent.keyDown(paletteInput(), { key: "Escape" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("Escape closes and returns focus to the element that opened it; a click outside closes too", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    const trigger = screen.getByRole("button", { name: /Search commands/ });
    trigger.focus();
    fireEvent.click(trigger);
    // The palette's open law: the filter input holds focus while it is open.
    await waitFor(() => expect(document.activeElement).toBe(paletteInput()));
    fireEvent.keyDown(paletteInput(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // A click on the scrim — the space outside the card — closes as well.
    fireEvent.click(trigger);
    fireEvent.click(palette().parentElement as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("the chord does nothing while the palette is already open — no reset, no second palette", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    pressCommandK();
    type("Inbox");
    expect(paletteInput().value).toBe("Inbox");
    pressCommandK();
    pressCommandK("ctrl");
    // Still the one palette, still the typed filter — the chord never re-opened it.
    expect(screen.getAllByRole("dialog", { name: "Command palette" }).length).toBe(1);
    expect(paletteInput().value).toBe("Inbox");
  });

  it("the chord is inert while another dialog holds the console", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    // The T-12 wizard is the shell's own modal — open it through its topbar entry.
    fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
    pressCommandK();
    pressCommandK("ctrl");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    // Close the wizard — the chord works again.
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add project" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull();
    pressCommandK();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });
});

describe("the three command kinds — screens, scope, the wizard", () => {
  it("holds the eight nav screens, every registered Project plus All projects, and Add project… — nothing else", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    pressCommandK();
    const texts = paletteRows().map(rowText);
    // (a) the eight screens, folded from the nav's own items — the sidebar's labels, all of them.
    for (const label of ["All projects", "Workspace", "Tasks", "Activity", "Agents & Models", "Integrations", "Settings", "Inbox"]) {
      expect(texts.some((text) => text === `${label}Go to`), `a "Go to" row for "${label}"`).toBe(true);
    }
    // (b) the snapshot's two Projects plus the unscoped All projects, through the switcher's vocabulary.
    expect(texts.some((text) => text === "research-slpScope")).toBe(true);
    expect(texts.some((text) => text === "web-console-fixtureScope")).toBe(true);
    expect(texts.filter((text) => text === "All projectsScope").length).toBe(1);
    // (c) the one action — the T-12 wizard.
    expect(texts.some((text) => text === "Add project…Action")).toBe(true);
    expect(texts.length).toBe(12); // 8 + 3 + 1 — no hidden rows
    // ADR 0017: no write command anywhere in the palette.
    const writes = /(start|stop|rotate|revoke|ensure|accept|grant|answer|decide|retro|delete|remove|import|upgrade|hydrate|push|reset|write)\b/i;
    for (const text of texts) expect(text, `row "${text}" is not a write command`).not.toMatch(writes);
  });

  it("issues no RPC of its own — filtering and arrowing never touch the snapshot transport", async () => {
    const loadSnapshot = vi.fn(fixtureSnapshot);
    render(<App loadSnapshot={loadSnapshot} />);
    await screen.findByText("research-slp");
    const before = loadSnapshot.mock.calls.length;
    pressCommandK();
    type("pro");
    fireEvent.keyDown(paletteInput(), { key: "ArrowDown" });
    fireEvent.keyDown(paletteInput(), { key: "ArrowUp" });
    fireEvent.keyDown(paletteInput(), { key: "Escape" });
    expect(loadSnapshot.mock.calls.length).toBe(before);
  });
});

describe("the filter and the keyboard list", () => {
  it("matches case-insensitively and narrows the rows", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    pressCommandK();
    type("INBOX");
    expect(paletteRows().map(rowText)).toEqual(["InboxGo to"]);
    type("research");
    expect(paletteRows().map(rowText)).toEqual(["research-slpScope"]);
  });

  it("shows an honest No matching commands row when nothing matches", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    pressCommandK();
    type("zzz-nothing-matches-this");
    expect(paletteRows().length).toBe(0);
    expect(within(palette()).getByText("No matching commands")).toBeTruthy();
  });

  it("↑/↓ move and Enter runs — the palette closes and the route changes", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    pressCommandK();
    // The first row starts active — the top match is the likely intent.
    expect(paletteRows()[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(paletteInput(), { key: "ArrowDown" });
    const rows = paletteRows();
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
    // ArrowUp clamps at the top; ArrowDown clamps at the bottom — no runaway index.
    fireEvent.keyDown(paletteInput(), { key: "ArrowUp" });
    expect(paletteRows()[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(paletteInput(), { key: "ArrowDown" });
    fireEvent.keyDown(paletteInput(), { key: "Enter" });
    expect(window.location.pathname).toBe("/flow");
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});

describe("project scoping — the switcher's own setter", () => {
  it("a Project row scopes the console: the switcher reflects it and the snapshot re-keys on the new scope", async () => {
    const loadSnapshot = vi.fn(fixtureSnapshot);
    render(<App loadSnapshot={loadSnapshot} />);
    await screen.findByText("research-slp");
    pressCommandK();
    type("research-slp");
    fireEvent.keyDown(paletteInput(), { key: "Enter" });
    const switcher = screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(switcher.value).toBe("/Users/owner/code/research-slp"));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledWith({ projectRoot: "/Users/owner/code/research-slp" }));
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("the All projects row unscopes through the same setter", async () => {
    const loadSnapshot = vi.fn(fixtureSnapshot);
    render(<App loadSnapshot={loadSnapshot} />);
    await screen.findByText("research-slp");
    // Scope first — the palette's own row — then come back through the palette.
    pressCommandK();
    type("research-slp");
    fireEvent.keyDown(paletteInput(), { key: "Enter" });
    const switcher = screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(switcher.value).toBe("/Users/owner/code/research-slp"));
    // The re-keyed snapshot has landed before the palette's next open — its
    // scope rows come from that view.
    await waitFor(() => expect(switcher.querySelectorAll("option").length).toBe(3));
    pressCommandK();
    type("All projects");
    const scopeRow = paletteRows().find((row) => rowText(row) === "All projectsScope");
    expect(scopeRow).toBeTruthy();
    fireEvent.click(scopeRow as HTMLElement); // a click runs a row too
    await waitFor(() => expect(switcher.value).toBe(""));
  });
});

describe("Add project… — the T-12 wizard", () => {
  it("running the row opens the wizard's own dialog", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    pressCommandK();
    type("add");
    expect(paletteRows().map(rowText)).toEqual(["Add project…Action"]);
    fireEvent.keyDown(paletteInput(), { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
  });
});
