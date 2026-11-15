import { test } from "node:test";
import assert from "node:assert/strict";
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
    state: "recorded", totalTokens: 300, cacheHitPercent: 60, inputUncachedTokens: 30, outputTokens: 100, sessionCount: 2,
    models: [
      { provider: "zai", model: "large", totalTokens: 225, sharePercent: 75 },
      { provider: "openai", model: "small", totalTokens: 75, sharePercent: 25 },
    ],
  });
});

test("a scoped Project with absent or zero-session usage keeps an empty projection", () => {
  const expected = { state: "empty", totalTokens: 0, cacheHitPercent: null, inputUncachedTokens: 0, outputTokens: 0, sessionCount: 0, models: [] };
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
