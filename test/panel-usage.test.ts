import { test } from "node:test";
import assert from "node:assert/strict";
import { PanelUsageSchema, PanelViewSchema } from "../plugin/shared/view.ts";
import { foldPanel, type PanelInput } from "../plugin/server/panel.ts";
import type { ProjectUsageFile, SessionUsageRecord } from "../plugin/server/core/usage-status.ts";

function input(overrides: Partial<PanelInput> = {}): PanelInput {
  return { project: { slug: "project", root: "/project" }, registered: true, folder: "/project", git: { gitRepo: true, hasCommits: true }, tasks: [], agents: [], supervisor: null, lead: null, missingPrerequisites: [], openDesign: null, rotationState: null, handoffRequestedAt: null, heldSupervisorMailCount: 0, supervisorCandidates: [], now: 0, ...overrides };
}

const session = (agentId: string, provider: string, model: string, input: number, cacheRead: number, cacheWrite: number, output: number): SessionUsageRecord => ({
  agentId, projectSlug: "project", seat: "agent", provider, harness: provider, model,
  turns: 1, inputUncachedTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output,
  reasoningTokens: 0, totalTokens: input + cacheRead + cacheWrite + output, totalCostUsd: 1, updatedAt: "2026-11-15",
});

const recorded: ProjectUsageFile = { version: 1, projectSlug: "project", updatedAt: "2026-11-15", sessions: {
  small: session("small", "openai", "small", 10, 20, 10, 35),
  large: session("large", "zai", "large", 20, 100, 40, 65),
} };

test("panel projects cumulative usage and ranks models by newTokens without exposing cost", () => {
  const peerModels = [
    { provider: "zai", model: "large", newTokens: 85, cachedTokens: 140, cacheReadTokens: 100, inputUncachedTokens: 20, outputTokens: 65, totalTokens: 225, sessionCount: 1, cacheHitPercent: 63, sharePercent: (85 / 130) * 100 },
    { provider: "openai", model: "small", newTokens: 45, cachedTokens: 30, cacheReadTokens: 20, inputUncachedTokens: 10, outputTokens: 35, totalTokens: 75, sessionCount: 1, cacheHitPercent: 50, sharePercent: (45 / 130) * 100 },
  ];
  const windowAll = {
    state: "recorded" as const,
    newTokens: 130,
    cachedTokens: 170,
    cacheReadTokens: 120,
    totalTokens: 300,
    cacheHitPercent: 60,
    inputUncachedTokens: 30,
    outputTokens: 100,
    sessionCount: 2,
    seats: [{ seat: "agent", label: "Peer", newTokens: 130, cachedTokens: 170, cacheReadTokens: 120, inputUncachedTokens: 30, outputTokens: 100, totalTokens: 300, sessionCount: 2, cacheHitPercent: 60, sharePercent: 100, models: peerModels }],
    models: peerModels,
  };
  assert.deepEqual(foldPanel(input({ usage: recorded })).usage, {
    ...windowAll,
    windows: { all: windowAll, "7d": windowAll, "24h": windowAll },
  });
});

test("a scoped Project with absent or zero-session usage keeps an empty projection", () => {
  const expected = { state: "empty", newTokens: 0, cachedTokens: 0, cacheReadTokens: 0, totalTokens: 0, cacheHitPercent: null, inputUncachedTokens: 0, outputTokens: 0, sessionCount: 0, seats: [], models: [] };
  assert.deepEqual(foldPanel(input({ usage: null })).usage, expected);
  assert.deepEqual(foldPanel(input({ usage: { ...recorded, sessions: {} } })).usage, expected);
});

test("usage stays null when the panel is unscoped, unregistered, or unwired", () => {
  assert.equal(foldPanel(input({ project: null, usage: recorded })).usage, null);
  assert.equal(foldPanel(input({ registered: false, usage: recorded })).usage, null);
  assert.equal(foldPanel(input()).usage, null);
});

