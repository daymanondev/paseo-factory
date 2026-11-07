/**
 * The Inbox screen's contract (T-05): one item per thing needing the Owner
 * across ALL Projects — needs-human Tasks, red Tasks, pending Scrum Owner
 * requests (read-only; answering is T-06), and ready-to-accept Tasks with the
 * SAME Accept journey the Tasks screen owns. Every item names its Project,
 * the nav badge counts the list, refusals and unreachable gathers render as
 * data, and the empty state is exactly "Nothing needs you".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerRequestView, TaskView } from "../../../plugin/shared/view.ts";
import type { InboxReply } from "../inbox.ts";
import { App } from "../App.tsx";
import { navigate } from "../router.ts";
import { fixtureAttempt, fixtureTask, fixtureView } from "../test/fixture-view.ts";
import { inboxModel } from "../view-model.ts";
import { InboxScreen } from "./inbox.tsx";

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

const gather = () => ({
  projects: [
    {
      projectSlug: "research-slp",
      runId: "run-alpha",
      phase: "implementation",
      requests: [
        ownerRequest(),
        ownerRequest({ id: "REQ-02", kind: "design", status: "answered", question: "An already-answered design" }),
      ],
    },
  ],
  refusals: [{ projectSlug: "web-console-fixture", error: "run journal unreadable" }],
  error: null,
});

describe("the inbox fold (pure)", () => {
  it("lists one item per thing needing the Owner, each naming its Project, sorted by urgency", () => {
    const view = crossProjectView();
    view.tasks.push(attributed(fixtureTask("T-11", "red", [fixtureAttempt(1, "red")]), "research-slp"));
    const model = inboxModel(view, gather());
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
    // The ready-to-accept item names the green Attempt the Accept act submits.
    expect(model.items[3]!.acceptAttempt).toBe(2);
    // The per-Project read refusal renders as data, never a failed fold.
    expect(model.refusals).toEqual([{ projectSlug: "web-console-fixture", error: "run journal unreadable" }]);
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
  it("renders the cross-Project items with their Project names and the read-only Scrum row", async () => {
    render(<InboxScreen model={inboxModel(crossProjectView(), gather())} acceptTask={vi.fn()} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    expect(await screen.findByText("Needs you")).toBeTruthy();
    expect(screen.getByText("The T-05 contract")).toBeTruthy();
    expect(screen.getByText("The T-07 contract")).toBeTruthy();
    expect(screen.getAllByText("in research-slp", { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("in web-console-fixture", { exact: false }).length).toBeGreaterThanOrEqual(1);
    // The Scrum request is read-only: no Answer button, its question verbatim.
    expect(screen.getByText("Should the graph keep completed agents visible?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /answer/i })).toBeNull();
    expect(screen.getByText(/this row is read-only/)).toBeTruthy();
    // The per-Project refusal is data on the screen.
    expect(screen.getByText(/run journal refused to read/)).toBeTruthy();
  });

  it("states the empty case exactly: Nothing needs you", async () => {
    render(<InboxScreen model={inboxModel(fixtureView(), null)} acceptTask={vi.fn()} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  it("Accept lands from the Inbox through the shared journey, and the refusal rides as data", async () => {
    const acceptTask = vi.fn(async () => ({ ok: true as const, seq: 31, summary: "accepted T-07 attempt 2 by owner" }));
    const onAccepted = vi.fn();
    render(<InboxScreen model={inboxModel(crossProjectView(), null)} acceptTask={acceptTask} onAccepted={onAccepted} onOpenProject={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept #2" }));
    expect(acceptTask).toHaveBeenCalledWith({ task: "T-07", attempt: 2 });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger seq 31"));
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("Accept's refusal rides as data — the code and the sentence, never a throw", async () => {
    const refusing = vi.fn(async () => ({ ok: false as const, code: "ambiguous-task-project", error: "task T-07 lives in 2 projects" }));
    render(<InboxScreen model={inboxModel(crossProjectView(), null)} acceptTask={refusing} onAccepted={vi.fn()} onOpenProject={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept #2" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("ambiguous-task-project"));
    expect(screen.getByRole("alert").textContent).toContain("task T-07 lives in 2 projects");
  });

  it("deep-links a Task item into the Tasks screen's detail with its Project scope", async () => {
    const onOpenProject = vi.fn();
    render(<InboxScreen model={inboxModel(crossProjectView(), null)} acceptTask={vi.fn()} onAccepted={vi.fn()} onOpenProject={onOpenProject} />);
    await screen.findByText("The T-07 contract");
    fireEvent.click(screen.getByRole("button", { name: "Inspect T-07" }));
    expect(onOpenProject).toHaveBeenCalledWith("/Users/owner/code/web-console-fixture");
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/tasks?task=T-07"));
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
