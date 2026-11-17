import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFactory } from "../plugin/server/core/factory.ts";
import { projectStateDir, resolveProject, writeProjectRegistration } from "../plugin/server/core/project.ts";
import { prepareTaskWorktree } from "../plugin/server/core/workspace.ts";
import { createLeadMailRuntime, type LeadTurnEndedInput } from "../plugin/server/lead-mailbox.ts";
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { parseHandoffFile } from "../plugin/server/handoff-text.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

type Refetch = ReturnType<SurfaceDaemonApi["agents"]["ref"]>["timeline"]["refetch"];

function fixture(t: TestContext, seat: "lead" | "supervisor" | "peer") {
  const dir = makeTempDir(); disposeDir(t, dir);
  const root = join(dir, "repo"); mkdirSync(root); writeFileSync(join(root, "README.md"), "fixture\n"); gitCommitAll(root);
  const project = resolveProject(root); assert.ok(project.ok);
  const stateDir = join(dir, "state"), factory = createFactory({ stateDir });
  writeProjectRegistration(stateDir, project.slug, { root, lead: "lead", supervisor: "supervisor" });
  let cwd = root;
  if (seat === "peer") {
    factory.setContract({ task: "T-01", workspace: root, gate: "true", description: "Preserve this work" });
    const tree = prepareTaskWorktree({ stateDir, workspace: root, task: "T-01" }); assert.ok(tree.ok); cwd = tree.path;
    factory.requestSpawn({ task: "T-01", provider: "pi/model", arity: 1, worktree: cwd });
  }
  const agents: SurfaceAgentSnapshot[] = ["lead", "supervisor", ...(seat === "peer" ? ["peer"] : [])].map(id => ({
    id, provider: "pi/model", title: id, status: "idle", model: null, archivedAt: null, requiresAttention: false,
    attentionReason: null, updatedAt: "", cwd: id === "peer" ? cwd : root,
    labels: { seat: id === "peer" ? "agent" : id, project: project.slug, ...(id === "peer" ? { task: "T-01" } : {}) },
    lastUsage: id === "peer" ? { contextWindowUsedTokens: 210_000 } : null,
  }));
  const sent: { id: string; text: string }[] = [], archived: string[] = [], logs: string[] = [];
  let refetch: Refetch = async () => ({ entries: [] });
  let created = 0;
  const daemon: SurfaceDaemonApi = { agents: {
    list: async () => ({ entries: agents.filter(a => !a.archivedAt).map(agent => ({ agent })) }),
    create: async input => { const id = `successor-${++created}`; agents.push({ ...agents[0]!, id, cwd: input.cwd, labels: input.labels, archivedAt: null, lastUsage: null }); if (input.prompt) sent.push({ id, text: input.prompt }); return { id }; },
    ref: id => ({ send: async text => { sent.push({ id, text }); }, archive: async () => { archived.push(id); agents.find(a => a.id === id)!.archivedAt = "archived"; return { archivedAt: "archived" }; }, timeline: { refetch: options => refetch(options) } }),
  }, providers: { listAvailable: async () => ({ providers: [] }), listModels: async () => ({ models: [] }) } };
  const surface = createSurfaceHandlers({ factory, stateDir, home: dir, daemon, handoff: input => runtime.handoff(input), stopAgent: async () => ({ ok: true }) });
  const runtime = createLeadMailRuntime({ factory, stateDir, home: dir, daemon, ensureLead: input => surface.leadEnsure(input), retireLead: input => surface.leadRotate(input), stopAgent: async () => ({ ok: true }), onLog: text => logs.push(text) });
  t.after(() => runtime.stop());
  const start = async () => {
    if (seat === "peer") await runtime.onLeadTurnEnded({ agentId: seat, outcome: { kind: "completed" }, timeline: [] });
    else { const result = await surface.handoff({ projectRoot: root, seat }, "start"); assert.ok(result.ok); }
  };
  const finish = (input: Partial<LeadTurnEndedInput> = {}) => runtime.onLeadTurnEnded({ agentId: seat, outcome: { kind: "completed" }, ...input });
  const body = () => parseHandoffFile(readFileSync(join(projectStateDir(stateDir, project.slug), seat === "peer" ? "peer-handoff-T-01.md" : `${seat}-handoff.md`), "utf8")).body;
  return { start, finish, body, sent, archived, logs, setRefetch: (value: Refetch) => { refetch = value; } };
}

test("Supervisor completion with an undefined timeline refetches and delivers its handoff", { timeout: 15_000 }, async t => {
  const f = fixture(t, "supervisor");
  f.setRefetch(async () => ({ entries: [{ item: { type: "assistant_message", text: "# Owner goals\nContinue the approved work." } }] }));
  await f.start(); await f.finish();
  assert.match(f.body(), /Continue the approved work/);
  assert.ok(f.sent.some(s => s.id === "successor-1" && s.text.includes("Continue the approved work")), f.logs.join("\n"));
});

for (const seat of ["lead", "peer"] as const) test(`${seat} completion with an undefined timeline preserves the refetched handoff`, { timeout: 15_000 }, async t => {
  const f = fixture(t, seat);
  f.setRefetch(async () => ({ entries: [{ item: { type: "assistant_message", text: "# Verified progress\nResume this exact slice." } }] }));
  await f.start(); await f.finish();
  assert.match(f.body(), /Resume this exact slice/);
  assert.ok(f.sent.some(s => s.id === "successor-1" && s.text.includes("Resume this exact slice")), f.logs.join("\n"));
  assert.ok(f.archived.includes(seat));
});

