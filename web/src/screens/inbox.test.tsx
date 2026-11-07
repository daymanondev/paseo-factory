/**
 * The Inbox screen's contract (T-05 + T-06): one item per thing needing the
 * Owner across ALL Projects — needs-human Tasks, red Tasks, pending Scrum
 * Owner requests, budget-blocked runs, and ready-to-accept Tasks with the
 * SAME Accept journey the Tasks screen owns. T-06 makes the Scrum half
 * resolvable inline: Answer/Cancel through `wait.answer` / `wait.cancel`,
 * Approve/Request changes through `design.decide` (the RN client's exact
 * payload), and Grant +N through `allowance.tasks` / `allowance.qa` — every
 * act a fresh `owner-` requestId against the run's own `expectedRevision`,
 * refusals rendered as data, and after success the shell's refresh re-reads
 * the Inbox. The nav badge counts the CROSS-Project fold on every screen,
 * never the scoped selection's.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerRequestView, TaskView } from "../../../plugin/shared/view.ts";
import type { InboxProjectRequests, InboxReply } from "../inbox.ts";
import type { ScrumCommandInput, ScrumCommandReply } from "../scrum.ts";
import { App } from "../App.tsx";
import { navigate } from "../router.ts";
import { fixtureAttempt, fixtureTask, fixtureView } from "../test/fixture-view.ts";
import { inboxModel, type InboxGather } from "../view-model.ts";
import { InboxScreen } from "./inbox.tsx";

/** The gather's ok arm — feeds both the fold and the App's `loadInbox` mocks. */
type GatherOk = Extract<InboxReply, { ok: true }>;

afterEach(() => {
  cleanup();
  navigate("/");
});

/** A Task row carrying the aggregate snapshot's additive `projectSlug` attribution. */
type ScopedTask = TaskView & { projectSlug?: string };
const attributed = (task: TaskView, projectSlug: string): ScopedTask => ({ ...task, projectSlug });

const ownerRequest = (over: Partial<OwnerRequestView> = {}): OwnerRequestView => ({
  id: "REQ-01",
  kind: "question",
  question: "Should the graph keep completed agents visible?",
  affected: [{ kind: "task", id: "T-03" }, { kind: "stage", id: "implementation" }],
  origin: { actor: "architect", role: "architect" },
  status: "pending",
  createdAt: "2026-11-07T10:00:00.000Z",
  ...over,
});

/** The two-Project snapshot the bounded outcome demands — each Task attributed to its Project. */
const crossProjectView = () => {
  const view = fixtureView();
  view.tasks = [
    attributed(fixtureTask("T-05", "needs-human"), "research-slp"),
    attributed(fixtureTask("T-07", "ready-to-accept", [fixtureAttempt(1, "red"), fixtureAttempt(2, "green")]), "web-console-fixture"),
    attributed(fixtureTask("T-09", "accepted", [fixtureAttempt(1, "green")]), "research-slp"),
    attributed(fixtureTask("T-10", "running", [fixtureAttempt(1, null)]), "research-slp"),
  ];
  return view;
};

const gather = (over: Partial<InboxProjectRequests> = {}): GatherOk => ({
  ok: true,
  projects: [
    {
      projectSlug: "research-slp",
      runId: "run-alpha",
      phase: "implementation",
      requests: [
        ownerRequest(),
        ownerRequest({ id: "REQ-02", kind: "design", status: "answered", question: "An already-answered design" }),
      ],
      // T-06: the row's own additive facts — the command's expectedRevision and the allowance data.
      revision: 7,
      allowance: { tasksUsed: 3, tasksAllowed: 8, qaFixRoundsUsed: 0, qaFixRoundsAllowed: 2 },
      blockers: [],
      ...over,
    },
  ],
  refusals: [{ projectSlug: "web-console-fixture", error: "run journal unreadable" }],
});