test("recorded zero-token sessions omit zero-token breakdown rows while keeping totals intact", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: { zero: session("zero", "openai", "zero", 0, 0, 0, 0) } } })).usage;
  assert.equal(usage?.state, "recorded");
  assert.equal(usage?.sessionCount, 1);
  assert.equal(usage?.cacheHitPercent, null);
  assert.deepEqual(usage?.seats, []);
  assert.deepEqual(usage?.models, []);
});

test("seat and model rows group rotations and break equal newTokens totals deterministically", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: {
    watch: { ...session("watch", "zai", "b", 2, 5, 1, 2), seat: "watch" },
    supervisor: { ...session("supervisor", "openai", "z", 2, 5, 1, 2), seat: "supervisor" },
    peer: session("peer", "openai", "a", 2, 5, 1, 2),
    lead1: { ...session("lead1", "openai", "a", 2, 5, 1, 2), seat: "lead" },
    lead2: { ...session("lead2", "openai", "a", 2, 5, 1, 2), seat: "lead" },
  } } })).usage!;
  assert.deepEqual(usage.seats.map(row => [row.seat, row.label, row.totalTokens, row.sessionCount, row.sharePercent, row.cacheHitPercent]), [
    ["lead", "Lead", 20, 2, 40, 63], ["agent", "Peer", 10, 1, 20, 63], ["supervisor", "Supervisor", 10, 1, 20, 63], ["watch", "Watch", 10, 1, 20, 63],
  ]);
  assert.deepEqual(usage.models.map(row => [row.provider, row.model, row.totalTokens, row.sessionCount, row.sharePercent, row.cacheHitPercent]), [
    ["openai", "a", 30, 3, 60, 63], ["openai", "z", 10, 1, 20, 63], ["zai", "b", 10, 1, 20, 63],
  ]);
});

test("usage and whole-panel schemas preserve complete empty, recorded, zero-total and output-only projections", () => {
  const cases: (ProjectUsageFile | null)[] = [null, recorded,
    { ...recorded, sessions: { zero: session("zero", "openai", "zero", 0, 0, 0, 0) } },
    { ...recorded, sessions: { output: session("output", "openai", "output", 0, 0, 0, 12) } },
  ];
  for (const usage of cases) {
    const panel = foldPanel(input({ usage }));
    assert.deepEqual(PanelUsageSchema.parse(panel.usage), panel.usage);
    assert.deepEqual(PanelViewSchema.parse(panel).usage, panel.usage);
    assert.ok(!JSON.stringify(panel.usage).includes("Cost"));
  }
  const zero = foldPanel(input({ usage: cases[2] })).usage!;
  assert.equal(zero.newTokens, 0);
  assert.equal(zero.cachedTokens, 0);
  assert.equal(zero.sessionCount, 1);
  assert.equal(zero.cacheHitPercent, null);
  assert.deepEqual(zero.seats, []);
  assert.deepEqual(zero.models, []);
  const output = foldPanel(input({ usage: cases[3] })).usage!;
  assert.equal(output.cacheHitPercent, null);
  assert.equal(output.newTokens, 12);
  assert.equal(output.models[0]?.sharePercent, 100);
  assert.equal(output.seats[0]?.models?.[0]?.sharePercent, 100);
});

test("equal model totals sort by model within the same provider independent of session order", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: {
    z: session("z", "openai", "z", 1, 2, 3, 4),
    a: session("a", "openai", "a", 1, 2, 3, 4),
  } } })).usage!;
  assert.deepEqual(usage.models.map(row => row.model), ["a", "z"]);
});

test("panel ranks by newTokens first, then totalTokens, then alphabetical", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: {
    heavyCacheLowNew: session("heavyCacheLowNew", "openai", "cached", 50, 10_000, 0, 50),
    higherNewLowTotal: session("higherNewLowTotal", "openai", "new", 400, 0, 0, 200),
  } } })).usage!;
  assert.deepEqual(usage.models.map(row => row.model), ["new", "cached"]);
});

