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

test("panel projects cumulative usage and ranks models by share without exposing cost", () => {
  assert.deepEqual(foldPanel(input({ usage: recorded })).usage, {
    state: "recorded", newTokens: 130, cachedTokens: 170, cacheReadTokens: 120, totalTokens: 300, cacheHitPercent: 60, inputUncachedTokens: 30, outputTokens: 100, sessionCount: 2,
    seats: [{ seat: "agent", label: "Peer", newTokens: 130, cachedTokens: 170, cacheReadTokens: 120, inputUncachedTokens: 30, outputTokens: 100, totalTokens: 300, sessionCount: 2, sharePercent: 100 }],
    models: [
      { provider: "zai", model: "large", newTokens: 85, cachedTokens: 140, cacheReadTokens: 100, inputUncachedTokens: 20, outputTokens: 65, totalTokens: 225, sessionCount: 1, sharePercent: 75 },
      { provider: "openai", model: "small", newTokens: 45, cachedTokens: 30, cacheReadTokens: 20, inputUncachedTokens: 10, outputTokens: 35, totalTokens: 75, sessionCount: 1, sharePercent: 25 },
    ],
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

test("recorded sessions without input tokens have no cache-hit percentage and finite shares", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: { zero: session("zero", "openai", "zero", 0, 0, 0, 0) } } })).usage;
  assert.equal(usage?.state, "recorded");
  assert.equal(usage?.cacheHitPercent, null);
  assert.equal(usage?.models[0]?.sharePercent, 0);
});

test("seat and model rows group rotations and break equal gross totals deterministically", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: {
    watch: { ...session("watch", "zai", "b", 2, 5, 1, 2), seat: "watch" },
    supervisor: { ...session("supervisor", "openai", "z", 2, 5, 1, 2), seat: "supervisor" },
    peer: session("peer", "openai", "a", 2, 5, 1, 2),
    lead1: { ...session("lead1", "openai", "a", 2, 5, 1, 2), seat: "lead" },
    lead2: { ...session("lead2", "openai", "a", 2, 5, 1, 2), seat: "lead" },
  } } })).usage!;
  assert.deepEqual(usage.seats.map(row => [row.seat, row.label, row.totalTokens, row.sessionCount, row.sharePercent]), [
    ["lead", "Lead", 20, 2, 40], ["agent", "Peer", 10, 1, 20], ["supervisor", "Supervisor", 10, 1, 20], ["watch", "Watch", 10, 1, 20],
  ]);
  assert.deepEqual(usage.models.map(row => [row.provider, row.model, row.totalTokens, row.sessionCount, row.sharePercent]), [
    ["openai", "a", 30, 3, 60], ["openai", "z", 10, 1, 20], ["zai", "b", 10, 1, 20],
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
  assert.equal(zero.seats[0]?.sharePercent, 0);
  const output = foldPanel(input({ usage: cases[3] })).usage!;
  assert.equal(output.cacheHitPercent, null);
  assert.equal(output.newTokens, 12);
  assert.equal(output.models[0]?.sharePercent, 100);
});

test("equal model totals sort by model within the same provider independent of session order", () => {
  const usage = foldPanel(input({ usage: { ...recorded, sessions: {
    z: session("z", "openai", "z", 1, 2, 3, 4),
    a: session("a", "openai", "a", 1, 2, 3, 4),
  } } })).usage!;
  assert.deepEqual(usage.models.map(row => row.model), ["a", "z"]);
});