/** A budget-blocked run row — tasks 1/1 used, the `:exhausted` blocker with cause `tasks`. */
const budgetGather = (over: Partial<InboxProjectRequests> = {}): GatherOk => ({
  ok: true,
  projects: [
    {
      projectSlug: "web-console-fixture",
      runId: "run-beta",
      phase: "blocked",
      requests: [],
      revision: 4,
      allowance: { tasksUsed: 1, tasksAllowed: 1, qaFixRoundsUsed: 1, qaFixRoundsAllowed: 1 },
      blockers: [{ id: "reserve-ux:exhausted", reason: "Task capacity exhausted: 1/1 Tasks used.", causes: ["tasks"] }],
      ...over,
    },
  ],
  refusals: [],
});

/** The fold's input — what the App itself derives from a reply (`error: null` on the ok arm). */
const asGather = (ok: GatherOk): InboxGather => ({ projects: ok.projects, refusals: ok.refusals, error: null });

/** The never-resolving transport — screens under test replace it per act. */
const noCommand = vi.fn(async (_input: ScrumCommandInput): Promise<ScrumCommandReply> => ({ ok: false, code: "unreachable", error: "no transport wired" }));

describe("the inbox fold (pure)", () => {
  it("lists one item per thing needing the Owner, each naming its Project, sorted by urgency", () => {
    const view = crossProjectView();
    view.tasks.push(attributed(fixtureTask("T-11", "red", [fixtureAttempt(1, "red")]), "research-slp"));
    const model = inboxModel(view, asGather(gather()));
    expect(model.items.map((item) => item.kind)).toEqual(["needs-human", "red", "owner-request", "ready-to-accept"]);
    // Every item names its Project — the slug resolves through the snapshot's own projects rows.
    expect(model.items.map((item) => item.projectName)).toEqual(["research-slp", "research-slp", "research-slp", "web-console-fixture"]);
    expect(model.count).toBe(4);
    // The needs-human reason line rides the item verbatim; the red item awaits a Respawn or the Owner.
    expect(model.items[0]!.detail).toBe("gate asked a question");
    expect(model.items[1]!.detail).toContain("awaiting a Respawn or you");
    // The Scrum request is pending-only (the answered one never lists), names its question and holds.
    expect(model.items[2]!.title).toBe("Should the graph keep completed agents visible?");
    expect(model.items[2]!.detail).toBe("Holds task T-03, stage implementation — independent authorized work may continue.");
    expect(model.items[2]!.runId).toBe("run-alpha");
    // T-06: the item carries the row's own facts — the pendingId and the expectedRevision the act submits.
    expect(model.items[2]!.pendingId).toBe("REQ-01");
    expect(model.items[2]!.requestKind).toBe("question");
    expect(model.items[2]!.expectedRevision).toBe(7);
    // The ready-to-accept item names the green Attempt the Accept act submits.
    expect(model.items[3]!.acceptAttempt).toBe(2);
    // The per-Project read refusal renders as data, never a failed fold.
    expect(model.refusals).toEqual([{ projectSlug: "web-console-fixture", error: "run journal unreadable" }]);
  });

  it("ranks the budget-blocked run between owner-requests and ready-to-accept — the urgency ladder", () => {
    const model = inboxModel(crossProjectView(), { projects: [...gather().projects, ...budgetGather().projects], refusals: [], error: null });
    expect(model.items.map((item) => item.kind)).toEqual(["needs-human", "owner-request", "budget-blocked", "ready-to-accept"]);
    expect(model.items.map((item) => item.rank)).toEqual([0, 2, 3, 4]);
    const budget = model.items[2]!;
    expect(budget.badge).toBe("ALLOWANCE");
    expect(budget.runId).toBe("run-beta");
    expect(budget.expectedRevision).toBe(4);
    expect(budget.grantCauses).toEqual(["tasks"]);
    expect(budget.allowance).toEqual({ tasksUsed: 1, tasksAllowed: 1, qaFixRoundsUsed: 1, qaFixRoundsAllowed: 1 });
    expect(budget.detail).toContain("Tasks 1/1 used");
    expect(budget.projectName).toBe("web-console-fixture");
  });

  it("offers the Grant item for exactly the held causes — both dimensions when both are held", () => {
    const model = inboxModel(fixtureView(), asGather(budgetGather({ blockers: [{ id: "b1", reason: "tasks out", causes: ["tasks"] }, { id: "b2", reason: "qa out", causes: ["qaFixRounds"] }] })));
    expect(model.items).toHaveLength(1);
    expect(model.items[0]!.grantCauses).toEqual(["tasks", "qaFixRounds"]);
  });

  it("never invents a Grant item an older gather cannot support — no additive facts, no act", () => {
    const older = budgetGather({ revision: undefined, allowance: undefined, blockers: undefined });
    expect(inboxModel(fixtureView(), asGather(older)).items).toEqual([]);
  });

  it("ignores a Grant item for causes a grant cannot remedy (elapsed, other)", () => {
    const elapsed = budgetGather({ blockers: [{ id: "b1", reason: "elapsed", causes: ["elapsed"] }] });
    expect(inboxModel(fixtureView(), asGather(elapsed)).items).toEqual([]);
  });

  it("skips a ready-to-accept Task with no closed green attempt — no button rather than a guess", () => {
    const view = crossProjectView();
    view.tasks = [attributed(fixtureTask("T-07", "ready-to-accept", [fixtureAttempt(1, "red")]), "web-console-fixture")];
    expect(inboxModel(view, null).items).toEqual([]);
  });

  it("attributes a Task without the additive projectSlug by its workspace — the snapshot's own law", () => {
    const view = crossProjectView();
    view.tasks = [fixtureTask("T-05", "needs-human")]; // workspace under research-slp's root
    const model = inboxModel(view, null);
    expect(model.items[0]!.projectName).toBe("research-slp");
    expect(model.items[0]!.projectRoot).toBe("/Users/owner/code/research-slp");
  });

  it("carries the gather's transport refusal as data on the model", () => {
    const model = inboxModel(crossProjectView(), { projects: [], refusals: [], error: "(unreachable) the sidecar is down" });
    expect(model.items).toHaveLength(2); // the Task half still renders
    expect(model.gatherError).toBe("(unreachable) the sidecar is down");
  });

  it("folds empty to empty — count 0, no invented rows", () => {
    const model = inboxModel(fixtureView(), null);
    expect(model.items).toEqual([]);
    expect(model.count).toBe(0);
  });
});

