/**
 * The Tasks screen's contract (T-02): the scoped snapshot's real Task list
 * in the CONTEXT.md status vocabulary, `Accept` only on a Ready-to-Accept
 * Task with a named green attempt, and the write journey's full feedback
 * law — pending while in flight, refusal as data (code + sentence), the
 * landed note plus an immediate refresh after a green accept, and the
 * refreshed snapshot showing the Task Accepted.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import type { AcceptReply } from "../accept.ts";
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
