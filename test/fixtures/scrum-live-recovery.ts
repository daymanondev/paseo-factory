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
const daemon = {
  agents: {
    list: async ({ filter }: any = {}) => ({
      entries:
        !filter?.labels ||
        Object.entries(filter.labels).every(
          ([k, v]) => (sup.labels as any)[k] === v,
        )
          ? [{ agent: sup }]
          : [],
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
    sent.length,
    1,
    "receipt prevents a second periodic completion report",
  );
  console.log("SCRUM_LIVE_RECOVERY_OK");
} finally {
  stop();
}
