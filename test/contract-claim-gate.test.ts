/**
 * Ticket 01 (factory-v0.5.0, ADR 0054 §1) — the mechanical 4-Part Brief Gate
 * and read-only Contract normalization on `lead_set_contract` / `setContract`:
 *
 * - structured Brief fields (`outcome`, `invariants`, `exclusions`,
 *   `verification`) synthesize the canonical 4-section `Contract.description`
 *   when `description` is omitted/empty;
 * - in slp mode (`seat === "lead"`, no Scrum `execution` binding) the resolved
 *   description must be non-empty, `<= 2,500` chars, and carry all four
 *   canonical section markers — else `invalid-contract` names the missing
 *   section(s);
 * - `gate` is mandatory for `engineer` and optional (default `""`) for the
 *   read-only three (`scout | architect | reviewer`);
 * - a read-only disposition refuses `artifact` and normalizes `scope` to `[]`;
 * - Owner/Supervisor/Agent seats and Scrum-binding Contracts stay outside the
 *   4-Part law, and historical gate-only `contract_set` lines replay cleanly.
 *
 * Verified at the two pre-agreed seams (spec Testing Decision Seam 1): the
 * core Factory lifecycle and end-to-end `bridge.mjs` JSON-RPC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { CorrelationRegistry } from "../src/correlations.ts";
import { ensureProjectRegistered } from "../src/project.ts";
import { createFactoryRegistry } from "../plugin/server/projects.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { projectTask } from "../src/task-state.ts";
import { foldTasks } from "../plugin/server/view.ts";
import { FactoryError } from "../plugin/server/core/errors.ts";
import type { ContractSet } from "../src/events.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const BRIDGE_BIN = resolve(import.meta.dirname, "../plugin/bin/bridge.mjs");

/** A description that satisfies all four canonical section markers. */
const FOUR_PART_BRIEF = [
  "1. Bounded Outcome",
  "The slice lands the adapter boundary with one journey test.",
  "",
  "2. Contract Boundary & Regression Invariants",
  "Existing HEAD tests stay green; the seam contract is fixed.",
  "",
  "3. Excluded / Deferred",
  "Deferred: the retry-policy tuning.",
  "",
  "4. Verification",
  "npm test -- adapter",
].join("\n");

function makeRepo(dir: string): string {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# repo\n");
  writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
  gitCommitAll(repo);
  return repo;
}

function invalidContract(thunk: () => unknown): FactoryError {
  try {
    thunk();
  } catch (error) {
    assert.ok(error instanceof FactoryError, `expected FactoryError, got ${String(error)}`);
    assert.equal((error as FactoryError).code, "invalid-contract");
    return error as FactoryError;
  }
  throw new Error("expected setContract to refuse with invalid-contract, but it accepted");
}

test("ticket 01: structured Brief fields synthesize the canonical 4-section description with the read-only Verification default (spec Implementation Decision 1)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // seat lead + scout: no gate, no description, no artifact — only the four
  // structured fields (verification omitted so the read-only default applies).
  const evt = factory.setContract({
    task: "SYN-1",
    workspace,
    gate: "",
    seat: "lead",
    disposition: "scout",
    outcome: "Map the module boundaries and the seam the next wave targets.",
    invariants: "Existing HEAD interfaces stay untouched.",
    exclusions: "Excluded: any code change.",
  });

  assert.equal(evt.gate, "", "an empty gate is recorded verbatim on a read-only disposition");
  assert.equal(evt.description, [
    "1. Bounded Outcome",
    "Map the module boundaries and the seam the next wave targets.",
    "",
    "2. Contract Boundary & Regression Invariants",
    "Existing HEAD interfaces stay untouched.",
    "",
    "3. Excluded / Deferred",
    "Excluded: any code change.",
    "",
    "4. Verification",
    "Read-only disposition (scout) — 6-Field Handoff with file:line evidence; worktree must remain clean at HEAD.",
  ].join("\n"));
  assert.equal(factory.contractFor("SYN-1")?.description, evt.description, "the synthesized Brief is the recorded Contract.description");
  assert.equal("scope" in evt, false, "read-only Contracts record no scope");
  assert.equal("artifact" in evt && evt.artifact !== "", false, "read-only Contracts record no artifact");
});