describe("the Inbox screen", () => {
  it("renders the cross-Project items with their Project names and the resolvable question row", async () => {
    render(<InboxScreen model={inboxModel(crossProjectView(), asGather(gather()))} acceptTask={vi.fn()} scrumCommand={noCommand} onResolved={vi.fn()} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    expect(await screen.findByText("Needs you")).toBeTruthy();
    expect(screen.getByText("The T-05 contract")).toBeTruthy();
    expect(screen.getByText("The T-07 contract")).toBeTruthy();
    expect(screen.getAllByText("in research-slp", { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("in web-console-fixture", { exact: false }).length).toBeGreaterThanOrEqual(1);
    // T-06: the pending question is resolvable inline — its question verbatim, a Record answer act.
    expect(screen.getByText("Should the graph keep completed agents visible?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record answer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel question" })).toBeTruthy();
    // The per-Project refusal is data on the screen.
    expect(screen.getByText(/run journal refused to read/)).toBeTruthy();
  });

  it("states the empty case exactly: Nothing needs you", async () => {
    render(<InboxScreen model={inboxModel(fixtureView(), null)} acceptTask={vi.fn()} scrumCommand={noCommand} onResolved={vi.fn()} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  it("Accept lands from the Inbox through the shared journey, and the refusal rides as data", async () => {
    const acceptTask = vi.fn(async () => ({ ok: true as const, seq: 31, summary: "accepted T-07 attempt 2 by owner" }));
    const onAccepted = vi.fn();
    render(<InboxScreen model={inboxModel(crossProjectView(), null)} acceptTask={acceptTask} scrumCommand={noCommand} onResolved={vi.fn()} onAccepted={onAccepted} onOpenProject={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept #2" }));
    expect(acceptTask).toHaveBeenCalledWith({ task: "T-07", attempt: 2 });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger seq 31"));
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("Accept's refusal rides as data — the code and the sentence, never a throw", async () => {
    const refusing = vi.fn(async () => ({ ok: false as const, code: "ambiguous-task-project", error: "task T-07 lives in 2 projects" }));
    render(<InboxScreen model={inboxModel(crossProjectView(), null)} acceptTask={refusing} scrumCommand={noCommand} onResolved={vi.fn()} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept #2" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("ambiguous-task-project"));
    expect(screen.getByRole("alert").textContent).toContain("task T-07 lives in 2 projects");
  });

  it("deep-links a Task item into the Tasks screen's detail with its Project scope", async () => {
    const onOpenProject = vi.fn();
    render(<InboxScreen model={inboxModel(crossProjectView(), null)} acceptTask={vi.fn()} scrumCommand={noCommand} onResolved={vi.fn()} onAccepted={vi.fn()} onOpenProject={onOpenProject} />);
    await screen.findByText("The T-07 contract");
    fireEvent.click(screen.getByRole("button", { name: "Inspect T-07" }));
    expect(onOpenProject).toHaveBeenCalledWith("/Users/owner/code/web-console-fixture");
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/tasks?task=T-07"));
  });
});

describe("the Inbox's Owner acts (T-06)", () => {
  /** Renders the Inbox with one owner-request item (a pending question by default) and a spy transport. */
  const renderAct = async (request: Partial<OwnerRequestView> = {}, gatherOver: Partial<InboxProjectRequests> = {}) => {
    const scrumCommand = vi.fn(async (_input: ScrumCommandInput): Promise<ScrumCommandReply> => ({ ok: true as const, data: { runId: "run-alpha" } }));
    const onResolved = vi.fn();
    const row = gather({ requests: [ownerRequest(request)], ...gatherOver });
    render(<InboxScreen model={inboxModel(fixtureView(), asGather(row))} acceptTask={vi.fn()} scrumCommand={scrumCommand} onResolved={onResolved} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    return { scrumCommand, onResolved };
  };

  it("answers a pending question through wait.answer — the exact payload, a fresh owner- requestId, the row's revision", async () => {
    const { scrumCommand, onResolved } = await renderAct();
    fireEvent.change(await screen.findByLabelText(/Answer or cancellation reason/), { target: { value: "Keep completed agents visible for 30 days" } });
    fireEvent.click(screen.getByRole("button", { name: "Record answer" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(scrumCommand).toHaveBeenCalledTimes(1);
    const call = scrumCommand.mock.calls[0]![0];
    expect(call.operation).toBe("wait.answer");
    expect(call.projectRoot).toBe("/Users/owner/code/research-slp");
    expect(call.runId).toBe("run-alpha");
    expect(call.expectedRevision).toBe(7);
    expect(call.payload).toEqual({ pendingId: "REQ-01", rationale: "Keep completed agents visible for 30 days" });
    expect(call.requestId).toMatch(/^owner-/);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Recorded — refreshing"));
  });

  it("requires the rationale before either question act can submit", async () => {
    await renderAct();
    const answer = await screen.findByRole("button", { name: "Record answer" });
    expect(answer.getAttribute("disabled")).not.toBeNull();
    fireEvent.change(screen.getByLabelText(/Answer or cancellation reason/), { target: { value: "  " } });
    expect(answer.getAttribute("disabled")).not.toBeNull();
  });

  it("cancels a pending question through wait.cancel — the same payload law", async () => {
    const { scrumCommand } = await renderAct();
    fireEvent.change(await screen.findByLabelText(/Answer or cancellation reason/), { target: { value: "Withdrawn — decided out of band" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel question" }));
    await waitFor(() => expect(scrumCommand).toHaveBeenCalledTimes(1));
    const call = scrumCommand.mock.calls[0]![0];
    expect(call.operation).toBe("wait.cancel");
    expect(call.payload).toEqual({ pendingId: "REQ-01", rationale: "Withdrawn — decided out of band" });
  });

  it("approves a pending design through design.decide — the RN client's exact payload bound to the request's design", async () => {
    const { scrumCommand } = await renderAct({ kind: "design", id: "design:run-alpha:2:abc", question: "Review UI design r2", design: { revision: 2, digest: "d1g3st00000000000000000000000000000000000000000000000000000000f" } });
    fireEvent.change(await screen.findByLabelText(/Decision rationale/), { target: { value: "Ship the r2 chrome" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(scrumCommand).toHaveBeenCalledTimes(1));
    const call = scrumCommand.mock.calls[0]![0];
    expect(call.operation).toBe("design.decide");
    expect(call.payload).toEqual({ decision: "approved", rationale: "Ship the r2 chrome", revision: 2, digest: "d1g3st00000000000000000000000000000000000000000000000000000000f" });
  });

  it("requests changes on a pending design — the same payload, the changes_requested decision", async () => {
    const { scrumCommand } = await renderAct({ kind: "design", id: "design:run-alpha:2:abc", design: { revision: 2, digest: "d1g3st" } });
    fireEvent.change(await screen.findByLabelText(/Decision rationale/), { target: { value: "Tighten the empty state" } });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(scrumCommand).toHaveBeenCalledTimes(1));
    expect((scrumCommand.mock.calls[0]![0]).payload).toEqual({ decision: "changes_requested", rationale: "Tighten the empty state", revision: 2, digest: "d1g3st" });
  });

  it("grants Tasks from a budget-blocked run — amount and rationale through allowance.tasks", async () => {
    const scrumCommand = vi.fn(async (_input: ScrumCommandInput): Promise<ScrumCommandReply> => ({ ok: true as const, data: { runId: "run-beta" } }));
    const onResolved = vi.fn();
    render(<InboxScreen model={inboxModel(fixtureView(), asGather(budgetGather()))} acceptTask={vi.fn()} scrumCommand={scrumCommand} onResolved={onResolved} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/Grant rationale/), { target: { value: "The UX revision is worth it" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant +8 Tasks" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    const call = scrumCommand.mock.calls[0]![0];
    expect(call.operation).toBe("allowance.tasks");
    expect(call.runId).toBe("run-beta");
    expect(call.expectedRevision).toBe(4);
    expect(call.payload).toEqual({ amount: 8, rationale: "The UX revision is worth it" });
    expect(call.requestId).toMatch(/^owner-/);
  });

  it("grants exactly one QA round through allowance.qa when qaFixRounds is held — and only then", async () => {
    const scrumCommand = vi.fn(async (_input: ScrumCommandInput): Promise<ScrumCommandReply> => ({ ok: true as const, data: { runId: "run-beta" } }));
    render(
      <InboxScreen
        model={inboxModel(fixtureView(), asGather(budgetGather({ blockers: [{ id: "qa:exhausted", reason: "Automatic QA fix rounds exhausted: 1/1 used.", causes: ["qaFixRounds"] }] })))}
        acceptTask={vi.fn()}
        scrumCommand={scrumCommand}
        onResolved={vi.fn()}
        onAccepted={vi.fn()}
        onOpenProject={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText(/Grant rationale/), { target: { value: "One more fix round" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant +1 QA round" }));
    await waitFor(() => expect(scrumCommand).toHaveBeenCalledTimes(1));
    const call = scrumCommand.mock.calls[0]![0];
    expect(call.operation).toBe("allowance.qa");
    expect(call.payload).toEqual({ amount: 1, rationale: "One more fix round" });
    // Only the QA cause is held — no Tasks grant button, no amount field.
    expect(screen.queryByRole("button", { name: /Grant \+\d+ Tasks/ })).toBeNull();
    expect(screen.queryByLabelText(/Additional Tasks/)).toBeNull();
  });

  it("renders the refusal as data — the code and the sentence, never a throw", async () => {
    const refusing = vi.fn(async (_input: ScrumCommandInput): Promise<ScrumCommandReply> => ({ ok: false, code: "run-revision-conflict", error: "run-revision-conflict: expected 7, current 8" }));
    render(<InboxScreen model={inboxModel(fixtureView(), asGather(gather()))} acceptTask={vi.fn()} scrumCommand={refusing} onResolved={vi.fn()} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/Answer or cancellation reason/), { target: { value: "Answer against a moved journal" } });
    fireEvent.click(screen.getByRole("button", { name: "Record answer" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Refused (run-revision-conflict)"));
    expect(screen.getByRole("alert").textContent).toContain("expected 7, current 8");
  });

  it("disables the acts an older gather cannot scope — the honest reason renders, never a guess", async () => {
    render(<InboxScreen model={inboxModel(fixtureView(), asGather(gather({ revision: undefined })))} acceptTask={vi.fn()} scrumCommand={noCommand} onResolved={vi.fn()} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    const answer = await screen.findByRole("button", { name: "Record answer" });
    expect(answer.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText(/the inbox read carried no run revision — re-read before acting/)).toBeTruthy();
    expect(noCommand).not.toHaveBeenCalled();
  });
});

describe("the Inbox inside the shell", () => {
  it("shows the nav badge matching the list, and the count drops after the Accept's refresh", async () => {
    let generatedAt = 1;
    let accepted = false;
    const view = () => {
      const snapshot = crossProjectView();
      snapshot.generatedAt = `2026-11-07T10:0${generatedAt++}:00.000Z`;
      if (accepted) {
        snapshot.tasks = snapshot.tasks.map((task) =>
          task.task === "T-07" ? attributed(fixtureTask("T-07", "accepted", [fixtureAttempt(1, "red"), fixtureAttempt(2, "green")]), "web-console-fixture") : task,
        );
      }
      return snapshot;
    };
    const loadInbox = vi.fn(async (): Promise<InboxReply> => ({ ok: true, projects: gather().projects, refusals: [] }));
    render(
      <App
        loadSnapshot={async () => ({ ok: true as const, view: view() })}
        acceptTask={async () => {
          accepted = true;
          return { ok: true as const, seq: 9, summary: "accepted T-07 attempt 2 by owner" };
        }}
        loadInbox={loadInbox}
      />,
    );
    navigate("/inbox");
    // Two Task items + the pending Scrum request — the badge names the same count as the list.
    expect(await screen.findByText("The T-07 contract")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("3", { selector: ".nav-count" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Accept #2" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger seq 9"));
    // The refreshed snapshot (a new generatedAt) re-reads the gather — the count drops and the badge follows.
    await waitFor(() => expect(screen.getByText("2", { selector: ".nav-count" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Accept #2" })).toBeNull();
  });

  it("counts the CROSS-Project inbox on a scoped screen — the badge never rides the selection's view (T-05 carry-over fix)", async () => {
    const all = crossProjectView(); // research-slp's blocker + web-console-fixture's ready-to-accept
    const scoped = fixtureView();
    scoped.project = { slug: "research-slp", root: "/Users/owner/code/research-slp", name: "research-slp" };
    scoped.tasks = [attributed(fixtureTask("T-05", "needs-human"), "research-slp")];
    const loadSnapshot = vi.fn(async (input: { projectRoot?: string }) =>
      input.projectRoot === undefined ? ({ ok: true as const, view: all }) : ({ ok: true as const, view: scoped }),
    );
    render(
      <App
        loadSnapshot={loadSnapshot}
        loadInbox={async () => ({ ok: true, projects: gather().projects, refusals: [] })}
      />,
    );
    navigate("/tasks");
    await screen.findByText("The T-05 contract");
    // Scope the Tasks screen to research-slp — the screen narrows to its one blocker…
    fireEvent.change(await screen.findByRole("combobox", { name: "Project" }), { target: { value: "/Users/owner/code/research-slp" } });
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledWith({ projectRoot: "/Users/owner/code/research-slp" }));
    await waitFor(() => expect(screen.queryByText("The T-07 contract")).toBeNull());
    // …but the badge counts BOTH Projects' items (research-slp's blocker + question, web-console-fixture's ready-to-accept) — 3, not 1.
    await waitFor(() => expect(screen.getByText("3", { selector: ".nav-count" })).toBeTruthy());
  });

  it("renders a refused gather as data — the Task half still lists", async () => {
    render(
      <App
        loadSnapshot={async () => ({ ok: true as const, view: crossProjectView() })}
        loadInbox={async () => ({ ok: false, code: "unreachable", error: "the sidecar is down" })}
      />,
    );
    navigate("/inbox");
    expect(await screen.findByText(/The Scrum half of the inbox refused to load/)).toBeTruthy();
    expect(screen.getByText("The T-05 contract")).toBeTruthy();
  });
});
