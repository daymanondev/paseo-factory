/**
 * The Add-Project wizard's journeys (T-12): the stepped dialog (folder →
 * review → added) through its transport slots — the typed-path door
 * (`factory.project.add`) and the native-picker door
 * (`factory.project.pick.folder`, Browse…). A cancelled pick returns to the
 * folder step with NO error; a picked one registers through the picker
 * alone (never a redundant add) and jumps straight to Added. Cancel sends
 * nothing at every pre-add step; Add sends exactly `{ path }`; every reply
 * arm renders verbatim as data — a success lands on Added with the
 * handler's own summary/slug/bootstrapped facts and scopes the console
 * through `onAdded(projectRoot)`, a refusal carries its code and sentence
 * inline with the wizard kept for another try. The shell's two entry
 * points (the topbar beside the switcher, the Overview's empty state)
 * open the same wizard. No Start/Ensure control anywhere (ADR 0017).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddProjectDialog } from "./add-project.tsx";
import { App } from "../App.tsx";
import { navigate } from "../router.ts";
import type { ProjectAddReply, ProjectAddSuccess, ProjectPickReply } from "../project.ts";
import { fixtureView } from "../test/fixture-view.ts";

afterEach(() => {
  cleanup();
  navigate("/");
});

/** The add success arm the handler answers — the wizard's own fixture Project. */
const addSuccess = (over: Partial<ProjectAddSuccess> = {}): ProjectAddSuccess => ({
  path: "/Users/owner/code/greenfield-app",
  projectRoot: "/Users/owner/code/greenfield-app",
  slug: "greenfield-app",
  project: {
    slug: "greenfield-app",
    root: "/Users/owner/code/greenfield-app",
    name: "greenfield-app",
    supervisorId: null,
    leadId: null,
    activeTaskCount: 0,
  },
  bootstrapped: false,
  summary: "Added project greenfield-app (greenfield-app).",
  ...over,
});