for (const seat of ["lead", "supervisor", "peer"] as const) test(`${seat} recovers only the completed turn from whole-turn history`, { timeout: 15_000 }, async t => {
  const f = fixture(t, seat), calls: unknown[] = [];
  f.setRefetch(async options => { calls.push(options); return { entries: [
    { turnId: "completed", item: { type: "user_message", text: "Extract handoff" } },
    { turnId: "completed", item: { type: "assistant_message", text: "# Correct turn\nKeep the verified work." } },
    { turnId: "later", item: { type: "assistant_message", text: "# Unrelated turn\nDo something else." } },
  ] }; });
  await f.start(); await f.finish({ turnId: "completed" });
  assert.match(f.body(), /Correct turn/); assert.doesNotMatch(f.body(), /Unrelated turn/);
  assert.deepEqual(calls, [{ direction: "tail", limit: 1, wholeTurns: true }]);
});

for (const legacy of [false, true]) test(`${legacy ? "legacy" : "modern"} lifecycle hook accepts its host's turn payload`, { timeout: 15_000 }, t => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-recovery-boot.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "fixture-home"), RECOVERY_ACTION: "resume", RECOVERY_PROJECT: "no", RECOVERY_LEGACY_SERVER: legacy ? "yes" : "no", TURN_HOOK_HANDOFF_TEST: "yes" },
    encoding: "utf8", timeout: 12_000,
  });
  assert.match(output, /RECOVERY_OK/);
  assert.match(output, /TURN_HOOK_HANDOFF_OK/);
});

for (const seat of ["lead", "supervisor", "peer"] as const) test(`${seat} builds a substitute when the timeline and extraction reply are absent`, { timeout: 15_000 }, async t => {
  const f = fixture(t, seat);
  await f.start(); await f.finish();
  assert.match(f.body(), /Plugin-built handover/);
  assert.ok(f.sent.some(s => s.id === "successor-1" && s.text.includes("Plugin-built handover")), f.logs.join("\n"));
});

for (const seat of ["lead", "supervisor", "peer"] as const) {
  test(`${seat} uses the legacy tail directly for a null turn identity`, { timeout: 15_000 }, async t => {
    const f = fixture(t, seat), calls: unknown[] = [];
    f.setRefetch(async options => { calls.push(options); return { entries: [{ item: { type: "assistant_message", text: "# Legacy handoff\nContinue without turn identities." } }] }; });
    await f.start(); await f.finish({ turnId: null });
    assert.match(f.body(), /Legacy handoff/);
    assert.deepEqual(calls, [{ direction: "tail", limit: 20 }]);
  });

  for (const mode of ["ignored", "untagged", "rejected"] as const) test(`${seat} recovers a handoff when wholeTurns is ${mode}`, { timeout: 15_000 }, async t => {
    const f = fixture(t, seat), calls: unknown[] = [];
    f.setRefetch(async options => {
      calls.push(options);
      if (options?.wholeTurns) {
        if (mode === "rejected") throw new Error("unknown option wholeTurns");
        return { entries: [{ ...(mode === "ignored" ? { turnId: "completed" } : {}), item: { type: "turn_completed" } }] };
      }
      return { entries: [
        { ...(mode === "untagged" ? {} : { turnId: "completed" }), item: { type: "assistant_message", text: "# Recovered handoff\nKeep the approved plan." } },
        ...(mode === "untagged" ? [] : [{ turnId: "later", item: { type: "assistant_message", text: "# Wrong handoff\nUnrelated work." } }]),
      ] };
    });
    await f.start(); await f.finish({ turnId: "completed" });
    assert.match(f.body(), /Recovered handoff/); assert.doesNotMatch(f.body(), /Wrong handoff/);
    assert.deepEqual(calls, [{ direction: "tail", limit: 1, wholeTurns: true }, { direction: "tail", limit: 20 }]);
  });

  test(`${seat} keeps supplied legacy event timelines working`, { timeout: 15_000 }, async t => {
    const f = fixture(t, seat);
    let reads = 0;
    f.setRefetch(async () => { reads++; return { entries: [] }; });
    await f.start(); await f.finish({ timeline: [{ type: "assistant_message", text: "# Inline handoff\nRetain the legacy reply." }] });
    assert.match(f.body(), /Inline handoff/); assert.equal(reads, 0);
  });

  test(`${seat} filters substitute evidence after a failed extraction without a timeline`, { timeout: 15_000 }, async t => {
    const f = fixture(t, seat), calls: unknown[] = [];
    f.setRefetch(async options => { calls.push(options); return { entries: [
      { turnId: "failed", item: { type: "assistant_message", text: "Evidence from the failed extraction" } },
      { turnId: "later", item: { type: "assistant_message", text: "Unrelated later evidence" } },
    ] }; });
    await f.start(); await f.finish({ outcome: { kind: "failed" }, turnId: "failed" });
    assert.match(f.body(), /Plugin-built handover/); assert.match(f.body(), /Evidence from the failed extraction/);
    assert.doesNotMatch(f.body(), /Unrelated later evidence/);
    assert.deepEqual(calls, [{ direction: "tail", limit: 1, wholeTurns: true }]);
  });
}
