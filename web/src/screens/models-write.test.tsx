/**
 * The Agents & Models screen's write journeys (T-08b): the three lane acts
 * through their transport slots — the per-row Configure dialog
 * (`factory.lanes.set` with the row's lane and the selected Project's root),
 * the destructive Reset confirm (`factory.lanes.reset`), and the Apply chips
 * (`factory.profiles.apply`). A lane with a LIVE bound seat (the T-08a fold)
 * confirms FIRST — the step says the live seat's model will change, and its
 * Cancel sends nothing (nor does the form's). The Apply chips confirm the
 * same way: the fold carries no profile lane table, so the screen cannot
 * tell which lanes an apply changes — whenever ANY lane holds a live bound
 * seat the apply asks first (naming them), and only a vacant roster applies
 * immediately. Every reply arm renders
 * verbatim as data: the success banner carries the handler's own `modelSync`
 * sentence (and the reset's removed fact), a refusal carries its code and
 * sentence with the form kept for another try. Success fires the shell's
 * refresh (`onChanged`). The journeys stay disabled while a write is in
 * flight.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import type { LanesResetReply, LanesSetReply, ProfilesApplyReply } from "../lanes.ts";
import { fixtureAgent, fixtureView } from "../test/fixture-view.ts";
import { ModelsScreen } from "./models.tsx";

afterEach(() => {
  cleanup();
});

/** The scoped SLP Project — a LIVE supervisor seat, a Lead override, one active profile, a lane override to reset. */
const seatedView = (): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[0]!, executionMode: "slp" };
  view.lanes = { ...view.lanes, lead: "codex/gpt-5.4:high" };
  view.hasProjectLaneOverride = true;
  view.supervisor = fixtureAgent("agent-sup-1", { seat: "supervisor", status: "running", title: "Supervisor" });
  view.agents = [view.supervisor];
  view.profiles = [
    { id: "balanced", name: "Balanced", description: null, lanes: { ...view.machineLanes }, updatedAt: "2026-11-01T10:00:00.000Z" },
    { id: "fast", name: "Fast Watch", description: null, lanes: { ...view.machineLanes, watch: "pi/zai/glm-5.3-air" }, updatedAt: "2026-11-02T10:00:00.000Z" },
  ];
  view.activeProfileId = "balanced";
  view.activeProfileModified = false;
  return view;
};

const MACHINE = "pi/zai/glm-5.3";
const ROOT = "/Users/owner/code/research-slp";

/** The same scoped Project with every seat gone — no live bound seat anywhere, so an apply needs no confirm. */
const vacantView = (): FactoryView => {
  const view = seatedView();
  view.supervisor = null;
  view.agents = [];
  return view;
};

/** A green `factory.lanes.set` reply — the handler's own sentence, verbatim. */
const setOk = (modelSync = `applied — agent agent-su now runs ${MACHINE}`): LanesSetReply => ({
  ok: true,
  lanes: { supervisor: MACHINE, lead: MACHINE, worker: MACHINE, watch: MACHINE, retro: MACHINE, freshEyes: MACHINE },
  modelSync,
});

