/**
 * The Tasks screen's contract (T-02): the scoped snapshot's real Task list
 * in the CONTEXT.md status vocabulary, `Accept` only on a Ready-to-Accept
 * Task with a named green attempt, and the write journey's full feedback
 * law — pending while in flight, refusal as data (code + sentence), the
 * landed note plus an immediate refresh after a green accept, and the
 * refreshed snapshot showing the Task Accepted.
 *
 * T-03 adds the board journey: the List ⇄ Board toggle, the filter chips'
 * per-scope counts, Accept from the board, the URL as the board's memory
 * (view + filter + open detail survive a reload), and the card → detail
 * dialog journey with Accept inside it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import type { AcceptReply } from "../accept.ts";
import type { TaskDetailReply } from "../detail.ts";
import { navigate } from "../router.ts";
import { fixtureAttempt, fixtureTask, fixtureView } from "../test/fixture-view.ts";
import { TasksScreen } from "./tasks.tsx";

afterEach(() => {
  cleanup();
  navigate("/");
});

const readyView = () => {
  const view = fixtureView();
  view.tasks = [
    fixtureTask("T-02", "ready-to-accept", [fixtureAttempt(1, "red"), fixtureAttempt(2, "green")]),
    fixtureTask("T-03", "running", [fixtureAttempt(1, null)]),
    fixtureTask("T-01", "accepted", [fixtureAttempt(1, "green")]),
  ];
  return view;
};

/** The detail fixture the dialog's own transport slot receives in tests. */
const detailReply = (task = "T-02"): TaskDetailReply => ({
  ok: true,
  detail: {
    version: 3,
    task: readyView().tasks.find((row) => row.task === task)!,
    contract: {
      task,
      workspace: `/Users/owner/code/research-slp/.paseo/worktrees/${task}`,
      gate: "npm test",
      artifact: "src/format.ts",
      scope: null,
      skills: null,
      base: null,
      description: "Deliver the named artifact.",
      watch: true,
      freshEyes: true,
      by: "lead",
    },
    attempts: [{ n: 2, verdict: "green", agentId: "agent-peer-1", report: "# Report\n\n- gate green", gateLog: "$ npm test\nok" }],
  },
});

describe("the Tasks screen list", () => {
  it("renders the scoped snapshot's tasks with their statuses", async () => {
    render(<TasksScreen view={readyView()} acceptTask={vi.fn()} onAccepted={vi.fn()} />);
    expect(await screen.findByText("#T-02")).toBeTruthy();
    expect(screen.getByText("ready to accept")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("accepted")).toBeTruthy();
    expect(screen.getByText("All projects · 3 tasks")).toBeTruthy();
  });

  it("shows Accept only on a ready-to-accept task, naming its green attempt", async () => {
    render(<TasksScreen view={readyView()} acceptTask={vi.fn()} onAccepted={vi.fn()} />);
    const accept = await screen.findByRole("button", { name: "Accept #2" });
    expect(accept).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Accept #/ })).toHaveLength(1);
  });

  it("carries no seat-start controls (ADR 0017)", async () => {
    render(<TasksScreen view={readyView()} acceptTask={vi.fn()} onAccepted={vi.fn()} />);
    await screen.findByText("#T-02");
    for (const button of screen.queryAllByRole("button")) {
      expect((button.textContent ?? "").toLowerCase()).not.toContain("start supervisor");
      expect((button.textContent ?? "").toLowerCase()).not.toContain("start lead");
    }
  });

  it("states the empty scope honestly rather than inventing rows", async () => {
    render(<TasksScreen view={fixtureView()} acceptTask={vi.fn()} onAccepted={vi.fn()} />);
    expect(await screen.findByText(/No Tasks in this scope yet/)).toBeTruthy();
  });
});

