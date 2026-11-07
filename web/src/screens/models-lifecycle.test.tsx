/**
 * The Agents & Models screen's lifecycle journeys (T-08c): the profile CRUD
 * and the two seat-retire acts through their transport slots — the strip's
 * "Save Profile…" dialog (`factory.profiles.save`, the name-only snapshot of
 * the Project's CURRENT lane table), its danger "Delete profile…" arm
 * (`factory.profiles.delete`, the destructive confirm that says Copy-on-
 * Apply keeps every Project's lanes), and the roster rows' Rotate
 * Lead / Revoke Supervisor confirms (`factory.lead.rotate` /
 * `factory.supervisor.revoke`), which render ONLY while the row holds a
 * live seat and name that seat before sending. Every Cancel sends nothing;
 * every reply arm renders verbatim as data (the save/delete carry the
 * handler's own `summary`, the retire acts carry the archived `agentId`);
 * success fires the shell's refresh (`onChanged`). A vacant seat renders no
 * retire button at all — the console can retire a LIVE seat, never start
 * one (ADR 0017).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import type { ProfilesDeleteReply, ProfilesSaveReply, SeatRetireReply } from "../lanes.ts";
import { fixtureAgent, fixtureView } from "../test/fixture-view.ts";
import { ModelsScreen } from "./models.tsx";

afterEach(() => {
  cleanup();
});

/** The scoped SLP Project — a LIVE supervisor AND lead seat, two saved profiles, the active one marked. */
const seatedView = (): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[0]!, executionMode: "slp" };
  view.supervisor = fixtureAgent("agent-sup-1", { seat: "supervisor", status: "running", title: "Supervisor" });
  view.lead = fixtureAgent("agent-lead-1", { seat: "lead", status: "running", title: "Lead" });
  view.agents = [view.supervisor, view.lead];
  view.profiles = [
    { id: "balanced", name: "Balanced", description: null, lanes: { ...view.machineLanes }, updatedAt: "2026-11-01T10:00:00.000Z" },
    { id: "fast", name: "Fast Watch", description: null, lanes: { ...view.machineLanes, watch: "pi/zai/glm-5.3-air" }, updatedAt: "2026-11-02T10:00:00.000Z" },
  ];
  view.activeProfileId = "balanced";
  view.activeProfileModified = false;
  return view;
};

/** The same scoped Project with every seat gone — no live bound seat anywhere, so no retire button renders. */
const vacantView = (): FactoryView => {
  const view = seatedView();
  view.supervisor = null;
  view.lead = null;
  view.agents = [];
  return view;
};

const ROOT = "/Users/owner/code/research-slp";

/** A green `factory.profiles.save` reply — the handler's own summary sentence, verbatim. */
const saveOk = (name: string): ProfilesSaveReply => ({
  ok: true,
  profile: { id: "night-ops", name, description: null, lanes: { ...fixtureView().machineLanes }, updatedAt: "2026-11-08T10:00:00.000Z" },
  summary: `Saved Lane profile "${name}" (night-ops).`,
});

/** A green `factory.profiles.delete` reply. */
const deleteOk = (deleted = true): ProfilesDeleteReply => ({
  ok: true,
  deleted,
  summary: deleted ? "Deleted Lane profile balanced." : "No Lane profile balanced exists — nothing deleted.",
});