describe("the Configure journey (factory.lanes.set)", () => {
  it("saves a vacant lane directly — the exact lane, value, and Project root", async () => {
    const lanesSet = vi.fn(async (): Promise<LanesSetReply> => setOk("skipped — not a seat lane (applies to the next create)"));
    const onChanged = vi.fn();
    render(<ModelsScreen view={seatedView()} lanesSet={lanesSet} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure Watch lane" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Watch lane" });
    fireEvent.change(within(dialog).getByLabelText("Provider"), { target: { value: "pi" } });
    fireEvent.change(within(dialog).getByLabelText("Model ID"), { target: { value: "zai/glm-5.3-air" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lane" }));
    await waitFor(() => expect(lanesSet).toHaveBeenCalledTimes(1));
    expect(lanesSet).toHaveBeenCalledWith({ lane: "watch", value: "pi/zai/glm-5.3-air", projectRoot: ROOT });
    // The success arm renders the handler's own sentence verbatim; the shell refreshes.
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/skipped — not a seat lane \(applies to the next create\)/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("builds the provider/model[:thinking] value — the thinking select rides along", async () => {
    const lanesSet = vi.fn(async (): Promise<LanesSetReply> => setOk());
    render(<ModelsScreen view={seatedView()} lanesSet={lanesSet} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure Retro lane" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Retro lane" });
    fireEvent.change(within(dialog).getByLabelText("Model ID"), { target: { value: "glm-5.3-air" } });
    fireEvent.change(within(dialog).getByLabelText("Thinking level"), { target: { value: "high" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lane" }));
    await waitFor(() => expect(lanesSet).toHaveBeenCalledTimes(1));
    expect(lanesSet).toHaveBeenCalledWith({ lane: "retro", value: "pi/glm-5.3-air:high", projectRoot: ROOT });
  });

  it("confirms a LIVE seated lane first — Cancel sends nothing, Confirm & Apply saves", async () => {
    const lanesSet = vi.fn(async (): Promise<LanesSetReply> => setOk());
    render(<ModelsScreen view={seatedView()} lanesSet={lanesSet} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure Supervisor lane" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Supervisor lane" });
    fireEvent.change(within(dialog).getByLabelText("Model ID"), { target: { value: "zai/glm-5.3-air" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lane" }));
    // The confirm step: the live seat is named, the model change is spelled.
    const confirm = screen.getByRole("dialog", { name: "Configure Supervisor lane" });
    expect(within(confirm).getByText(/The live seat's model will change/)).toBeTruthy();
    expect(within(confirm).getByText(/agent-sup-1 · Live/)).toBeTruthy();
    expect(within(confirm).getByText(/pi\/zai\/glm-5.3 → pi\/zai\/glm-5.3-air/)).toBeTruthy();
    // Cancel returns to the form — nothing was sent.
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(lanesSet).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog", { name: "Configure Supervisor lane" })).getByRole("button", { name: "Save lane" })).toBeTruthy();
    // Save again → confirm → Confirm & Apply sends exactly once, with the seat lane.
    fireEvent.click(within(screen.getByRole("dialog", { name: "Configure Supervisor lane" })).getByRole("button", { name: "Save lane" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Configure Supervisor lane" })).getByRole("button", { name: "Confirm & Apply" }));
    await waitFor(() => expect(lanesSet).toHaveBeenCalledTimes(1));
    expect(lanesSet).toHaveBeenCalledWith({ lane: "supervisor", value: "pi/zai/glm-5.3-air", projectRoot: ROOT });
  });

  it("renders a refusal verbatim and keeps the form for another try", async () => {
    const lanesSet = vi.fn(async (): Promise<LanesSetReply> => ({ ok: false, code: "invalid-lane", error: "lane value refused — unknown provider family" }));
    render(<ModelsScreen view={seatedView()} lanesSet={lanesSet} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure Watch lane" }));
    const dialog = screen.getByRole("dialog", { name: "Configure Watch lane" });
    fireEvent.change(within(dialog).getByLabelText("Model ID"), { target: { value: "glm-5.3-air" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lane" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (invalid-lane)");
    expect(alert.textContent).toContain("lane value refused — unknown provider family");
    expect(within(screen.getByRole("dialog", { name: "Configure Watch lane" })).getByRole("button", { name: "Save lane" })).toBeTruthy();
  });
});

describe("the profile chips (factory.profiles.apply)", () => {
  it("apply immediately while no lane holds a live bound seat — the exact profileId and root", async () => {
    const profilesApply = vi.fn(async (): Promise<ProfilesApplyReply> => setOk("applied — profile copied"));
    const onChanged = vi.fn();
    render(<ModelsScreen view={vacantView()} profilesApply={profilesApply} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply profile Fast Watch" }));
    // A vacant roster applies NOW — no confirm dialog ever opens.
    await waitFor(() => expect(profilesApply).toHaveBeenCalledTimes(1));
    expect(profilesApply).toHaveBeenCalledWith({ profileId: "fast", projectRoot: ROOT });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/applied — profile copied/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirm FIRST while a lane holds a live bound seat — the seat is named, Cancel sends nothing", async () => {
    const profilesApply = vi.fn(async (): Promise<ProfilesApplyReply> => setOk("applied — profile copied"));
    render(<ModelsScreen view={seatedView()} profilesApply={profilesApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply profile Fast Watch" }));
    // The confirm step: the live seat is named, the model change is spelled.
    const dialog = screen.getByRole("dialog", { name: "Apply profile Fast Watch?" });
    expect(within(dialog).getByText(/model will change/)).toBeTruthy();
    expect(within(dialog).getByText(/agent-sup-1 · Live/)).toBeTruthy();
    // Cancel closes — nothing was sent.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(profilesApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Confirm & Apply sends exactly the profileId and Project root — success refreshes", async () => {
    const profilesApply = vi.fn(async (): Promise<ProfilesApplyReply> => setOk("applied — profile copied"));
    const onChanged = vi.fn();
    render(<ModelsScreen view={seatedView()} profilesApply={profilesApply} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply profile Fast Watch" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Apply profile Fast Watch?" })).getByRole("button", { name: "Confirm & Apply" }));
    await waitFor(() => expect(profilesApply).toHaveBeenCalledTimes(1));
    expect(profilesApply).toHaveBeenCalledWith({ profileId: "fast", projectRoot: ROOT });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/applied — profile copied/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("render the apply refusal verbatim too", async () => {
    const profilesApply = vi.fn(async (): Promise<ProfilesApplyReply> => ({ ok: false, code: "unknown-profile", error: "No Lane profile fast exists." }));
    render(<ModelsScreen view={seatedView()} profilesApply={profilesApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply profile Fast Watch" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Apply profile Fast Watch?" })).getByRole("button", { name: "Confirm & Apply" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (unknown-profile)");
    expect(alert.textContent).toContain("No Lane profile fast exists.");
  });
});

describe("the reset journey (factory.lanes.reset)", () => {
  it("confirms before resetting — Cancel sends nothing, Reset lanes carries the Project root", async () => {
    const lanesReset = vi.fn(async (): Promise<LanesResetReply> => ({
      ok: true,
      lanes: { supervisor: MACHINE, lead: MACHINE, worker: MACHINE, watch: MACHINE, retro: MACHINE, freshEyes: MACHINE },
      removed: true,
      modelSync: "skipped — no live supervisor or lead lane changed",
    }));
    const onChanged = vi.fn();
    render(<ModelsScreen view={seatedView()} lanesReset={lanesReset} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to Machine Default" }));
    const dialog = screen.getByRole("dialog", { name: "Reset lane configuration?" });
    expect(within(dialog).getByText(/the Project's own lane override is removed/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(lanesReset).not.toHaveBeenCalled();
    // Reopen and go through: the destructive confirm resolves and renders the removed fact + modelSync verbatim.
    fireEvent.click(screen.getByRole("button", { name: "Reset to Machine Default" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Reset lane configuration?" })).getByRole("button", { name: "Reset lanes" }));
    await waitFor(() => expect(lanesReset).toHaveBeenCalledTimes(1));
    expect(lanesReset).toHaveBeenCalledWith({ projectRoot: ROOT });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("removed the Project override");
    expect(status.textContent).toContain("skipped — no live supervisor or lead lane changed");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
