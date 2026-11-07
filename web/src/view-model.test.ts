/**
 * The view-model seam's contract (T-02): the Meter law — total is COMPUTED
 * as inputUncached + cacheRead + cacheWrite + output, reasoning is a subset
 * of output and never added, and the prototype's
 * `inputTokens`/`cachedInputTokens` shape never exists — plus the Tasks
 * screen model's status vocabulary and accept-attempt law.
 */
import { describe, expect, it } from "vitest";
import type { UsageBucketsView } from "../../plugin/shared/view.ts";
import { fixtureAttempt, fixtureTask, fixtureView } from "./test/fixture-view.ts";
import { acceptAttemptFor, formatTokens, meterFromBuckets, meterLabel, tasksScreenModel, TASK_STATUSES } from "./view-model.ts";

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
    expect(TASK_STATUSES).toEqual(["accepted", "needs-human", "running", "ready-to-accept", "red", "waiting"]);
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
