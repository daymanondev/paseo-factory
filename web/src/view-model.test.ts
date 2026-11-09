/**
 * The view-model seam's contract (T-02): the Meter law — total is COMPUTED
 * as inputUncached + cacheRead + cacheWrite + output, reasoning is a subset
 * of output and never added, and the prototype's
 * `inputTokens`/`cachedInputTokens` shape never exists — plus the Tasks
 * screen model's status vocabulary and accept-attempt law.
 *
 * T-03 adds the board's own laws: the five-column grouping (drift-guarded
 * against the RN client's canonical `kanban.ts`), the filter chips' per-scope
 * counts (the prototype counted across all Projects — the scoped snapshot
 * makes the fix structural), the Project label law, the mode badge, and the
 * Task Detail fold's Attempt ladder.
 */
import { describe, expect, it } from "vitest";
import { kanbanColumnForStatus } from "../../plugin/client/factory/kanban.ts";
import type { TaskDetailView, TaskStatus, TaskView, UsageBucketsView } from "../../plugin/shared/view.ts";
import { fixtureAttempt, fixtureTask, fixtureView } from "./test/fixture-view.ts";
import {
  acceptAttemptFor,
  boardColumnForStatus,
  filterTaskRows,
  formatTokens,
  meterFromBuckets,
  meterLabel,
  projectNameForTask,
  TASK_COLUMNS,
  taskDetailModel,
  tasksScreenModel,
  TASK_FILTERS,
  TASK_STATUSES,
} from "./view-model.ts";

const buckets = (overrides: Partial<UsageBucketsView> = {}): UsageBucketsView => ({
  turns: 4,
  sessionCount: 1,
  inputUncachedTokens: 1_000,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 500,
  outputTokens: 2_000,
  reasoningTokens: 600,
  totalTokens: 11_500,
  totalCostUsd: 0.25,
  ...overrides,
});

describe("the Meter law at the view-model seam", () => {
  it("computes total as the sum of the four disjoint buckets", () => {
    const meter = meterFromBuckets(buckets())!;
    expect(meter.totalTokens).toBe(1_000 + 8_000 + 500 + 2_000);
    expect(meter.totalCostUsd).toBe(0.25);
  });

  it("never trusts a wire total that disagrees with its buckets — the computed sum wins", () => {
    const lying = buckets({ totalTokens: 999_999 });
    const meter = meterFromBuckets(lying)!;
    expect(meter.totalTokens).toBe(11_500);
  });

  it("carries reasoning as a subset of output — adding it would double-count", () => {
    const meter = meterFromBuckets(buckets({ outputTokens: 2_000, reasoningTokens: 1_500 }))!;
    expect(meter.totalTokens).toBe(11_500); // unchanged: reasoning ⊂ output, never added
    expect(meterLabel(meter)).toContain("incl. 1.5k reasoning in output");
  });

  it("refuses to invent buckets — a row without usage answers null, never a half-shape", () => {
    expect(meterFromBuckets(undefined)).toBeNull();
    expect(meterFromBuckets(null)).toBeNull();
  });

  it("never exposes the prototype's inputTokens/cachedInputTokens shape", () => {
    const meter = meterFromBuckets(buckets())!;
    expect(Object.keys(meter).sort()).toEqual([
      "cacheReadTokens",
      "cacheWriteTokens",
      "inputUncachedTokens",
      "outputTokens",
      "reasoningTokens",
      "totalCostUsd",
      "totalTokens",
    ]);
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(1_234_000)).toBe("1.2M");
  });
});

describe("the Tasks screen model", () => {
  it("keeps the CONTEXT.md status vocabulary verbatim", () => {
    expect(TASK_STATUSES).toEqual(["accepted", "closed", "needs-human", "running", "ready-to-accept", "red", "waiting"]);
  });

  it("folds rows with statuses, counts, and the project meter", () => {
    const view = fixtureView();
    view.tasks = [
      fixtureTask("T-02", "ready-to-accept", [fixtureAttempt(1, "red"), fixtureAttempt(2, "green")]),
      fixtureTask("T-03", "running", [fixtureAttempt(1, null)]),
      fixtureTask("T-01", "accepted", [fixtureAttempt(1, "green")]),
    ];
    view.projectUsage = {
      updatedAt: "2026-11-07T09:00:00.000Z",
      totals: buckets(),
      byModel: [],
      bySeat: [],
      byTask: [
        { task: "T-02", model: "glm-5.3", ...buckets() },
      ],
    };
    const model = tasksScreenModel(view);
    expect(model.scope).toBe("All projects");
    expect(model.rows.map((row) => row.status)).toEqual(["ready-to-accept", "running", "accepted"]);
    expect(model.counts["ready-to-accept"]).toBe(1);
    expect(model.counts.accepted).toBe(1);
    expect(model.meter!.totalTokens).toBe(11_500);
    // The byTask join: only T-02 carries a meter row.
    expect(model.rows[0].meter!.totalTokens).toBe(11_500);
    expect(model.rows[1].meter).toBeNull();
  });

  it("names the LAST closed green attempt as the one Accept submits", () => {
    const task = fixtureTask("T-02", "ready-to-accept", [fixtureAttempt(1, "red"), fixtureAttempt(2, "red"), fixtureAttempt(3, "green")]);
    expect(acceptAttemptFor(task)).toBe(3);
    // A ready-to-accept task with no closed green attempt shows no guess.
    expect(acceptAttemptFor(fixtureTask("T-04", "ready-to-accept", [fixtureAttempt(1, null)]))).toBeNull();
    expect(acceptAttemptFor(fixtureTask("T-05", "ready-to-accept", []))).toBeNull();
  });

  it("offers no accept attempt outside ready-to-accept — the screen shows no button", () => {
    const view = fixtureView();
    view.tasks = [fixtureTask("T-01", "accepted", [fixtureAttempt(1, "green")]), fixtureTask("T-03", "running", [fixtureAttempt(1, null)])];
    const model = tasksScreenModel(view);
    expect(model.rows.every((row) => row.acceptAttempt === null)).toBe(true);
  });

  it("spells the display statuses the Owner reads (needs human keeps its reason)", () => {
    const view = fixtureView();
    view.tasks = [fixtureTask("T-06", "needs-human"), fixtureTask("T-02", "ready-to-accept")];
    const model = tasksScreenModel(view);
    expect(model.rows[0].statusLabel).toBe("needs human · gate asked a question");
    expect(model.rows[1].statusLabel).toBe("ready to accept");
  });
});

