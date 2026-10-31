/** Actual plugin lifetime: a completion created after boot must reach Supervisor without a restart. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import contribute from "../../plugin/index.server.ts";
import {
  resolveProject,
  writeProjectRegistration,
} from "../../plugin/server/core/project.ts";
import { saveLanes } from "../../plugin/server/core/lanes.ts";
import { switchExecution } from "../../plugin/server/core/scrum/execution.ts";
import { ensureScrumConfig } from "../../plugin/server/core/scrum/config.ts";
import {
  createScrumRun,
  commandRun,
  readRun,
} from "../../plugin/server/core/scrum/run-journal.ts";
import {
  readLeadMailbox,
  enqueueLeadMail,
} from "../../plugin/server/core/mailbox.ts";
const home = process.env.PASEO_HOME!,
  state = join(home, "plugin-state/paseo-factory");
const root = join(home, "workspace");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "README.md"), "fixture");
execFileSync("git", ["init", "-q", root]);
execFileSync(
  "git",
  ["-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", "add", "."],
  { cwd: root },
);
execFileSync(
  "git",
  [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ],
  { cwd: root },
);
const project = resolveProject(root);
assert.ok(project.ok);
if (!project.ok) throw Error("project");
saveLanes(state, { supervisor: "pi/test", lead: "pi/test" });
await switchExecution({
  state,
  slug: project.slug,
  mode: "scrum",
  blockers: [],
  rotate: async () => {},
});
const config = ensureScrumConfig(state, project.slug);
writeProjectRegistration(state, project.slug, {
  root: project.root,
  supervisor: "sup",
  lead: "lead",
});
// An unrelated SLP mailbox must not be periodically dispatched by the new pump.
const slpRoot = join(home, "slp");
mkdirSync(slpRoot);
execFileSync("git", ["init", "-q", slpRoot]);
writeProjectRegistration(state, "slp", { root: slpRoot, lead: "slp-lead" });
const handlers = new Map<string, (input: any, context: any) => any>();
const server = {
  on: () => () => {},
  before: () => () => {},
  handle: (contract: { name: string }, handler: any) =>
    handlers.set(contract.name, handler),
} as unknown as Parameters<typeof contribute>[0];
const sent: string[] = [];
const sup = {
  id: "sup",
  provider: "pi/test",
  model: "test",
  status: "idle",
  archivedAt: null,
  cwd: root,
  labels: {
    seat: "supervisor",
    project: project.slug,
    execution: "scrum",
    scrumConfigRevision: String(config.configRevision ?? 1),
  },
};
const lead = { ...sup, id: "lead", labels: { ...sup.labels, seat: "lead" } };
const daemon = {
  agents: {
    list: async ({ filter }: any = {}) => ({
      entries: [sup, lead]
        .filter(
          (agent) =>
            !filter?.labels ||
            Object.entries(filter.labels).every(
              ([k, v]) => (agent.labels as any)[k] === v,
            ),
        )
        .map((agent) => ({ agent })),
    }),
    ref: () => ({
      send: async (text: string) => {
        sent.push(text);
      },
    }),
  },
  providers: { list: async () => [] },
};
const stop = contribute(server);
try {
  await handlers.get("factory.snapshot")!({}, { paseo: daemon });
  await new Promise((done) => setTimeout(done, 100));
  enqueueLeadMail(join(state, "projects", project.slug, "mailbox.jsonl"), {
    from: "owner",
    kind: "directive",
    text: "held Scrum batch must remain event-driven",
  });
  enqueueLeadMail(join(state, "projects/slp/mailbox.jsonl"), {
    from: "owner",
    kind: "directive",
    text: "must remain event-driven",
  });
  let run = createScrumRun({
    state,
    slug: project.slug,
    runId: "late",
    initiativeId: "late",
    config,
    configRevision: 1,
    track: "small",
    rationale: "periodic recovery scheduling fixture",
    requestId: "create",
  });
  // The completion predicate has its own real-product integration test. Seed
  // its durable output here after startup to isolate the runtime delivery seam.
  run = commandRun(state, project.slug, run.runId, {
    type: "completion_requested",
    actor: "lead",
    requestId: "complete",
    expectedRevision: run.revision,
  });
  commandRun(state, project.slug, run.runId, {
    type: "phase_changed",
    phase: "completed",
    reason: "verified by fixture",
    requestId: "completed",
    expectedRevision: run.revision,
  });
  const deadline = Date.now() + 4500;
  while (!readRun(state, project.slug, run.runId).completionReported) {
    assert.ok(
      Date.now() < deadline,
      "late completion must report during this lifetime",
    );
    await new Promise((done) => setTimeout(done, 25));
  }
  const mailbox = readLeadMailbox(
    join(state, "projects", project.slug, "mailbox.jsonl"),
  );
  assert.ok(
    [
      ...mailbox.supervisorQueued,
      ...(mailbox.supervisorInFlight?.items ?? []),
    ].some((m) => m.reportType === "completed"),
  );
  await new Promise((done) => setTimeout(done, 1200));
  assert.equal(
    readLeadMailbox(join(state, "projects/slp/mailbox.jsonl")).queued.length,
    1,
  );
  assert.equal(
    readLeadMailbox(join(state, "projects", project.slug, "mailbox.jsonl"))
      .queued.length,
    1,
  );
  assert.equal(
    sent.length,
    1,
    "receipt prevents a second periodic completion report",
  );
  // Persisted command output simulates a crash before mailbox delivery. A
  // late intent on an ordinary active run must be selected by the live pump.
  const waiting = createScrumRun({ state, slug: project.slug, runId: "late-question", initiativeId: "late-question", config, configRevision: 1, track: "quick", rationale: "late Owner question", requestId: "create-question" });
  commandRun(state, project.slug, waiting.runId, { type: "owner_requested", requestId: "ask", expectedRevision: waiting.revision, request: { id: "q-late", kind: "question", question: "Choose semantics", affected: [{ kind: "task", id: "held" }], origin: { actor: "lead", role: "lead" }, status: "pending", createdAt: "" } });
  const questionDeadline = Date.now() + 3500;
  while (!readRun(state, project.slug, waiting.runId).wakeups?.every(w => w.delivered)) {
    assert.ok(Date.now() < questionDeadline, "late Owner question notification must recover without another command or restart");
    await new Promise(done => setTimeout(done, 25));
  }
  const pendingQuestions = () => readLeadMailbox(join(state, "projects", project.slug, "mailbox.jsonl")).supervisorQueued.filter(mail => mail.text.includes("q-late"));
  assert.equal(pendingQuestions().length, 1, "question reaches the existing Supervisor mailbox despite its unacknowledged completion turn");
  await new Promise(done => setTimeout(done, 1100));
  assert.equal(pendingQuestions().length, 1, "unchanged pending questions stay quiet");
  assert.equal(sent.length, 1, "queued question does not interrupt an unacknowledged Supervisor turn");
  console.log("SCRUM_LIVE_RECOVERY_OK");
} finally {
  stop();
}
