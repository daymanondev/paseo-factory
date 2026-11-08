/**
 * The Settings screen's Danger Zone journeys (T-10e): the scoped Project
 * panel's two destructive Owner acts — "Reset project" and "Delete project"
 * — through their transport slots, behind destructive dialogs that are
 * TYPE-TO-CONFIRM: the primary (danger) button stays disabled until the
 * Owner types the Project slug exactly. The unscoped view (no Project
 * selected) renders NO Danger Zone at all — an unscoped reset/delete is a
 * shape the sidecar's door itself refuses. Cancel (and Close) send nothing
 * at every step; the confirm sends exactly the act's input — reset the
 * scoped root plus `keepSeats` SPELLED (the "Keep live seats" checkbox,
 * default checked), delete the scoped root alone, never a `seat` field.
 * Every reply arm renders verbatim as data: the success banner carries the
 * handler's own `summary` plus the purged/removed/archived counts and fires
 * the shell's refresh (`onChanged`), a delete success also fires
 * `onProjectDeleted` (the console returns to the unscoped Overview), and a
 * refusal carries its code and sentence with the dialog kept for another
 * try.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView, ProjectView } from "../../../plugin/shared/view.ts";
import type { ProjectDangerReply } from "../project.ts";
import { fixtureView } from "../test/fixture-view.ts";
import { SettingsScreen } from "./settings.tsx";

afterEach(() => {
  cleanup();
});

/** The scoped Project the Danger Zone acts on — the fixture's own registered Project. */
const SCOPED: ProjectView = {
  slug: "research-slp",
  root: "/Users/owner/code/research-slp",
  name: "research-slp",
  executionMode: "slp",
};

const scopedView = (): FactoryView => {
  const view = fixtureView();
  view.project = SCOPED;
  return view;
};

/** A Danger Zone success arm's facts — the handler's own counts; the summary names the act. */
const dangerSuccess = (): Omit<Extract<ProjectDangerReply, { ok: true }>, "summary"> => ({
  ok: true,
  project: "research-slp",
  projectRoot: "/Users/owner/code/research-slp",
  purgedEvents: 12,
  tasks: ["T-1"],
  removedFiles: 3,
  archivedSeats: [],
  archivedAgents: ["agent-worker-1"],
});

/** A Danger Zone success arm — the handler's own summary and counts. */
const resetReply = (): ProjectDangerReply => ({
  ...dangerSuccess(),
  summary: "Reset project research-slp and purged 12 event(s), 1 task(s).",
});

