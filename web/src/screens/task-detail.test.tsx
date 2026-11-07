/**
 * The Task Detail body's contract (T-03): the Contract's fields in the
 * prototype's data-list vocabulary, the description and Reports rendered as
 * the Markdown the Factory actually emits (never `innerHTML`), the Attempt
 * ladder's rung fields — verdict, exit, note, Claim SHA, ↻ respawn, review
 * state, Watch answers, Fresh-eyes finding — the tailed report and gate-log
 * content readable inline, and the Copy buttons' honest feedback through an
 * injected clipboard. The dialog's own refusal-as-data law rides its
 * transport slot: a refused detail is a sentence the Owner reads, never a
 * throw.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetailView } from "../../../plugin/shared/view.ts";
import type { TaskDetailReply } from "../detail.ts";
import { fixtureAttempt, fixtureTask } from "../test/fixture-view.ts";
import { taskDetailModel } from "../view-model.ts";
import { Markdown } from "../markdown.tsx";
import { TaskDetailDialog } from "./tasks.tsx";
import { TaskDetailPanel } from "./task-detail.tsx";

afterEach(cleanup);

const detailFixture = (): TaskDetailView => {
  const task = fixtureTask("T-03", "ready-to-accept", [
    { ...fixtureAttempt(1, "red"), respawned: true, note: "one bounded finding", reviewState: "off", watch: null, eye: null },
    {
      ...fixtureAttempt(2, "green"),
      reviewState: "clear",
      watch: { outcome: "written", model: "typesafe/jev-1.13", error: null, maxProbability: 0.75, answers: { "lied about tests": 0.75, "scope creep": null } },
      eye: { outcome: "clear", model: "pi/zai/glm-5.3", finding: "The report matches the diff." },
    },
  ]);
  return {
    version: 3 as const,
    task,
    contract: {
      task: "T-03",
      workspace: task.workspace,
      gate: "npm run check",
      artifact: "web/src/view-model.ts",
      scope: ["web/src", "test"],
      skills: ["tdd", "code-review"],
      base: "b29a3ce",
      description: "## Bounded outcome\n\n- five columns\n- **detail** ladder with `code`",
      watch: true,
      freshEyes: true,
      by: "lead",
    },
    attempts: [
      { n: 1, verdict: "red", agentId: null, report: null, gateLog: null },
      { n: 2, verdict: "green", agentId: "agent-peer-9", report: "# Report\n\n- gate `green`\n- all tests pass", gateLog: "$ npm run check\nok 1" },
    ],
  };
};

describe("the Task Detail panel", () => {
  it("renders the Contract's fields in the prototype's vocabulary", () => {
    render(<TaskDetailPanel detail={taskDetailModel(detailFixture())} />);
    expect(screen.getByText("Gate").nextElementSibling!.textContent).toContain("npm run check");
    expect(screen.getByText("Artifact").nextElementSibling!.textContent).toContain("web/src/view-model.ts");
    expect(screen.getByText("Scope").nextElementSibling!.textContent).toContain("web/src, test");
    expect(screen.getByText("Skills").nextElementSibling!.textContent).toContain("tdd · code-review");
    expect(screen.getByText("Base").nextElementSibling!.textContent).toContain("b29a3ce");
    expect(screen.getByText("Workspace").nextElementSibling!.textContent).toContain("worktrees/T-03");
    expect(screen.getByText("Created by").nextElementSibling!.textContent).toContain("lead");
    expect(screen.getByText("Watch on")).toBeTruthy();
    expect(screen.getByText("Fresh eyes on")).toBeTruthy();
  });

  it("renders the description and reports as Markdown elements — never innerHTML", () => {
    const { container } = render(<TaskDetailPanel detail={taskDetailModel(detailFixture())} />);
    // The Contract description's `## Bounded outcome` is a real heading, its
    // bullets real list items, the strong a real <strong>.
    expect(container.querySelector(".console-markdown h4")!.textContent).toBe("Bounded outcome");
    const listItems = [...container.querySelectorAll(".console-markdown li")].map((node) => node.textContent);
    expect(listItems).toContain("five columns");
    expect(listItems).toContain("detail ladder with code");
    expect(container.querySelector(".console-markdown li strong")!.textContent).toBe("detail");
    expect(container.querySelector(".console-markdown li code")!.textContent).toBe("code");
    // No raw markup ever reaches the DOM as text.
    expect(container.textContent).not.toContain("**detail**");
    expect(container.innerHTML).not.toContain("<script");
  });

  it("renders the ladder rung by rung — verdict, exit, note, SHA, ↻, review, Watch, eye, evidence", () => {
    render(<TaskDetailPanel detail={taskDetailModel(detailFixture())} />);
    const rungs = screen.getAllByRole("group");
    expect(rungs).toHaveLength(2);

    // Rung #2 (green, open by default): every field the Owner reads.
    const green = rungs.find((rung) => rung.dataset.attempt === "2")!;
    expect(within(green).getByText("Gate green")).toBeTruthy();
    expect(green.textContent).toContain("agent-peer-9".slice(0, 8));
    expect(within(green).getByText("Exit").nextElementSibling!.textContent).toBe("0");
    expect(within(green).getByText("Claim SHA").nextElementSibling!.textContent).toContain("2a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d");
    expect(within(green).getByText("Fresh-eyes review").nextElementSibling!.textContent).toBe("clear");
    expect(green.textContent).toContain("Watch · written");
    expect(green.textContent).toContain("max probability 0.75");
    expect(within(green).getByText("lied about tests: 0.75")).toBeTruthy();
    expect(within(green).getByText("scope creep: —")).toBeTruthy();
    expect(green.textContent).toContain("Fresh eyes · clear");
    expect(green.textContent).toContain("The report matches the diff.");
    // The tailed evidence, inline: the report's Markdown (the `green` code
    // span breaks the words — the rung's own text carries them) and the log.
    expect(green.textContent).toContain("gate green");
    expect(within(green).getByText((_, element) => element?.tagName === "PRE" && element.textContent === "$ npm run check\nok 1")).toBeTruthy();

    // Rung #1 (red, open by default too — it carries a verdict): the ↻ badge
    // and the gate's own note.
    const red = rungs.find((rung) => rung.dataset.attempt === "1")!;
    expect(within(red).getByText("Gate red")).toBeTruthy();
    expect(red.querySelector("summary")!.textContent).toContain("↻");
    expect(within(red).getByText("Exit").nextElementSibling!.textContent).toBe("1");
    expect(within(red).getByText("Note").nextElementSibling!.textContent).toContain("one bounded finding");
  });

  it("copies the gate, the SHA, the report, and the log through the injected clipboard — with honest feedback", async () => {
    const landed = vi.fn(async (_text: string) => true);
    const failing = vi.fn(async (_text: string) => false);
    // The green rung's Claim SHA rides the failing clipboard so both feedback
    // spellings prove themselves in one pass; every other payload lands.
    const greenSha = "2a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d";
    const copy = (text: string) => (text === greenSha ? failing(text) : landed(text));
    render(<TaskDetailPanel detail={taskDetailModel(detailFixture())} copy={copy} />);
    // Both verdicted rungs carry a SHA — the green rung's is the one under test.
    const green = screen.getAllByRole("group").find((rung) => rung.dataset.attempt === "2")!;

    fireEvent.click(screen.getByRole("button", { name: "Copy gate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(landed).toHaveBeenCalledWith("npm run check");

    fireEvent.click(within(green).getByRole("button", { name: "Copy SHA" }));
    await waitFor(() => expect(within(green).getByRole("button", { name: "Copy failed" })).toBeTruthy());

    fireEvent.click(within(green).getByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(landed).toHaveBeenCalledWith(expect.stringContaining("# Report")));
    fireEvent.click(within(green).getByRole("button", { name: "Copy log" }));
    await waitFor(() => expect(landed).toHaveBeenCalledWith("$ npm run check\nok 1"));
  });

  it("states an empty ladder honestly", () => {
    const fixture = detailFixture();
    fixture.task = fixtureTask("T-03", "waiting", []);
    fixture.attempts = [];
    fixture.contract.watch = false;
    fixture.contract.freshEyes = false;
    render(<TaskDetailPanel detail={taskDetailModel(fixture)} />);
    expect(screen.getByText(/No Attempts yet/)).toBeTruthy();
    expect(screen.getByText("Watch off")).toBeTruthy();
    expect(screen.getByText("Fresh eyes off")).toBeTruthy();
  });
});

describe("the Markdown fold's own vocabulary", () => {
  it("keeps anything it does not model as honest plain text", () => {
    const { container } = render(
      <Markdown text={"# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[link](https://x) stays text"} />,
    );
    expect(container.querySelector("h3")!.textContent).toBe("Title");
    expect(container.textContent).toContain("[link](https://x) stays text");
    expect(container.querySelectorAll("table, a").length).toBe(0);
  });
});

describe("the Task Detail dialog's refusal-as-data law", () => {
  it("shows the refusal's code and sentence — never a throw, and the Close stays", async () => {
    const loadTaskDetail = vi.fn(async (): Promise<TaskDetailReply> => ({ ok: false, code: "unknown-task", error: "no contract set for task T-99" }));
    render(
      <TaskDetailDialog
        task="T-99"
        acceptState={{ pending: null, refusal: null, landed: null }}
        accept={vi.fn()}
        onAcceptLanded={() => {}}
        loadTaskDetail={loadTaskDetail}
        close={() => {}}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("unknown-task");
    expect(alert.textContent).toContain("no contract set for task T-99");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("keeps the Accept refusal visible inside the dialog it was pressed from", async () => {
    const detail = detailFixture();
    const loadTaskDetail = vi.fn(async (): Promise<TaskDetailReply> => ({ ok: true, detail }));
    render(
      <TaskDetailDialog
        task="T-03"
        acceptState={{ pending: null, refusal: { task: "T-03", code: "not-green", error: "attempt 2 is not green" }, landed: null }}
        accept={vi.fn()}
        onAcceptLanded={() => {}}
        loadTaskDetail={loadTaskDetail}
        close={() => {}}
      />,
    );
    await screen.findAllByText("Gate");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("not-green");
    expect(alert.textContent).toContain("attempt 2 is not green");
  });
});