test("ticket 01: the 4-Part Brief gate refuses an empty, over-cap, or section-missing description for lead Contracts in slp mode, naming the missing section(s) (ADR 0054 §1)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // 1. No description and no structured fields — the bare-gate bypass the
  //    audit caught (spec Problem 1) is closed.
  const bare = invalidContract(() => factory.setContract({ task: "GATE-A", workspace, gate: "true", seat: "lead" }));
  assert.match(bare.message, /4-Part Brief/i);
  assert.match(bare.message, /Bounded Outcome/);

  // 2. A description present but missing three of the four sections names
  //    exactly those sections.
  const partial = invalidContract(() =>
    factory.setContract({ task: "GATE-B", workspace, gate: "true", seat: "lead", description: "Bounded Outcome: just the outcome text." }),
  );
  assert.match(partial.message, /Contract Boundary & Regression Invariants/);
  assert.match(partial.message, /Excluded \/ Deferred/);
  assert.match(partial.message, /Verification/);
  assert.doesNotMatch(partial.message, /missing section\(s\): 1\. Bounded Outcome/);

  // 3. The 2,500-char cap (LEAD_WAVE_LAWS) is mechanical, not prose.
  const overCap = FOUR_PART_BRIEF + "\n" + "padding".repeat(600);
  assert.ok(overCap.length > 2500);
  const capped = invalidContract(() => factory.setContract({ task: "GATE-C", workspace, gate: "true", seat: "lead", description: overCap }));
  assert.match(capped.message, /2,500/);

  // 4. A complete 4-part description passes, and a structured-field synthesis
  //    that overflows the cap is refused by the same law.
  const ok = factory.setContract({ task: "GATE-D", workspace, gate: "true", seat: "lead", description: FOUR_PART_BRIEF });
  assert.equal(ok.description, FOUR_PART_BRIEF);
  const fatSynthesis = invalidContract(() =>
    factory.setContract({ task: "GATE-E", workspace, gate: "true", seat: "lead", outcome: "x".repeat(2600), invariants: "i", exclusions: "e", verification: "v" }),
  );
  assert.match(fatSynthesis.message, /2,500/);
});

test("ticket 01: gate is mandatory for engineer and optional for the read-only three (spec User Stories 5–6)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // engineer (default): the pre-0054 refusal stands.
  const engineer = invalidContract(() => factory.setContract({ task: "OPT-A", workspace, gate: "  ", seat: "lead", description: FOUR_PART_BRIEF }));
  assert.match(engineer.message, /gate command must be a non-empty string/);
  const engineerOmitted = invalidContract(() => factory.setContract({ task: "OPT-B", workspace, gate: "", seat: "lead", disposition: "engineer", description: FOUR_PART_BRIEF }));
  assert.match(engineerOmitted.message, /gate command must be a non-empty string/);

  // the read-only three: an omitted/empty gate defaults to "" and never refuses.
  for (const disposition of ["scout", "architect", "reviewer"] as const) {
    const evt = factory.setContract({
      task: `OPT-${disposition.toUpperCase()}`,
      workspace,
      gate: "",
      seat: "lead",
      disposition,
      outcome: "o",
      invariants: "i",
      exclusions: "e",
      verification: "v",
    });
    assert.equal(evt.gate, "", `${disposition}: empty gate recorded as ""`);
    // A non-empty gate on a read-only disposition still executes as usual (spec User Story 8).
    factory.setContract({ task: `OPT-${disposition.toUpperCase()}-G`, workspace, gate: "true", seat: "lead", disposition, outcome: "o", invariants: "i", exclusions: "e", verification: "v" });
  }
});

test("ticket 01: a read-only disposition refuses artifact and normalizes scope to [] on the recorded contract_set line (ADR 0054 §1)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  const refused = invalidContract(() =>
    factory.setContract({ task: "NORM-A", workspace, gate: "", seat: "lead", disposition: "architect", artifact: "docs/plan.md", outcome: "o", invariants: "i", exclusions: "e", verification: "v" }),
  );
  assert.match(refused.message, /read-only disposition \(architect\) cannot require an output artifact/);

  // Supplied scope is normalized away: the recorded line carries no scope.
  const evt = factory.setContract({
    task: "NORM-B",
    workspace,
    gate: "",
    seat: "lead",
    disposition: "reviewer",
    scope: ["src/", "docs/"],
    outcome: "o",
    invariants: "i",
    exclusions: "e",
    verification: "v",
  });
  assert.equal("scope" in evt, false, "a read-only Contract records no scope even when one was supplied");
  assert.equal(factory.contractFor("NORM-B")?.scope, undefined);

  // An engineer Contract keeps its artifact and scope (the law is read-only-only).
  const writable = factory.setContract({ task: "NORM-C", workspace, gate: "true", seat: "lead", artifact: "src/x.ts", scope: ["src/"], description: FOUR_PART_BRIEF });
  assert.equal(writable.artifact, "src/x.ts");
  assert.deepEqual(writable.scope, ["src/"]);
});