describe("the Danger Zone's scope — unscoped renders none", () => {
  it("the unscoped view (No project selected) renders no Danger Zone buttons", () => {
    render(<SettingsScreen view={fixtureView()} />);
    expect(screen.getByText("No project selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
    expect(screen.queryByLabelText("Danger zone")).toBeNull();
  });

  it("the scoped view renders both acts inside the design's own Danger Zone", () => {
    render(<SettingsScreen view={scopedView()} />);
    expect(screen.getByLabelText("Danger zone")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete project" })).toBeTruthy();
  });
});

describe("the reset gate — type-to-confirm, keepSeats spelled", () => {
  it("stays disabled until the slug is typed exactly — Cancel sends nothing", async () => {
    const projectReset = vi.fn(async (): Promise<ProjectDangerReply> => resetReply());
    render(<SettingsScreen view={scopedView()} projectReset={projectReset} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset project" }));
    const dialog = screen.getByRole("dialog", { name: "Reset project now?" });
    // The dialog names the purge honestly and carries the Project's identity.
    expect(within(dialog).getByText(/purges this Project's Factory state/)).toBeTruthy();
    expect(within(dialog).getAllByText("research-slp").length).toBeGreaterThan(0);
    expect((within(dialog).getByLabelText("Keep live seats") as HTMLInputElement).checked).toBe(true);
    // The danger button is the gate: disabled empty, disabled on a partial slug, armed only on the exact slug.
    const arm = within(dialog).getByRole("button", { name: "Reset project now" });
    expect(arm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "research" } });
    expect(arm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "research-slp" } });
    expect(arm.hasAttribute("disabled")).toBe(false);
    // Cancel sends nothing — the gate closes without an RPC.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(projectReset).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the armed confirm sends exactly { projectRoot, keepSeats } — the checkbox spelled both ways", async () => {
    const projectReset = vi.fn(async (): Promise<ProjectDangerReply> => resetReply());
    const onChanged = vi.fn();
    const first = render(<SettingsScreen view={scopedView()} projectReset={projectReset} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset project" }));
    let dialog = screen.getByRole("dialog", { name: "Reset project now?" });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "research-slp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset project now" }));
    await waitFor(() => expect(projectReset).toHaveBeenCalledTimes(1));
    expect(projectReset).toHaveBeenCalledWith({ projectRoot: "/Users/owner/code/research-slp", keepSeats: true });
    // The success banner carries the handler's summary AND its counts, then refreshes.
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Resetting the project");
    expect(status.textContent).toContain("Reset project research-slp and purged 12 event(s), 1 task(s).");
    expect(status.textContent).toContain("purged 12 events, 1 task");
    expect(status.textContent).toContain("removed 3 files");
    expect(status.textContent).toContain("archived 0 seats, 1 agent");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    first.unmount();
    // The unchecked arm spells keepSeats false — the checkbox's promise is the wire's truth.
    render(<SettingsScreen view={scopedView()} projectReset={projectReset} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset project" }));
    dialog = screen.getByRole("dialog", { name: "Reset project now?" });
    fireEvent.click(within(dialog).getByLabelText("Keep live seats"));
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "research-slp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset project now" }));
    await waitFor(() => expect(projectReset).toHaveBeenCalledTimes(2));
    expect(projectReset).toHaveBeenLastCalledWith({ projectRoot: "/Users/owner/code/research-slp", keepSeats: false });
  });

  it("a refusal rides as data and keeps the dialog for another try", async () => {
    const projectReset = vi.fn(async (): Promise<ProjectDangerReply> => ({
      ok: false,
      code: "unknown-project",
      error: "project root /Users/owner/code/research-slp does not resolve to a git repository",
    }));
    render(<SettingsScreen view={scopedView()} projectReset={projectReset} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset project" }));
    const dialog = screen.getByRole("dialog", { name: "Reset project now?" });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "research-slp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset project now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (unknown-project)");
    expect(alert.textContent).toContain("does not resolve");
    const retry = screen.getByRole("dialog", { name: "Reset project now?" });
    expect(within(retry).getByRole("button", { name: "Reset project now" })).toBeTruthy();
    // Cancel after a refusal still sends nothing more.
    fireEvent.click(within(retry).getByRole("button", { name: "Cancel" }));
    expect(projectReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the delete gate — the same law, plus the return to the Overview", () => {
  it("sends exactly { projectRoot } on the exact slug — never a seat field — and fires onProjectDeleted", async () => {
    const projectDelete = vi.fn(async (): Promise<ProjectDangerReply> => ({
      ...dangerSuccess(),
      summary: "Deleted project research-slp and purged all Factory state (12 event(s), 1 task(s)).",
    }));
    const onChanged = vi.fn();
    const onProjectDeleted = vi.fn();
    render(<SettingsScreen view={scopedView()} projectDelete={projectDelete} onChanged={onChanged} onProjectDeleted={onProjectDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    const dialog = screen.getByRole("dialog", { name: "Delete project now?" });
    expect(within(dialog).getByText(/removes the Project from this Factory home/)).toBeTruthy();
    // No keepSeats checkbox exists on the delete act.
    expect(within(dialog).queryByLabelText("Keep live seats")).toBeNull();
    const arm = within(dialog).getByRole("button", { name: "Delete project now" });
    expect(arm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "research-slp" } });
    expect(arm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(arm);
    await waitFor(() => expect(projectDelete).toHaveBeenCalledTimes(1));
    expect(projectDelete).toHaveBeenCalledWith({ projectRoot: "/Users/owner/code/research-slp" });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Deleting the project");
    expect(status.textContent).toContain("Deleted project research-slp");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onProjectDeleted, "the delete success hands the console to the unscoped Overview").toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel sends nothing — the delete act never fires without the exact slug", async () => {
    const projectDelete = vi.fn(async (): Promise<ProjectDangerReply> => resetReply());
    render(<SettingsScreen view={scopedView()} projectDelete={projectDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    const dialog = screen.getByRole("dialog", { name: "Delete project now?" });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "research-slp " } });
    expect(within(dialog).getByRole("button", { name: "Delete project now" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(projectDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