describe("the board's five columns (T-03)", () => {
  it("keeps the canonical column vocabulary and order", () => {
    expect(TASK_COLUMNS.map((column) => column.label)).toEqual(["Queued", "In Progress", "Needs Attention", "Ready to Accept", "Accepted"]);
  });

  it("maps every status to its column — a red Task stands in Needs Attention beside needs-human", () => {
    const expected: Record<TaskStatus, ReturnType<typeof boardColumnForStatus>> = {
      waiting: "queued",
      running: "in_progress",
      "needs-human": "needs_attention",
      red: "needs_attention",
      "ready-to-accept": "ready_to_accept",
      accepted: "accepted",
      closed: "accepted",
    };
    for (const status of TASK_STATUSES) expect(boardColumnForStatus(status)).toBe(expected[status]);
  });

  it("never drifts from the RN client's canonical kanban law over every status", () => {
    // The drift guard: the console board and the RN board are the SAME law —
    // `plugin/client/factory/kanban.ts` is imported, not re-typed by hand.
    for (const status of TASK_STATUSES) {
      expect(boardColumnForStatus(status)).toBe(kanbanColumnForStatus(status));
    }
  });

  it("groups the board's cards and counts the chips from THIS scope's tasks only", () => {
    // The prototype defect, fixed structurally: it counted chips across all
    // Projects; the scoped snapshot carries one scope's tasks, and both the
    // chips and the board fold exactly those rows.
    const view = fixtureView();
    view.tasks = [
      fixtureTask("T-06", "needs-human"),
      fixtureTask("T-07", "red", [fixtureAttempt(1, "red")]),
      fixtureTask("T-02", "ready-to-accept", [fixtureAttempt(1, "green")]),
      fixtureTask("T-03", "running", [fixtureAttempt(1, null)]),
      fixtureTask("T-08", "waiting"),
      fixtureTask("T-01", "accepted", [fixtureAttempt(1, "green")]),
    ];
    const model = tasksScreenModel(view);
    expect(model.columnCounts).toEqual({ queued: 1, in_progress: 1, needs_attention: 2, ready_to_accept: 1, accepted: 1 });
    expect(model.board.map((column) => [column.id, column.rows.length])).toEqual([
      ["queued", 1],
      ["in_progress", 1],
      ["needs_attention", 2],
      ["ready_to_accept", 1],
      ["accepted", 1],
    ]);
    expect(model.board[2]!.rows.map((row) => row.task)).toEqual(["T-06", "T-07"]);
  });

  it("keeps a scoped Project's chips honest to its own rows, not the machine's", () => {
    // A scoped snapshot carries ONLY the Project's tasks — the counts cannot
    // borrow another Project's rows even if the screen wanted to.
    const view = fixtureView();
    view.project = { slug: "research-slp", root: "/Users/owner/code/research-slp", name: "research-slp", supervisorId: null, leadId: null, activeTaskCount: 2, executionMode: "slp" };
    view.tasks = [fixtureTask("T-02", "ready-to-accept", [fixtureAttempt(1, "green")]), fixtureTask("T-03", "running", [fixtureAttempt(1, null)])];
    const model = tasksScreenModel(view);
    expect(model.scope).toBe("research-slp");
    expect(model.columnCounts).toEqual({ queued: 0, in_progress: 1, needs_attention: 0, ready_to_accept: 1, accepted: 0 });
  });

  it("filters rows by the chip's own law", () => {
    const view = fixtureView();
    view.tasks = [fixtureTask("T-06", "needs-human"), fixtureTask("T-07", "red", [fixtureAttempt(1, "red")]), fixtureTask("T-02", "ready-to-accept", [fixtureAttempt(1, "green")])];
    const model = tasksScreenModel(view);
    expect(filterTaskRows(model.rows, "all")).toHaveLength(3);
    expect(filterTaskRows(model.rows, "needs_attention").map((row) => row.task)).toEqual(["T-06", "T-07"]);
    expect(filterTaskRows(model.rows, "queued")).toEqual([]);
    // The chips' own vocabulary — `all` plus the five columns, nothing else.
    expect(TASK_FILTERS.map((chip) => chip.id)).toEqual(["all", "queued", "in_progress", "needs_attention", "ready_to_accept", "accepted"]);
  });

  it("names each card's Project in the All projects scope, and no badge when scoped", () => {
    const view = fixtureView();
    const rootTask = fixtureTask("T-01", "waiting");
    rootTask.workspace = "/Users/owner/code/research-slp";
    const insideTask = fixtureTask("T-02", "waiting");
    insideTask.workspace = "/Users/owner/code/research-slp/packages/app";
    const worktreeTask = fixtureTask("T-03", "waiting");
    worktreeTask.workspace = "/Users/owner/.paseo/projects/research-slp/worktrees/T-03";
    const strangerTask = fixtureTask("T-04", "waiting");
    strangerTask.workspace = "/Users/owner/code/somewhere-else";
    view.tasks = [rootTask, insideTask, worktreeTask, strangerTask];
    const unscoped = tasksScreenModel(view);
    expect(unscoped.rows.map((row) => row.project)).toEqual(["research-slp", "research-slp", "research-slp", "somewhere-else"]);

    view.project = view.projects[0]!;
    const scoped = tasksScreenModel(view);
    expect(scoped.rows.every((row) => row.project === null)).toBe(true);
  });

  it("spells the mode badge from the Contract's execution binding", () => {
    const view = fixtureView();
    const scrum = fixtureTask("T-09", "waiting") as TaskView;
    scrum.execution = { mode: "scrum", runId: "run-1", role: "qa", configRevision: 3 };
    view.tasks = [scrum, fixtureTask("T-10", "waiting")];
    const model = tasksScreenModel(view);
    expect(model.rows[0]!.modeLabel).toBe("Scrum · qa");
    expect(model.rows[1]!.modeLabel).toBe("SLP · Peer");
  });
});

