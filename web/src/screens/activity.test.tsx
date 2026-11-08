/**
 * The Activity screen's contract (T-11a): the `/activity` route renders the
 * read-only ledger stream and the usage rollup from the snapshot alone —
 * newest-first rows with the deterministic UTC stamp, the kind the event's
 * own word decides, the task id, and the ledger's own detail line verbatim;
 * the client-side kind chips (contract / spawn / claim / gate / accepted /
 * meter / other) switch the view and never send anything; the scoped
 * Project's `ledgerError` renders as the stream's degraded notice; the
 * usage half renders the design's summary + By model / By lane bars with
 * the honest "No usage recorded" when the snapshot carries no rollup. The
 * boundary law holds: NO write buttons exist on this screen — the retro
 * pass and its ratification are T-11b, and no seat Start/Ensure control
 * exists anywhere (ADR 0017).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryView, LedgerLineView, ProjectUsageView } from "../../../plugin/shared/view.ts";
import { fixtureView } from "../test/fixture-view.ts";
import {
  activityKindChips,
  activityScreenModel,
  cacheHitPercent,
  eventKind,
  filterLedgerRows,
  formatTokenCount,
  KIND_ORDER,
} from "../activity-view.ts";
import { ActivityScreen } from "./activity.tsx";

afterEach(() => {
  cleanup();
});

// ---- the fixture views ---------------------------------------------------------------------------

/** One ledger line — every field honest, `projectSlug` only where the aggregate carries it. */
function line(over: Partial<LedgerLineView> & Pick<LedgerLineView, "seq" | "event">): LedgerLineView {
  return { ts: "2026-11-08T09:05:00.000Z", task: "T-11", line: "the rendered line", ...over };
}

/** The usage rollup — two model rows, one seat row, the cost honestly null on one. */
function usage(): ProjectUsageView {
  return {
    updatedAt: "2026-11-08T09:00:00.000Z",
    backfilledAt: "2026-11-07T08:00:00.000Z",
    totals: {
      turns: 7,
      sessionCount: 2,
      inputUncachedTokens: 41_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2_000,
      outputTokens: 9_000,
      reasoningTokens: 1_000,
      totalTokens: 62_000,
      totalCostUsd: 0.5,
    },
    byModel: [
      {
        provider: "pi",
        harness: "pi",
        model: "glm-5.3",
        turns: 4,
        sessionCount: 1,
        inputUncachedTokens: 40_000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 2_000,
        outputTokens: 8_000,
        reasoningTokens: 1_000,
        totalTokens: 60_000,
        totalCostUsd: 0.5,
      },
      {
        provider: "codex",
        harness: "codex",
        model: "gpt-6.1",
        turns: 3,
        sessionCount: 1,
        inputUncachedTokens: 1_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1_000,
        reasoningTokens: 0,
        totalTokens: 2_000,
        totalCostUsd: null,
      },
    ],
    bySeat: [
      {
        seat: "lead",
        label: "Lead",
        turns: 4,
        sessionCount: 1,
        inputUncachedTokens: 40_000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 2_000,
        outputTokens: 8_000,
        reasoningTokens: 1_000,
        totalTokens: 60_000,
        totalCostUsd: 0.5,
      },
    ],
    byTask: [],
  };
}

/** The rich view — a seeded multi-kind ledger (newest first, as the server's stream law sends it) and the rollup. */
const richView = (): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[0]!, executionMode: "slp" };
  view.projectUsage = usage();
  view.ledger = [
    line({ seq: 8, event: "needs_human", line: "needs human — gate asked", ts: "2026-11-08T09:07:00.000Z" }),
    line({ seq: 7, event: "attempt_accepted", line: "ACCEPTED #1 by owner", ts: "2026-11-08T09:06:00.000Z" }),
    line({ seq: 6, event: "meter_written", line: "meter pi $0.50", ts: "2026-11-08T09:05:00.000Z" }),
    line({ seq: 5, event: "gate_finished", line: "gate #1 green — passed", ts: "2026-11-08T09:04:00.000Z" }),
    line({ seq: 4, event: "claim_reported", line: "claim #1 a1b2c3d", ts: "2026-11-08T09:03:00.000Z" }),
    line({ seq: 3, event: "spawn_dispatched", line: "spawn pi", ts: "2026-11-08T09:02:00.000Z" }),
    line({ seq: 2, event: "contract_set", line: 'contract gate="npm test" artifact=src/format.ts', ts: "2026-11-08T09:01:00.000Z" }),
    line({ seq: 1, event: "ledger_schema", task: null, line: "ledger schema v1", ts: "2026-11-08T09:00:00.000Z" }),
  ];
  return view;
};