describe("the Accept write journey", () => {
  it("rides pending, refusal-as-data, and never invents a landed state on refusal", async () => {
    let resolveAccept: (reply: AcceptReply) => void = () => {};
    const acceptTask = vi.fn(
      () =>
        new Promise<AcceptReply>((resolve) => {
          resolveAccept = resolve;
        }),
    );
    const onAccepted = vi.fn();
    render(<TasksScreen view={readyView()} acceptTask={acceptTask} onAccepted={onAccepted} />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept #2" }));
    // Pending: the act is in flight, the button disables and says so.
    expect(await screen.findByRole("button", { name: "Accepting…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept #2" })).toBeNull();

    resolveAccept({ ok: false, code: "not-green", error: "attempt 2 is not green" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not-green"));
    expect(screen.getByRole("alert").textContent).toContain("attempt 2 is not green");
    expect(acceptTask).toHaveBeenCalledWith({ task: "T-02", attempt: 2 });
    expect(onAccepted).not.toHaveBeenCalled();
    // The button returns — the Owner can read the refusal and retry.
    expect(screen.getByRole("button", { name: "Accept #2" })).toBeTruthy();
  });

  it("lands: the note shows, the refresh fires, and the refreshed snapshot shows Accepted", async () => {
    let resolveAccept: (reply: AcceptReply) => void = () => {};
    const acceptTask = vi.fn(
      () =>
        new Promise<AcceptReply>((resolve) => {
          resolveAccept = resolve;
        }),
    );
    const onAccepted = vi.fn();
    const { rerender } = render(<TasksScreen view={readyView()} acceptTask={acceptTask} onAccepted={onAccepted} />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept #2" }));
    resolveAccept({ ok: true, seq: 42, summary: "accepted T-02 attempt 2 by owner" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger seq 42"));
    expect(onAccepted).toHaveBeenCalledTimes(1);

    // The next snapshot — the one `onAccepted` fetches — shows the Task Accepted.
    const refreshed = readyView();
    refreshed.tasks = refreshed.tasks.map((task) => (task.task === "T-02" ? fixtureTask("T-02", "accepted", [fixtureAttempt(1, "red"), fixtureAttempt(2, "green")]) : task));
    rerender(<TasksScreen view={refreshed} acceptTask={acceptTask} onAccepted={onAccepted} />);
    expect(screen.getAllByText("accepted").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("button", { name: "Accept #2" })).toBeNull();
  });
});

describe("the Tasks screen inside the shell", () => {
  it("renders at /tasks from the live snapshot and refreshes immediately after an accept", async () => {
    let acceptCalls = 0;
    const acceptTask = vi.fn(async (): Promise<AcceptReply> => {
      acceptCalls += 1;
      return { ok: true, seq: 7, summary: "accepted T-02 attempt 2 by owner" };
    });
    render(
      <App
        loadSnapshot={async () => ({ ok: true as const, view: readyView() })}
        acceptTask={acceptTask}
      />,
    );
    navigate("/tasks");
    expect(await screen.findByText("#T-02")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept #2" }));
    expect(acceptTask).toHaveBeenCalledWith({ task: "T-02", attempt: 2 });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger seq 7"));
    expect(acceptCalls).toBe(1);
  });
});

describe("the board journey (T-03)", () => {
  const boardView = () => {
    const view = readyView();
    view.tasks.push(fixtureTask("T-06", "needs-human"), fixtureTask("T-08", "waiting"));
    return view;
  };

  it("toggles List ⇄ Board — the board renders the five equal columns with their own cards", async () => {
    render(<TasksScreen view={boardView()} acceptTask={vi.fn()} onAccepted={vi.fn()} loadTaskDetail={vi.fn(() => Promise.resolve(detailReply()))} />);
    // List is the default: cards stack, no columns yet.
    expect(await screen.findByText("#T-02")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Queued" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const columns = ["Queued", "In Progress", "Needs Attention", "Ready to Accept", "Accepted"].map(
      (label) => screen.getByRole("region", { name: label }),
    );
    expect(columns).toHaveLength(5);
    expect(columns[0]!.textContent).toContain("T-08");
    expect(columns[2]!.textContent).toContain("T-06");
    expect(columns[3]!.textContent).toContain("T-02");
    // The compact card names its mode badge and its blocker line.
    expect(columns[2]!.textContent).toContain("needs human · gate asked a question");
    expect(columns[3]!.querySelector(".compact-task")!.textContent).toContain("SLP · Peer");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("region", { name: "Queued" })).toBeNull();
    expect(screen.getByText("#T-02")).toBeTruthy();
  });

  it("counts every chip from this scope's own tasks only", async () => {
    render(<TasksScreen view={boardView()} acceptTask={vi.fn()} onAccepted={vi.fn()} />);
    await screen.findByText("#T-02");
    const chip = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
    expect(chip("All").textContent).toContain("5");
    expect(chip("Queued").textContent).toContain("1");
    expect(chip("In Progress").textContent).toContain("1");
    expect(chip("Needs Attention").textContent).toContain("1");
    expect(chip("Ready to Accept").textContent).toContain("1");
    expect(chip("Accepted").textContent).toContain("1");
  });

  it("filters the list by the chip — and clears back to All", async () => {
    render(<TasksScreen view={boardView()} acceptTask={vi.fn()} onAccepted={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Ready to Accept/ }));
    await waitFor(() => expect(window.location.search).toContain("filter=ready_to_accept"));
    expect(screen.getByText("#T-02")).toBeTruthy();
    expect(screen.queryByText("#T-03")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(window.location.search).not.toContain("filter="));
    expect(screen.getByText("#T-03")).toBeTruthy();
  });

  it("Accepts from the board — the same journey, one button in the column", async () => {
    const acceptTask = vi.fn(async (): Promise<AcceptReply> => ({ ok: true, seq: 11, summary: "accepted" }));
    const onAccepted = vi.fn();
    render(<TasksScreen view={boardView()} acceptTask={acceptTask} onAccepted={onAccepted} loadTaskDetail={vi.fn(() => Promise.resolve(detailReply()))} />);
    fireEvent.click(await screen.findByRole("button", { name: "Board" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept #2" }));
    expect(acceptTask).toHaveBeenCalledWith({ task: "T-02", attempt: 2 });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("ledger seq 11"));
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("keeps the view, filter, and open detail in the URL — a reload lands on the same screen state", async () => {
    render(<TasksScreen view={boardView()} acceptTask={vi.fn()} onAccepted={vi.fn()} loadTaskDetail={vi.fn(() => Promise.resolve(detailReply()))} />);
    fireEvent.click(await screen.findByRole("button", { name: "Board" }));
    fireEvent.click(screen.getByRole("button", { name: /^Ready to Accept/ }));
    await waitFor(() => expect(window.location.search).toContain("view=board"));
    expect(window.location.search).toContain("filter=ready_to_accept");
    expect(window.location.pathname).toBe("/tasks");

    // Open the detail from a board card — the task rides the URL too.
    fireEvent.click(screen.getByRole("button", { name: /The T-02 contract/ }));
    await waitFor(() => expect(window.location.search).toContain("task=T-02"));
    expect(await screen.findByRole("dialog", { name: "T-02 detail" })).toBeTruthy();

    // The reload itself: a fresh mount reads the SAME route memory — board
    // view, the Ready to Accept chip, and the open detail, no clicks needed.
    cleanup();
    render(<TasksScreen view={boardView()} acceptTask={vi.fn()} onAccepted={vi.fn()} loadTaskDetail={vi.fn(() => Promise.resolve(detailReply()))} />);
    expect(screen.getByRole("region", { name: "Queued" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Ready to Accept/ }).className).toContain("active");
    expect(await screen.findByRole("dialog", { name: "T-02 detail" })).toBeTruthy();
  });

  it("opens the Task Detail from a card title and Accepts inside the dialog", async () => {
    const acceptTask = vi.fn(async (): Promise<AcceptReply> => ({ ok: true, seq: 21, summary: "accepted" }));
    const onAccepted = vi.fn();
    const loadTaskDetail = vi.fn(async () => detailReply());
    render(<TasksScreen view={boardView()} acceptTask={acceptTask} onAccepted={onAccepted} loadTaskDetail={loadTaskDetail} />);

    fireEvent.click(await screen.findByRole("button", { name: /The T-02 contract/ }));
    const dialog = await screen.findByRole("dialog", { name: "T-02 detail" });
    expect(loadTaskDetail).toHaveBeenCalledWith({ task: "T-02" });
    // The Contract's gate rides the dialog, next to its Copy button.
    expect(await screen.findByText("npm test")).toBeTruthy();
    expect(dialog.textContent).toContain("Deliver the named artifact.");

    // The list card behind the overlay carries its own Accept — the dialog's
    // is the one the Owner means, so the query scopes to the dialog.
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept #2" }));
    expect(acceptTask).toHaveBeenCalledWith({ task: "T-02", attempt: 2 });
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    // The Accept re-reads the ladder it just changed — one more detail load.
    await waitFor(() => expect(loadTaskDetail).toHaveBeenCalledTimes(2));
    // Both the screen and the dialog carry the landed note — one journey, two honest surfaces.
    expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("ledger seq 21"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.search).not.toContain("task="));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