describe("the wizard's steps — folder, review, added", () => {
  it("Continue stays disabled until a path is typed; the review states honestly what Add does and Back returns", () => {
    render(<AddProjectDialog onAdded={() => {}} close={() => {}} />);
    let dialog = screen.getByRole("dialog", { name: "Add project" });
    expect(within(dialog).getByText("Choose a project folder")).toBeTruthy();
    const input = within(dialog).getByLabelText("Project folder path");
    const next = within(dialog).getByRole("button", { name: "Continue" });
    expect(next.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "  " } });
    expect(within(screen.getByRole("dialog", { name: "Add project" })).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "/Users/owner/code/greenfield-app" } });
    expect(within(screen.getByRole("dialog", { name: "Add project" })).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    dialog = screen.getByRole("dialog", { name: "Add project" });
    // The review names the path and the honest outcome — register (or
    // bootstrap) and NOTHING starts.
    expect(within(dialog).getByText(/registers this git repository as a Factory Project/i)).toBeTruthy();
    expect(within(dialog).getByText(/bootstrapped/i)).toBeTruthy();
    expect(within(dialog).getByText(/No seat starts here/i)).toBeTruthy();
    expect(within(dialog).getAllByText(/greenfield-app/).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(screen.getByRole("dialog", { name: "Add project" })).getByLabelText("Project folder path")).toBeTruthy();
  });

  it("Cancel sends nothing — at the folder step and at the review step", () => {
    const add = vi.fn(async (): Promise<ProjectAddReply> => ({ ok: true, ...addSuccess() }));
    const pick = vi.fn(async (): Promise<ProjectPickReply> => ({ ok: true, cancelled: true, path: null }));
    const closeFn = vi.fn();
    const first = render(<AddProjectDialog add={add} pick={pick} onAdded={() => {}} close={closeFn} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(add).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
    expect(closeFn).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = render(<AddProjectDialog add={add} pick={pick} onAdded={() => {}} close={closeFn} />);
    fireEvent.change(screen.getByLabelText("Project folder path"), { target: { value: "/Users/owner/code/greenfield-app" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(add).not.toHaveBeenCalled();
    expect(closeFn).toHaveBeenCalledTimes(2);
    second.unmount();
  });
});

describe("the typed-path door — factory.project.add", () => {
  it("Add sends exactly { path } — success lands on Added with the handler's facts and scopes via onAdded", async () => {
    const add = vi.fn(async (): Promise<ProjectAddReply> => ({ ok: true, ...addSuccess() }));
    const onAdded = vi.fn();
    const closeFn = vi.fn();
    render(<AddProjectDialog add={add} onAdded={onAdded} close={closeFn} />);
    fireEvent.change(screen.getByLabelText("Project folder path"), { target: { value: "/Users/owner/code/greenfield-app" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith({ path: "/Users/owner/code/greenfield-app" }));
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onAdded).toHaveBeenCalledWith("/Users/owner/code/greenfield-app");
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Added project greenfield-app (greenfield-app).");
    const dialog = screen.getByRole("dialog", { name: "Add project" });
    expect(within(dialog).getByText("Existing repository registered as-is")).toBeTruthy();
    // Done closes the wizard — the scoped Overview is already behind it
    // (unmounting is the parent's act on close; the call is the proof here).
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("a refusal rides as data and keeps the wizard for another try", async () => {
    const add = vi.fn(async (): Promise<ProjectAddReply> => ({
      ok: false,
      code: "missing-directory",
      error: "directory /Users/owner/code/nope does not exist on disk",
    }));
    const onAdded = vi.fn();
    render(<AddProjectDialog add={add} onAdded={onAdded} close={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project folder path"), { target: { value: "/Users/owner/code/nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("missing-directory");
    expect(alert.textContent).toContain("does not exist on disk");
    expect(onAdded).not.toHaveBeenCalled();
    // The wizard stays on the review step — the retry button is right there.
    expect(screen.getByRole("button", { name: "Add project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });
});

describe("the native-picker door — factory.project.pick.folder", () => {
  it("a cancelled Browse returns to the folder step with NO error and no add", async () => {
    const pick = vi.fn(async (): Promise<ProjectPickReply> => ({ ok: true, cancelled: true, path: null }));
    const add = vi.fn(async (): Promise<ProjectAddReply> => ({ ok: true, ...addSuccess() }));
    render(<AddProjectDialog add={add} pick={pick} onAdded={() => {}} close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(screen.getByRole("dialog", { name: "Add project" })).getByLabelText("Project folder path")).toBeTruthy();
    expect(add).not.toHaveBeenCalled();
  });

  it("a picked Browse registers through the picker ALONE — no redundant add — and lands on Added with its own facts", async () => {
    const pick = vi.fn(
      async (): Promise<ProjectPickReply> => ({
        ok: true,
        cancelled: false,
        ...addSuccess({ bootstrapped: true, summary: "Initialized Git repository and added project greenfield-app (greenfield-app)." }),
      }),
    );
    const add = vi.fn(async (): Promise<ProjectAddReply> => ({ ok: true, ...addSuccess() }));
    const onAdded = vi.fn();
    render(<AddProjectDialog add={add} pick={pick} onAdded={onAdded} close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(onAdded).toHaveBeenCalledWith("/Users/owner/code/greenfield-app");
    expect(add).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Add project" });
    expect(within(dialog).getByText(/Initialized Git repository and added project greenfield-app/)).toBeTruthy();
    expect(within(dialog).getByText("Bootstrapped — initialized with an empty commit")).toBeTruthy();
    expect(within(dialog).getByText(/the picker registered it directly/)).toBeTruthy();
  });
});

describe("the shell's two entry points", () => {
  const neverAdd = vi.fn(async (): Promise<ProjectAddReply> => ({ ok: false, code: "unused", error: "never" }));
  const neverPick = vi.fn(async (): Promise<ProjectPickReply> => ({ ok: true, cancelled: true, path: null }));
  const fixtureSnapshot = async () => ({ ok: true as const, view: fixtureView() });

  it("the topbar button beside the switcher opens the wizard", async () => {
    render(<App loadSnapshot={fixtureSnapshot} projectAdd={neverAdd} pickFolder={neverPick} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
  });

  it("the Overview's empty state offers the same wizard", async () => {
    const empty = fixtureView();
    empty.projects = [];
    render(<App loadSnapshot={async () => ({ ok: true as const, view: empty })} projectAdd={neverAdd} pickFolder={neverPick} />);
    await screen.findByText(/No Projects registered yet/);
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Add project" }));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeTruthy();
  });
});