// ---- the fold (pure) -------------------------------------------------------------------------------

describe("the activity fold (pure)", () => {
  it("classifies the ledger's own event vocabulary onto the seven kinds — nothing fabricated, nothing dropped", () => {
    expect(eventKind("contract_set")).toBe("contract");
    for (const event of ["spawn_dispatched", "spawn_refused", "respawn_dispatched", "respawn_refused", "repoke_dispatched", "repoke_refused"]) {
      expect(eventKind(event), event).toBe("spawn");
    }
    expect(eventKind("claim_reported")).toBe("claim");
    for (const event of ["gate_started", "gate_finished", "report_written", "watch_written", "fresh_eyes_written"]) {
      expect(eventKind(event), event).toBe("gate");
    }
    expect(eventKind("attempt_accepted")).toBe("accepted");
    expect(eventKind("meter_written")).toBe("meter");
    for (const event of ["ledger_schema", "needs_human", "permit_allowed", "permit_denied", "git_blocked", "retro_written"]) {
      expect(eventKind(event), event).toBe("other");
    }
    // An unknown future event word still folds — `other`, never a throw.
    expect(eventKind("something_new")).toBe("other");
  });

  it("keeps the snapshot's own newest-first order, rows stamped in deterministic UTC", () => {
    const model = activityScreenModel(richView());
    expect(model.ledger.map((row) => row.seq)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(model.ledger[0]!.timeLabel).toBe("2026-11-08 09:07 UTC");
    expect(model.ledger[0]!.detail).toBe("needs human — gate asked");
    expect(model.ledger[0]!.task).toBe("T-11");
    // Workspace-scoped lines carry the honest null task, never a borrowed one.
    const schema = model.ledger.find((row) => row.event === "ledger_schema")!;
    expect(schema.task).toBeNull();
    expect(schema.kind).toBe("other");
  });

  it("counts every kind for the chips — `all` is the stream's own length", () => {
    const model = activityScreenModel(richView());
    expect(model.kindCounts).toEqual({ all: 8, contract: 1, spawn: 1, claim: 1, gate: 1, accepted: 1, meter: 1, other: 2 });
    const chips = activityKindChips(model);
    expect(chips.map((chip) => chip.id)).toEqual(["all", ...KIND_ORDER]);
    expect(chips[0]!).toEqual({ id: "all", label: "All events", count: 8 });
  });

  it("filters client-side — one kind's rows only, `all` restores the stream", () => {
    const model = activityScreenModel(richView());
    expect(filterLedgerRows(model.ledger, "gate").map((row) => row.event)).toEqual(["gate_finished"]);
    expect(filterLedgerRows(model.ledger, "other").map((row) => row.event)).toEqual(["needs_human", "ledger_schema"]);
    expect(filterLedgerRows(model.ledger, "all")).toHaveLength(8);
    expect(filterLedgerRows(model.ledger, "spawn")).toHaveLength(1);
  });

  it("carries the aggregate stream's additive projectSlug through, null when the line carries none", () => {
    const view = richView();
    view.ledger = view.ledger.map((entry, index) => ({ ...entry, ...(index === 0 ? { projectSlug: "research-slp" } : {}) }) as LedgerLineView);
    const model = activityScreenModel(view);
    expect(model.ledger[0]!.projectSlug).toBe("research-slp");
    expect(model.ledger[1]!.projectSlug).toBeNull();
  });

  it("folds the scoped Project's ledgerError as the stream's degraded notice", () => {
    const view = fixtureView();
    view.project = { ...view.projects[0]!, ledgerError: "ledger.jsonl: ENOENT" };
    expect(activityScreenModel(view).ledgerError).toBe("ledger.jsonl: ENOENT");
    expect(activityScreenModel(fixtureView()).ledgerError).toBeNull();
  });

  it("folds the usage rollup — totals, cache-hit, the two bar sections scaled to their own maxima", () => {
    const model = activityScreenModel(richView());
    expect(model.usage, "the scoped rollup folds").not.toBeNull();
    const panel = model.usage!;
    expect(panel.updatedAtLabel).toBe("2026-11-08 09:00 UTC");
    expect(panel.backfilled).toBe(true);
    expect(panel.totals.totalLabel).toBe(formatTokenCount(62_000));
    // Input is gross — uncached + cache-read + cache-write (the design's own "Includes cached" law).
    expect(panel.totals.inputLabel).toBe(formatTokenCount(53_000));
    expect(panel.totals.outputLabel).toBe(formatTokenCount(9_000));
    expect(panel.totals.costLabel).toBe("$0.50");
    expect(panel.totals.cacheHitLabel).toBe(cacheHitPercent({
      inputUncachedTokens: 41_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2_000,
    }));
    expect(panel.totals.cacheHitLabel).toBe("19%");
    // By model: the largest row fills the bar, the costless row carries its honest null.
    expect(panel.byModel.map((row) => [row.id, row.totalLabel, row.share])).toEqual([
      ["pi/glm-5.3", "60K", 100],
      ["codex/gpt-6.1", "2K", 3],
    ]);
    expect(panel.byModel[0]!.costLabel).toBe("$0.50");
    expect(panel.byModel[0]!.sub).toBe("pi · $0.50");
    expect(panel.byModel[1]!.costLabel).toBeNull();
    expect(panel.byModel[1]!.sub).toBe("codex");
    // The input+output segments never exceed the row's own share of the max.
    for (const row of [...panel.byModel, ...panel.bySeat]) {
      expect(row.inputShare + row.outputShare).toBeLessThanOrEqual(100);
    }
    expect(panel.bySeat.map((row) => [row.label, row.sub])).toEqual([["Lead", "1 session · $0.50"]]);
  });

  it("folds the honest usage null — absent rollup, unscoped view, the empty word", () => {
    expect(activityScreenModel(fixtureView()).usage).toBeNull();
    const view = richView();
    delete view.projectUsage;
    expect(activityScreenModel(view).usage).toBeNull();
  });

  it("formats tokens and cache-hit with the RN usage surfaces' own law", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1K");
    expect(formatTokenCount(1_666_211)).toBe("1.7M");
    expect(formatTokenCount(62_000_000_000)).toBe("62.0B");
    expect(cacheHitPercent({ inputUncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe("–");
  });

  it("carries the snapshot-level daemon degradation line and the scope word", () => {
    const view = richView();
    expect(activityScreenModel(view).scope).toBe("research-slp");
    view.daemonError = "paseo daemon unreachable";
    expect(activityScreenModel(view).daemonError).toBe("paseo daemon unreachable");
    expect(activityScreenModel(fixtureView()).scope).toBe("All projects");
  });
});

// ---- the screen ------------------------------------------------------------------------------------

describe("the Activity screen", () => {
  it("renders the heading, the newest-first stream, and the usage summary — every seeded kind by its own chip", () => {
    render(<ActivityScreen view={richView()} />);
    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(screen.getByText("research-slp · 8 events · newest first")).toBeTruthy();
    const stream = screen.getByLabelText("Ledger stream");
    // The newest row first, its detail the ledger's own line verbatim.
    const rows = stream.querySelectorAll(".ledger-row");
    expect(rows).toHaveLength(8);
    expect(within(stream).getByText("2026-11-08 09:07 UTC")).toBeTruthy();
    expect(within(stream).getByText("needs human — gate asked")).toBeTruthy();
    expect(within(stream).getByText("ACCEPTED #1 by owner")).toBeTruthy();
    expect(within(stream).getByText("meter pi $0.50")).toBeTruthy();
    // The usage half: the four summary stats and both bar sections.
    expect(screen.getByText("Token & cost usage")).toBeTruthy();
    expect(screen.getByText(/cache-hit 19%/)).toBeTruthy();
    expect(screen.getByText("$0.50")).toBeTruthy();
    expect(screen.getByText("glm-5.3")).toBeTruthy();
    expect(screen.getByText("gpt-6.1")).toBeTruthy();
    expect(screen.getByText("Lead", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("pi · $0.50")).toBeTruthy();
  });

  it("switches the kind chips client-side — the contract chip narrows to the contract row, All restores", () => {
    render(<ActivityScreen view={richView()} />);
    expect(screen.getByText("Showing 8 of 8 entries")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /contract 1/ }));
    expect(screen.getByText("Showing 1 of 8 entries")).toBeTruthy();
    const stream = screen.getByLabelText("Ledger stream");
    expect(stream.querySelectorAll(".ledger-row")).toHaveLength(1);
    expect(within(stream).getByText('contract gate="npm test" artifact=src/format.ts')).toBeTruthy();
    expect(screen.getByRole("button", { name: /contract 1/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /All events 8/ }));
    expect(screen.getByText("Showing 8 of 8 entries")).toBeTruthy();
  });

  it("disables the zero-count chips — an absent kind can never be selected", () => {
    const view = richView();
    view.ledger = view.ledger.filter((entry) => entry.event !== "meter_written");
    render(<ActivityScreen view={view} />);
    expect(screen.getByRole("button", { name: /meter 0/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /accepted 1/ }).hasAttribute("disabled")).toBe(false);
  });

  it("answers the honest empty stream — no events, the honest word, never a fabricated row", () => {
    render(<ActivityScreen view={fixtureView()} />);
    expect(screen.getByText("All projects · 0 events · newest first")).toBeTruthy();
    expect(screen.getByText("No ledger events in this scope", { selector: "h3" })).toBeTruthy();
    expect(screen.getByText(/the Factory writes its first line/)).toBeTruthy();
  });

  it("attributes the aggregate stream's rows with their Project slug — only on the unscoped view", () => {
    // The unscoped aggregate: two Projects may share a task id, so the row's
    // own attribution renders beside the detail.
    const unscoped = richView();
    unscoped.project = null;
    unscoped.ledger = unscoped.ledger.map((entry) => ({ ...entry, projectSlug: "research-slp" }) as LedgerLineView);
    render(<ActivityScreen view={unscoped} />);
    expect(screen.getAllByText("· research-slp").length).toBe(8);
    cleanup();
    // The scoped view needs no attribution — the switcher already names the
    // one Project, so the suffix stays off even when the wire carries it.
    const scoped = richView();
    scoped.ledger = scoped.ledger.map((entry) => ({ ...entry, projectSlug: "research-slp" }) as LedgerLineView);
    render(<ActivityScreen view={scoped} />);
    expect(screen.queryByText("· research-slp")).toBeNull();
  });

  it("renders the ledgerError as the stream's degraded notice", () => {
    const view = fixtureView();
    view.project = { ...view.projects[0]!, ledgerError: "ledger.jsonl: ENOENT" };
    render(<ActivityScreen view={view} />);
    expect(screen.getByText(/The Project ledger could not be opened \(ledger.jsonl: ENOENT\)/)).toBeTruthy();
  });

  it("renders the daemon-degraded line when the daemon half failed", () => {
    const view = richView();
    view.daemonError = "paseo daemon unreachable";
    render(<ActivityScreen view={view} />);
    expect(screen.getByText(/Live activity states are degraded \(paseo daemon unreachable\)/)).toBeTruthy();
  });

  it("renders No usage recorded when the snapshot carries no rollup — the honest null", () => {
    render(<ActivityScreen view={fixtureView()} />);
    expect(screen.getByText("No usage recorded", { selector: "h2" })).toBeTruthy();
    expect(screen.queryByText("By model")).toBeNull();
  });

  it("carries NO write buttons — the chips are the screen's only controls (T-11a, ADR 0017)", () => {
    render(<ActivityScreen view={richView()} />);
    // The eight filter chips are the only buttons; no retro/ratify act (T-11b),
    // no seat Start/Ensure, no textbox or input of any kind.
    const buttons = screen.getAllByRole("button");
    expect(buttons.every((button) => button.className.includes("filter"))).toBe(true);
    expect(buttons).toHaveLength(8);
    for (const word of ["Run Retro", "Ratify", "Start Supervisor", "Start Lead", "Ensure"]) {
      expect(screen.queryByRole("button", { name: new RegExp(word, "i") }), word).toBeNull();
    }
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(document.querySelector("input")).toBeNull();
  });
});