describe("the Task Detail fold (T-03)", () => {
  const detailFixture = (): TaskDetailView => {
    const task = fixtureTask("T-03", "ready-to-accept", [
      { ...fixtureAttempt(1, "red"), respawned: true, reviewState: "off", watch: null, eye: null },
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
        description: "## Bounded outcome\n\n- board columns\n- **detail** ladder",
        watch: true,
        freshEyes: true,
        by: "lead",
      },
      attempts: [
        { n: 1, verdict: "red", agentId: null, report: null, gateLog: null },
        { n: 2, verdict: "green", agentId: "agent-peer-9", report: "# Report\n\n- gate green\n- `npm run check`", gateLog: "$ npm run check\nok" },
      ],
    };
  };

  it("joins the fold's attempts with the handler's tailed content, rung by rung", () => {
    const model = taskDetailModel(detailFixture());
    expect(model.task).toBe("T-03");
    expect(model.statusLabel).toBe("ready to accept");
    expect(model.acceptAttempt).toBe(2);
    expect(model.contract.gate).toBe("npm run check");
    expect(model.contract.scope).toEqual(["web/src", "test"]);
    expect(model.contract.skills).toEqual(["tdd", "code-review"]);
    expect(model.contract.base).toBe("b29a3ce");
    expect(model.contract.by).toBe("lead");
    expect(model.contract.watch).toBe(true);
    expect(model.contract.freshEyes).toBe(true);

    expect(model.rungs).toHaveLength(2);
    const [red, green] = model.rungs;
    expect(red!.verdictLabel).toBe("Gate red");
    expect(red!.respawned).toBe(true);
    expect(red!.report).toBeNull();
    expect(green!.verdictLabel).toBe("Gate green");
    expect(green!.agentId).toBe("agent-peer-9");
    expect(green!.report).toContain("# Report");
    expect(green!.gateLog).toContain("$ npm run check");
    expect(green!.reviewState).toBe("clear");
    // The Watch pass's answers ride verbatim — a passenger's probabilities.
    expect(green!.watch?.maxProbability).toBe(0.75);
    expect(green!.watch?.answers).toEqual({ "lied about tests": 0.75, "scope creep": null });
    expect(green!.eye?.outcome).toBe("clear");
    expect(green!.eye?.finding).toBe("The report matches the diff.");
  });

  it("never invents content the handler did not tail", () => {
    const fixture = detailFixture();
    fixture.attempts = [];
    const model = taskDetailModel(fixture);
    expect(model.rungs).toHaveLength(2);
    expect(model.rungs.every((rung) => rung.report === null && rung.gateLog === null)).toBe(true);
    // A task outside ready-to-accept names no Accept attempt, even green ones.
    fixture.task.status = "accepted";
    expect(taskDetailModel(fixture).acceptAttempt).toBeNull();
  });
});