test("ticket 01: the 4-Part law scopes to seat lead in slp mode — Supervisor/Agent seats and Scrum bindings never trigger it (spec Implementation Decision 1)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // Owner/unstamped seat: the historical gate-only Contract stays valid.
  const owner = factory.setContract({ task: "SCOPE-A", workspace, gate: "true" });
  assert.equal(owner.description, undefined);

  // Supervisor and Agent seats with no description at all: no 4-Part refusal.
  factory.setContract({ task: "SCOPE-B", workspace, gate: "true", seat: "supervisor" });
  factory.setContract({ task: "SCOPE-C", workspace, gate: "true", seat: "agent" });

  // A lead seat WITH a Scrum execution binding: the specialist-role workflow is
  // out of the law's scope (spec Out of Scope) — no 4-Part refusal.
  factory.setContract({
    task: "SCOPE-D",
    workspace,
    gate: "true",
    seat: "lead",
    execution: { mode: "scrum", runId: "run-1", role: "dev", policyRevision: "rev-1", configRevision: 1, artifactRefs: [] },
  });
  assert.equal(factory.contractFor("SCOPE-D")?.description, undefined);
});

test("ticket 01: historical gate-only contract_set events replay and project without retroactive validation (spec User Story 3)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const stateDir = join(dir, "state");

  // A pre-0054-shaped epoch: gate only — no description, no structured fields,
  // no disposition — written by the first factory instance, then replayed from
  // disk by a second (Ledger.open recovery is the historical-replay path).
  const first = createFactory({ stateDir });
  first.setContract({ task: "HIST-1", workspace, gate: "npm test" });
  const second = createFactory({ stateDir });
  const contract = second.contractFor("HIST-1") as ContractSet;
  assert.ok(contract, "the gate-only contract replays");
  assert.equal(contract.description, undefined, "no Brief was synthesized for a historical line");
  assert.equal(contract.gate, "npm test");

  // A raw, hand-written pre-0054 ledger fixture also opens and projects —
  // exactly the lines an upgraded live Project would carry.
  const slugDir = join(dir, "hist2", "projects", "legacy-abc123");
  mkdirSync(slugDir, { recursive: true });
  const legacyLine = {
    seq: 1,
    ts: "2025-01-01T00:00:00.000Z",
    event: "contract_set",
    task: "LEGACY-1",
    workspace,
    gate: "npm test",
    artifact: "",
  };
  writeFileSync(join(slugDir, "ledger.jsonl"), `${JSON.stringify(legacyLine)}\n`);
  const legacyFactory = createFactory({ stateDir: join(dir, "hist2"), projectSlug: "legacy-abc123" });
  const projected = projectTask(legacyFactory.ledger.events, "LEGACY-1");
  assert.equal(projected.status, "waiting", "the legacy epoch projects with no attempt");
  assert.equal(projected.contract?.gate, "npm test");
  const folded = foldTasks(legacyFactory.ledger.events);
  assert.equal(folded.length, 1, "foldTasks projects the legacy Task");
  assert.equal(folded[0]?.task, "LEGACY-1");
});