describe("the Save Profile journey (factory.profiles.save)", () => {
  it("opens from the strip, prefilled with the active profile — Cancel sends nothing", async () => {
    const profilesSave = vi.fn(async (): Promise<ProfilesSaveReply> => saveOk("Balanced"));
    render(<ModelsScreen view={seatedView()} profilesSave={profilesSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    const dialog = screen.getByRole("dialog", { name: "Save Lane Profile" });
    // The design's own prefill: the active profile's name, so the danger arm shows for it.
    expect((within(dialog).getByLabelText("Profile name") as HTMLInputElement).value).toBe("Balanced");
    expect(within(dialog).getByRole("button", { name: "Delete profile Balanced" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(profilesSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves a new name — exactly the name, description, and Project root; description omitted when empty", async () => {
    const profilesSave = vi.fn(async (): Promise<ProfilesSaveReply> => saveOk("Night Ops"));
    const onChanged = vi.fn();
    render(<ModelsScreen view={seatedView()} profilesSave={profilesSave} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    const dialog = screen.getByRole("dialog", { name: "Save Lane Profile" });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), { target: { value: "Night Ops" } });
    // An unmatched name carries no delete arm — there is no such profile to delete.
    expect(within(dialog).queryByRole("button", { name: /Delete profile/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Profile" }));
    await waitFor(() => expect(profilesSave).toHaveBeenCalledTimes(1));
    expect(profilesSave).toHaveBeenCalledWith({ name: "Night Ops", projectRoot: ROOT });
    // The success arm renders the handler's own summary verbatim; the shell refreshes.
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/Saved Lane profile "Night Ops" \(night-ops\)\./)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("carries a typed description along; an empty name refuses locally", async () => {
    const profilesSave = vi.fn(async (): Promise<ProfilesSaveReply> => saveOk("Night Ops"));
    render(<ModelsScreen view={seatedView()} profilesSave={profilesSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    const dialog = screen.getByRole("dialog", { name: "Save Lane Profile" });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), { target: { value: "" } });
    expect(within(dialog).getByText("Enter a profile name.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Save Profile" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Profile name"), { target: { value: "Night Ops" } });
    fireEvent.change(within(dialog).getByLabelText("Description (optional)"), { target: { value: "the quiet shift" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Profile" }));
    await waitFor(() => expect(profilesSave).toHaveBeenCalledTimes(1));
    expect(profilesSave).toHaveBeenCalledWith({ name: "Night Ops", description: "the quiet shift", projectRoot: ROOT });
  });

  it("renders a save refusal verbatim and keeps the form for another try", async () => {
    const profilesSave = vi.fn(async (): Promise<ProfilesSaveReply> => ({ ok: false, code: "profile-refused", error: "the profile library is unwritable" }));
    render(<ModelsScreen view={seatedView()} profilesSave={profilesSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    const dialog = screen.getByRole("dialog", { name: "Save Lane Profile" });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), { target: { value: "Night Ops" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Profile" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (profile-refused)");
    expect(alert.textContent).toContain("the profile library is unwritable");
    expect(within(screen.getByRole("dialog", { name: "Save Lane Profile" })).getByRole("button", { name: "Save Profile" })).toBeTruthy();
  });
});

describe("the Delete profile journey (factory.profiles.delete)", () => {
  it("reaches the destructive confirm from the save dialog's matched name — Cancel sends nothing", async () => {
    const profilesDelete = vi.fn(async (): Promise<ProfilesDeleteReply> => deleteOk());
    render(<ModelsScreen view={seatedView()} profilesDelete={profilesDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    // The prefill matches the active profile — the danger arm is there from the start.
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save Lane Profile" })).getByRole("button", { name: "Delete profile Balanced" }));
    const confirm = screen.getByRole("dialog", { name: "Delete profile?" });
    // The confirm says what deleting means: no Project's lanes change (Copy-on-Apply).
    expect(within(confirm).getByText(/Existing Project lane values remain copied/)).toBeTruthy();
    expect(within(confirm).getByText(/Balanced/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(profilesDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends exactly the profileId — success renders the handler's summary verbatim and refreshes", async () => {
    const profilesDelete = vi.fn(async (): Promise<ProfilesDeleteReply> => deleteOk());
    const onChanged = vi.fn();
    render(<ModelsScreen view={seatedView()} profilesDelete={profilesDelete} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save Lane Profile" })).getByRole("button", { name: "Delete profile Balanced" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete profile?" })).getByRole("button", { name: "Delete profile" }));
    await waitFor(() => expect(profilesDelete).toHaveBeenCalledTimes(1));
    expect(profilesDelete).toHaveBeenCalledWith({ profileId: "balanced" });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Deleted Lane profile balanced.");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a delete refusal verbatim and keeps the confirm", async () => {
    const profilesDelete = vi.fn(async (): Promise<ProfilesDeleteReply> => ({ ok: false, code: "profile-refused", error: "the profile library is unwritable" }));
    render(<ModelsScreen view={seatedView()} profilesDelete={profilesDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Save Profile…" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save Lane Profile" })).getByRole("button", { name: "Delete profile Balanced" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete profile?" })).getByRole("button", { name: "Delete profile" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (profile-refused)");
    expect(alert.textContent).toContain("the profile library is unwritable");
    expect(screen.getByRole("dialog", { name: "Delete profile?" })).toBeTruthy();
  });
});

describe("the seat-retire journeys (factory.lead.rotate / factory.supervisor.revoke)", () => {
  it("renders NO retire button while the seats are vacant", () => {
    render(<ModelsScreen view={vacantView()} />);
    expect(screen.queryByRole("button", { name: "Rotate Lead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke Supervisor" })).toBeNull();
  });

  it("rotates the Lead behind a confirm that names the live seat — Cancel sends nothing, Confirm sends the root", async () => {
    const leadRotate = vi.fn(async (): Promise<SeatRetireReply> => ({ ok: true, agentId: "agent-lead-1" }));
    const onChanged = vi.fn();
    render(<ModelsScreen view={seatedView()} leadRotate={leadRotate} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate Lead" }));
    const dialog = screen.getByRole("dialog", { name: "Rotate Lead?" });
    // The confirm says what happens to the live seat: it is archived, and the refill law is spelled.
    expect(within(dialog).getByText(/agent-lead-1 · Live/)).toBeTruthy();
    expect(within(dialog).getByText(/is archived — its session ends/)).toBeTruthy();
    expect(within(dialog).getByText(/stays vacant until the next Supervisor dispatch/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(leadRotate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Reopen and go through: exactly the Project root rides the write.
    fireEvent.click(screen.getByRole("button", { name: "Rotate Lead" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Rotate Lead?" })).getByRole("button", { name: "Rotate Lead" }));
    await waitFor(() => expect(leadRotate).toHaveBeenCalledTimes(1));
    expect(leadRotate).toHaveBeenCalledWith({ projectRoot: ROOT });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("archived the live seat (agent-lead-1)");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("revokes the Supervisor behind a destructive confirm — the same laws", async () => {
    const supervisorRevoke = vi.fn(async (): Promise<SeatRetireReply> => ({ ok: true, agentId: "agent-sup-1" }));
    const onChanged = vi.fn();
    render(<ModelsScreen view={seatedView()} supervisorRevoke={supervisorRevoke} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Supervisor" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke Supervisor?" });
    expect(within(dialog).getByText(/agent-sup-1 · Live/)).toBeTruthy();
    expect(within(dialog).getByText(/Start the next Supervisor from New Chat/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(supervisorRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Supervisor" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke Supervisor?" })).getByRole("button", { name: "Revoke Supervisor" }));
    await waitFor(() => expect(supervisorRevoke).toHaveBeenCalledTimes(1));
    expect(supervisorRevoke).toHaveBeenCalledWith({ projectRoot: ROOT });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("archived the live seat (agent-sup-1)");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("renders a retire refusal verbatim — the handler's own honest code for a vanished seat", async () => {
    const leadRotate = vi.fn(async (): Promise<SeatRetireReply> => ({ ok: false, code: "no-lead", error: "no live lead" }));
    render(<ModelsScreen view={seatedView()} leadRotate={leadRotate} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate Lead" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Rotate Lead?" })).getByRole("button", { name: "Rotate Lead" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (no-lead)");
    expect(alert.textContent).toContain("no live lead");
    expect(screen.getByRole("dialog", { name: "Rotate Lead?" })).toBeTruthy();
  });
});