test("panel computes 24h and 7d window cutoffs from input.now including empty windows", () => {
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const at = (iso: string, id: string, seat: SessionUsageRecord["seat"], inputTok: number, cacheRead: number, output: number): SessionUsageRecord => ({
    ...session(id, "openai", id, inputTok, cacheRead, 0, output),
    seat,
    updatedAt: iso,
  });
  const usage = foldPanel(input({
    now,
    usage: {
      version: 1,
      projectSlug: "project",
      updatedAt: "2026-11-24T12:00:00.000Z",
      sessions: {
        exact24h: at("2026-11-23T12:00:00.000Z", "exact24h", "agent", 100, 900, 50),
        inside7d: at("2026-11-18T12:00:00.000Z", "inside7d", "lead", 200, 800, 100),
        older: at("2026-11-10T12:00:00.000Z", "older", "supervisor", 300, 700, 200),
      },
    },
  })).usage!;
  assert.equal(usage.windows?.all.sessionCount, 3);
  assert.equal(usage.windows?.["7d"].sessionCount, 2);
  assert.deepEqual(usage.windows?.["7d"].seats.map(s => s.seat), ["lead", "agent"]);
  assert.equal(usage.windows?.["24h"].sessionCount, 1);
  assert.deepEqual(usage.windows?.["24h"].seats.map(s => s.seat), ["agent"]);

  const staleOnly = foldPanel(input({
    now,
    usage: {
      version: 1,
      projectSlug: "project",
      updatedAt: "2026-11-10T12:00:00.000Z",
      sessions: { older: at("2026-11-10T12:00:00.000Z", "older", "supervisor", 300, 700, 200) },
    },
  })).usage!;
  assert.equal(staleOnly.windows?.all.state, "recorded");
  assert.equal(staleOnly.windows?.["7d"].state, "empty");
  assert.equal(staleOnly.windows?.["24h"].state, "empty");
  assert.deepEqual(PanelUsageSchema.parse(staleOnly), staleOnly);
});

test("panel computes nested Peer -> models sharePercent relative to the seat and normalizes antigravity/glm/copilot", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: {
    peerA1: session("peerA1", "copilot", "GPT-6.1-SOL", 60, 0, 0, 15),
    peerA2: session("peerA2", "github-copilot", "gpt-6.1-sol", 0, 100, 0, 0),
    peerB: session("peerB", "zcode", "GLM-5.3", 20, 0, 0, 5),
    peerC: session("peerC", "zai", "glm-5.3", 0, 0, 0, 0),
    leadA: { ...session("leadA", "antigravity", "model-1525", 80, 0, 0, 20), seat: "lead" },
  } } })).usage!;
  // Peer new=100 total=200 (75 new copilot + 25 new zcode), Lead new=100 total=100 -> top-level seats 50/50, Peer first on totalTokens tie-break
  assert.deepEqual(usage.seats.map(s => [s.seat, s.sharePercent]), [["agent", 50], ["lead", 50]]);
  const peer = usage.seats.find(s => s.seat === "agent")!;
  assert.deepEqual(
    peer.models?.map(m => [m.provider, m.model, m.sessionCount, m.sharePercent]),
    [
      ["github-copilot", "gpt-6.1-sol", 2, 75],
      ["zcode", "glm-5.3", 1, 25],
    ],
  );
  const lead = usage.seats.find(s => s.seat === "lead")!;
  assert.equal(lead.models?.[0]?.model, "gemini-4-hydrogen-high");
  assert.equal(lead.models?.[0]?.sharePercent, 100);

  // Distinct routes zcode vs zai and thinking effort levels stay separate
  const distinct = foldPanel(input({ usage: { ...recorded, sessions: {
    zcode: session("zcode", "zcode", "GLM-5.3", 10, 0, 0, 10),
    zai: session("zai", "zai", "glm-5.3", 10, 0, 0, 10),
    high: session("high", "antigravity", "gemini-4-hydrogen-high", 10, 0, 0, 10),
    xhigh: session("xhigh", "antigravity", "gemini-4-hydrogen-xhigh", 10, 0, 0, 10),
  } } })).usage!;
  assert.deepEqual(
    distinct.models.map(m => `${m.provider}/${m.model}`),
    ["antigravity/gemini-4-hydrogen-high", "antigravity/gemini-4-hydrogen-xhigh", "zai/glm-5.3", "zcode/glm-5.3"],
  );
});