test("ticket 01: the 4-Part Brief gate and optional read-only gate hold end-to-end through bridge.mjs JSON-RPC (spec Seam 1)", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-contract-gate-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeRepo(homeDir);
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(reg.ok);
  const registry = createFactoryRegistry({ stateDir, root: factory });
  const fakeDaemon = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({ send: async () => ({ messageId: `msg-${id}` }), cancel: async () => {}, archive: async () => {} }),
    },
  };
  const spool = startSpool(stateDir, factory, { registry, pollMs: 10, daemon: fakeDaemon as never, home: homeDir });
  t.after(() => spool.stop());

  const lead = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: reg.ok ? reg.slug : "demo", projectRoot: repoDir, agentId: "lead-gate" });

  const session = async (requests: Array<Record<string, unknown>>) => {
    const child = spawn(process.execPath, [BRIDGE_BIN, "--correlation", lead.correlationId, "--state-dir", stateDir], {
      cwd: repoDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses: Array<Record<string, unknown>> = [];
    let buf = Buffer.alloc(0);
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const done = new Promise<Array<Record<string, unknown>>>((resolveDone, rejectDone) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectDone(new Error(`bridge session timed out; stderr=${stderr}`));
      }, 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.subarray(0, nl).toString("utf8").trim();
          buf = buf.subarray(nl + 1);
          if (line !== "") {
            try {
              responses.push(JSON.parse(line));
            } catch { /* skip non-JSON noise */ }
          }
          nl = buf.indexOf("\n");
        }
        if (responses.length >= requests.length) {
          clearTimeout(timer);
          child.kill();
          resolveDone(responses);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolveDone(responses);
      });
      let sent = 0;
      const pump = () => {
        while (sent < requests.length) {
          child.stdin.write(`${JSON.stringify(requests[sent])}\n`);
          sent += 1;
        }
      };
      pump();
    });
    return done;
  };

  const textOf = (response: Record<string, unknown>): { isError?: boolean; text: string } => {
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> } | undefined;
    assert.ok(result, `expected a result, got ${JSON.stringify(response)}`);
    return { isError: result.isError, text: result.content[0]?.text ?? "" };
  };

  // 0. The Lead schema advertises the structured Brief fields, and `gate` is
  //    no longer required (criterion 1/4).
  const [listed, ok, refused, engineer] = await session([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "E2E-RO", disposition: "architect", outcome: "Design the boundary.", invariants: "HEAD stays green.", exclusions: "No code changes." } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "E2E-BAD", gate: "true", description: "Only an outcome, nothing else." } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "E2E-ENG", gate: "", description: FOUR_PART_BRIEF } } },
  ]);
  const contractTool = ((listed.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }> }).tools)
    .find((tool) => tool.name === "lead_set_contract");
  assert.ok(contractTool, "lead_set_contract is listed for the Lead seat");
  for (const field of ["outcome", "invariants", "exclusions", "verification"]) {
    assert.equal((contractTool.inputSchema.properties[field] as { type?: string })?.type, "string", `the schema advertises ${field}`);
  }
  assert.ok(contractTool.inputSchema.properties.gate, "gate stays an advertised property");
  assert.equal((contractTool.inputSchema.required ?? []).includes("gate"), false, "gate is no longer a required property");

  // 1. A structured-field, gate-less architect Contract succeeds and lands a
  //    synthesized 4-section Brief on the Project ledger.

  const okResult = textOf(ok);
  assert.notEqual(okResult.isError, true, okResult.text);
  const project = reg.ok ? reg.slug : "demo";
  const contractLine = readFileSync(join(stateDir, "projects", project, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((e) => e.event === "contract_set" && e.task === "E2E-RO");
  assert.ok(contractLine, "the read-only contract landed on the Project ledger");
  assert.equal(contractLine.gate, "", "no dummy gate was demanded end-to-end");
  assert.match(contractLine.description, /1\. Bounded Outcome/);
  assert.match(contractLine.description, /2\. Contract Boundary & Regression Invariants/);
  assert.match(contractLine.description, /3\. Excluded \/ Deferred/);
  assert.match(contractLine.description, /4\. Verification/);
  assert.match(contractLine.description, /Read-only disposition \(architect\) — 6-Field Handoff with file:line evidence; worktree must remain clean at HEAD\./);

  // 2. A section-missing description is refused with invalid-contract naming
  //    the missing sections (the spec's end-to-end Seam 1 assertion).
  const refusedResult = textOf(refused);
  assert.equal(refusedResult.isError, true, "a section-missing Brief must be refused");
  assert.match(refusedResult.text, /invalid-contract/);
  assert.match(refusedResult.text, /Contract Boundary & Regression Invariants/);

  // 3. The engineer disposition still requires a non-empty gate end-to-end.
  const engineerResult = textOf(engineer);
  assert.equal(engineerResult.isError, true, "an engineer Contract with an empty gate must be refused");
  assert.match(engineerResult.text, /invalid-contract/);
  assert.match(engineerResult.text, /gate command must be a non-empty string/);
});
