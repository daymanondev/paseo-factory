/**
 * Ticket 01 (factory-v0.5.0, ADR 0054 §1) — the mechanical 4-Part Brief Gate
 * and read-only Contract normalization on `lead_set_contract` / `setContract`:
 *
 * - structured Brief fields (`outcome`, `invariants`, `exclusions`,
 *   `verification`) synthesize the canonical 4-section `Contract.description`
 *   when `description` is omitted/empty;
 * - on the Lead seat (`seat === "lead"`) the resolved
 *   description must be non-empty, `<= 2,500` chars, and carry all four
 *   canonical section markers — else `invalid-contract` names the missing
 *   section(s);
 * - `gate` is mandatory for `engineer` and optional (default `""`) for the
 *   read-only three (`scout | architect | reviewer`);
 * - a read-only disposition refuses `artifact` and normalizes `scope` to `[]`;
 * - Owner/Supervisor/Agent seats stay outside the
 *   4-Part law, and historical gate-only `contract_set` lines replay cleanly.
 *
 * Verified at the two pre-agreed seams (spec Testing Decision Seam 1): the
 * core Factory lifecycle and end-to-end `bridge.mjs` JSON-RPC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { contractTimeoutMs, contractTimeoutSeconds } from "../plugin/server/core/constants.ts";
import type { ContractSet } from "../src/events.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

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

test("ticket 01: the 4-Part law scopes to seat lead — Owner/Supervisor/Agent seats never trigger it (spec Implementation Decision 1)", (t) => {
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
});

test("review: a supplied empty description refuses outside the 4-Part scope — the pre-v0.5.0 non-empty law stands for every other seat (ADR 0054 §1 scope)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // Unstamped (Owner) seat: "" and blank-only both refuse — omission is the
  // only way to say "no assignment text" (the pre-v0.5.0 law).
  const emptyOwner = invalidContract(() => factory.setContract({ task: "DESC-A", workspace, gate: "true", description: "" }));
  assert.match(emptyOwner.message, /description must be a non-empty string/);
  const blankOwner = invalidContract(() => factory.setContract({ task: "DESC-B", workspace, gate: "true", description: "   " }));
  assert.match(blankOwner.message, /description must be a non-empty string/);

  // A supervisor seat: outside the 4-Part scope, same law.
  const supervisorEmpty = invalidContract(() =>
    factory.setContract({ task: "DESC-C", workspace, gate: "true", seat: "supervisor", description: "" }),
  );
  assert.match(supervisorEmpty.message, /description must be a non-empty string/);

  // Inside the 4-Part scope (lead, no binding) the empty description still
  // reads as omitted — the structured Brief synthesizes, and emptiness with
  // no structured fields names the missing sections (ADR 0054 §1).
  const synth = factory.setContract({ task: "DESC-D", workspace, gate: "true", seat: "lead", description: "", outcome: "o", invariants: "i", exclusions: "e", verification: "v" });
  assert.match(synth.description ?? "", /1\. Bounded Outcome/);
  assert.match(synth.description ?? "", /4\. Verification/);
  const bare = invalidContract(() => factory.setContract({ task: "DESC-E", workspace, gate: "true", seat: "lead", description: "" }));
  assert.match(bare.message, /4-Part Brief/);

  // Omission stays valid everywhere — the law binds the supplied empty string, not the absent field.
  const omitted = factory.setContract({ task: "DESC-F", workspace, gate: "true" });
  assert.equal(omitted.description, undefined);
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

// ---- ticket 02: the synthetic green verdict on read-only claims with an empty gate (ADR 0054 §2) ----

const SYNTHETIC_NOTE = "read-only disposition (<disposition>) — 6-field handoff recorded, no shell gate required";

test("ticket 02: a read-only claim with an empty gate records a synthetic green verdict — gate_started then gate_finished green, gate log, and the 6-Field Handoff report, with no shell subprocess (ADR 0054 §2)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  factory.setContract({
    task: "SYNGATE-1",
    workspace,
    gate: "",
    seat: "lead",
    disposition: "architect",
    outcome: "Map the seam the next wave targets.",
    invariants: "No code changes.",
    exclusions: "Excluded: fixes.",
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();

  // The read-only Peer claims with no commit — the omitted sha defaults to the
  // execution tree's HEAD, and the empty gate never reaches a shell.
  const outcome = await factory.claim({
    task: "SYNGATE-1",
    sha: "",
    handoff: { outcome: "complete", scope: "read src/x.ts", verification: "worktree clean at HEAD", unknowns: "none" },
  });

  assert.equal(outcome.verdict, "green", JSON.stringify(outcome.gate));
  assert.equal(outcome.attempt, 1);
  assert.equal(outcome.gate.exit, 0, "the synthetic verdict records exit 0");
  assert.equal(outcome.gate.verdict, "green");
  assert.equal(outcome.gate.note, SYNTHETIC_NOTE.replace("<disposition>", "architect"));
  assert.equal(outcome.gate.sha, head, "the omitted commit resolved to HEAD and the verdict attests it");

  // The full Attempt sequence lands exactly as a shell attempt does — the
  // synthetic path is a verdict, never a shortcut around the ledger.
  const events = factory.ledger.eventsFor("SYNGATE-1");
  assert.deepEqual(
    events.map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
  assert.equal(events.find((e) => e.event === "gate_started")?.cmd, "", "gate_started carries the contract's empty gate verbatim");

  // The gate log is the one synthetic line — a shell run could never produce
  // it (an empty command through runGate cannot even start).
  const finished = events.findLast((e) => e.event === "gate_finished");
  assert.ok(finished && "outputPath" in finished && finished.outputPath, "gate_finished records the gate log path");
  assert.equal(
    readFileSync(String((finished as { outputPath?: string }).outputPath), "utf8"),
    `read-only disposition (architect) — 6-field handoff recorded, worktree clean at ${head}`,
  );

  // The report generates as usual and renders the 6-Field Handoff (spec
  // Implementation Decision 2: "then generate report-<task>-<attempt>.md with
  // the 6-Field Handoff as usual").
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.match(report, /- Outcome: complete/);
  assert.match(report, /- Snapshot:/);
  assert.match(report, /- Scope: read src\/x\.ts/);
  assert.match(report, /- Verification: worktree clean at HEAD/);
  assert.match(report, /- Unknown \/ risk: none/);
  assert.ok(report.includes(head), "the Snapshot names the resolved commit");
});

test("ticket 02: a dirty worktree reds the synthetic path with dirty-worktree-before-gate — the attempt still reaches gate_finished and its report, never an exception (station-2 precedent)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({
    task: "SYNGATE-2",
    workspace,
    gate: "",
    seat: "lead",
    disposition: "scout",
    outcome: "Recon the layout.",
    invariants: "No code changes.",
    exclusions: "Excluded: fixes.",
  });

  // The read-only Peer left an untracked file behind — the tree is not clean
  // at HEAD, so there is nothing clean to attest.
  writeFileSync(join(workspace, "leftover.txt"), "an untracked read-only leftover\n");

  const outcome = await factory.claim({
    task: "SYNGATE-2",
    sha: "",
    handoff: { outcome: "complete", scope: "read the layout", verification: "worktree clean at HEAD", unknowns: "none" },
  });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null, "the pre-gate station red carries no exit code — the station-2 precedent");
  assert.match(outcome.gate.note, /dirty-worktree-before-gate/);
  assert.match(outcome.gate.note, /leftover\.txt/, "the note names the dirty tree's own reason");
  assert.deepEqual(
    factory.ledger.eventsFor("SYNGATE-2").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
    "the red attempt closes through gate_finished and report_written — no exception escapes the claim"
  );
});

test("ticket 02: the synthetic path reds unauthorized root memory edits inside the Contract's diff range (spec Implementation Decision 2)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({
    task: "SYNGATE-3",
    workspace,
    gate: "",
    seat: "lead",
    disposition: "reviewer",
    outcome: "Review the fence.",
    invariants: "No code changes.",
    exclusions: "Excluded: fixes.",
  });

  // A committed AGENTS.md edit between the Contract's base and the claimed
  // HEAD — the tree is clean at HEAD, but project memory is never a read-only
  // Peer's to move (scope is always [] on a read-only Contract).
  writeFileSync(join(workspace, "AGENTS.md"), "# memory edit\n");
  gitCommitChanges(workspace, "memory edit inside the contract range");

  const outcome = await factory.claim({
    task: "SYNGATE-3",
    sha: "",
    handoff: { outcome: "complete", scope: "read AGENTS.md", verification: "worktree clean at HEAD", unknowns: "none" },
  });

  assert.equal(outcome.verdict, "red");
  assert.match(outcome.gate.note, /fenced memory files: AGENTS\.md/);
  assert.deepEqual(
    factory.ledger.eventsFor("SYNGATE-3").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
});

test("ticket 02: a read-only Contract with an explicit non-empty gate runs the shell Gate subprocess exactly as today (spec User Story 8)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  // A failing optional check command: the verdict is red through the ordinary
  // runGate path, and the note carries the command's own output.
  factory.setContract({
    task: "SYNGATE-4",
    workspace,
    gate: "echo reviewer-signal >&2; exit 7",
    seat: "lead",
    disposition: "reviewer",
    outcome: "Run the audit script.",
    invariants: "No code changes.",
    exclusions: "Excluded: fixes.",
  });
  const red = await factory.claim({
    task: "SYNGATE-4",
    sha: "",
    handoff: { outcome: "complete", scope: "read the audit", verification: "the optional gate runs", unknowns: "none" },
  });
  assert.equal(red.verdict, "red");
  assert.equal(red.gate.exit, 7, "the shell's own exit code rides the verdict");
  assert.match(red.gate.note, /reviewer-signal/, "the note is the shell output tail — the subprocess really ran");

  // A passing optional check command greens through the same ordinary path.
  factory.setContract({
    task: "SYNGATE-5",
    workspace,
    gate: "echo scout-ok",
    seat: "lead",
    disposition: "scout",
    outcome: "Run the check.",
    invariants: "No code changes.",
    exclusions: "Excluded: fixes.",
  });
  const green = await factory.claim({
    task: "SYNGATE-5",
    sha: "",
    handoff: { outcome: "complete", scope: "read the check", verification: "the optional gate runs", unknowns: "none" },
  });
  assert.equal(green.verdict, "green");
  assert.equal(green.gate.exit, 0);
  assert.equal(green.gate.note, "scout-ok", "the note is the shell's output — never the synthetic read-only line");
});

test("gate-queue ticket 01: setContract validates timeoutSeconds (60..3600 integer), persists/replays it, and defaults omitted or legacy contracts to 900s", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = makeRepo(dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });

  // Boundary values (60, 3600) and mid value (1200) succeed and persist.
  const minEvt = factory.setContract({ task: "TO-MIN", workspace, gate: "true", timeoutSeconds: 60 });
  assert.equal(minEvt.timeoutSeconds, 60);
  const maxEvt = factory.setContract({ task: "TO-MAX", workspace, gate: "true", timeoutSeconds: 3600 });
  assert.equal(maxEvt.timeoutSeconds, 3600);
  const defaultEvt = factory.setContract({ task: "TO-DEF", workspace, gate: "true" });
  assert.equal("timeoutSeconds" in defaultEvt, false);
  assert.equal(contractTimeoutSeconds(defaultEvt), 900);
  assert.equal(contractTimeoutMs(defaultEvt), 900_000);

  // Re-contracting from explicit 60s without timeoutSeconds returns to the 900s default.
  const recontracted = factory.setContract({ task: "TO-MIN", workspace, gate: "true" });
  assert.equal("timeoutSeconds" in recontracted, false);
  assert.equal(contractTimeoutSeconds(factory.contractFor("TO-MIN")), 900);

  // Out-of-range and non-integer values fail loudly with invalid-contract and append nothing.
  const seqBefore = factory.ledger.events.at(-1)!.seq;
  for (const bad of [59, 0, -60, 3601, 60.5, Number.NaN, Number.POSITIVE_INFINITY, "900" as unknown as number]) {
    const err = invalidContract(() => factory.setContract({ task: "TO-BAD", workspace, gate: "true", timeoutSeconds: bad }));
    assert.match(err.message, /timeoutSeconds/);
    assert.match(err.message, /60.*3600/);
  }
  assert.equal(factory.ledger.events.at(-1)!.seq, seqBefore, "invalid timeoutSeconds writes no ledger event");

  // Reopening from disk preserves configured timeoutSeconds across replay.
  const replayed = createFactory({ stateDir });
  assert.equal(replayed.contractFor("TO-MAX")?.timeoutSeconds, 3600);
  assert.equal(contractTimeoutSeconds(replayed.contractFor("TO-MAX")), 3600);
  assert.equal(replayed.contractFor("TO-DEF")?.timeoutSeconds, undefined);
  assert.equal(contractTimeoutSeconds(replayed.contractFor("TO-DEF")), 900);
});

test("gate-queue ticket 01: claim enforces Contract timeoutSeconds (and 900s default on omitted/legacy contracts) by reaping detached -pgid only when exceeded", { skip: process.platform === "win32" }, async (t) => {
  const handoff = { outcome: "complete", scope: "src/x.ts", verification: "gate run", unknowns: "none" } as const;

  // 1. Fast gate finishing well before timeoutSeconds: 60 returns green cleanly.
  {
    const dir = makeTempDir();
    disposeDir(t, dir);
    const workspace = makeRepo(dir);
    const factory = createFactory({ stateDir: join(dir, "state") });
    factory.setContract({ task: "FAST-60", workspace, gate: "echo fast-ok", timeoutSeconds: 60 });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
    const outcome = await factory.claim({ task: "FAST-60", sha, handoff });
    assert.equal(outcome.verdict, "green");
    assert.equal(outcome.gate.exit, 0);
    assert.equal(outcome.gate.note, "fast-ok");
  }

  const runDetachedTimeoutCase = async (scenario: {
    name: string;
    configuredTimeoutSeconds?: number;
    legacy?: boolean;
    expectedTimeoutMs: number;
  }) => {
    const dir = makeTempDir();
    const pidDir = makeTempDir();
    const parentPidPath = join(pidDir, "parent.pid");
    const pidPath = join(pidDir, "descendant.pid");
    t.after(() => {
      for (const file of [pidPath, parentPidPath]) {
        if (!existsSync(file)) continue;
        try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch { /* already dead */ }
      }
    });
    disposeDir(t, pidDir);
    disposeDir(t, dir);

    const workspace = makeRepo(dir);
    const stateDir = join(dir, "state");
    // Put helper scripts in pidDir (outside the Git worktree) so the Git tree stays clean!
    writeFileSync(join(pidDir, "descendant.mjs"), `
      import { writeFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    `);
    writeFileSync(join(pidDir, "parent.mjs"), `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));
      spawn(process.execPath, [${JSON.stringify(join(pidDir, "descendant.mjs"))}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `);

    const cmd = `exec '${process.execPath}' '${join(pidDir, "parent.mjs")}'`;
    const taskId = `TO-${scenario.name}`;
    if (scenario.legacy) {
      mkdirSync(stateDir, { recursive: true });
      const legacyContract = {
        seq: 1,
        ts: "2025-01-01T00:00:00.000Z",
        event: "contract_set",
        task: taskId,
        workspace,
        gate: cmd,
        artifact: "",
      };
      writeFileSync(join(stateDir, "ledger.jsonl"), `${JSON.stringify(legacyContract)}\n`);
    } else {
      const first = createFactory({ stateDir });
      first.setContract({
        task: taskId,
        workspace,
        gate: cmd,
        ...(scenario.configuredTimeoutSeconds === undefined ? {} : { timeoutSeconds: scenario.configuredTimeoutSeconds }),
      });
    }

    // Reopen from disk to exercise replay + actual claim enforcement without options.timeoutMs override.
    const factory = createFactory({ stateDir });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();

    const yieldBriefly = (): Promise<void> =>
      new Promise((resolve) => {
        const iv = setInterval(() => {
          clearInterval(iv);
          resolve();
        }, 10);
      });

    t.mock.timers.enable({ apis: ["setTimeout"] });
    let settled = false;
    let claimPromise: Promise<Awaited<ReturnType<typeof factory.claim>>> | undefined;
    try {
      claimPromise = factory.claim({ task: taskId, sha, handoff }).then((res) => {
        settled = true;
        return res;
      });

      const deadline = Date.now() + 20_000;
      while (!existsSync(pidPath)) {
        if (Date.now() >= deadline) throw new Error(`${scenario.name}: descendant did not start within 20s`);
        await yieldBriefly();
      }

      // Tick right up to expectedTimeoutMs - 1: must NOT time out prematurely (including past old 300s ceiling).
      t.mock.timers.tick(scenario.expectedTimeoutMs - 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, `${scenario.name}: must not time out before ${scenario.expectedTimeoutMs}ms`);

      const pid = Number(readFileSync(pidPath, "utf8"));
      const aliveStatus = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      assert.ok(aliveStatus !== "" && !aliveStatus.startsWith("Z"), `${scenario.name}: descendant ${pid} still running before timeout`);

      // Crossing expectedTimeoutMs triggers detached -pgid SIGKILL and red timeout Verdict.
      t.mock.timers.tick(1);
      const settleDeadline = Date.now() + 10_000;
      while (!settled && Date.now() < settleDeadline) {
        await yieldBriefly();
      }
      assert.equal(settled, true, `${scenario.name}: claim must settle on timeout after ${scenario.expectedTimeoutMs}ms`);
      const outcome = await claimPromise;
      const deadStatus = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

      assert.equal(outcome.verdict, "red", `${scenario.name}: timeout verdict must be red`);
      assert.equal(outcome.gate.exit, null, `${scenario.name}: timeout exit must be null`);
      assert.match(outcome.gate.note, new RegExp(`gate killed after ${scenario.expectedTimeoutMs}ms \\(timeout\\)`));
      assert.ok(existsSync(outcome.reportPath), `${scenario.name}: report written on timeout`);
      assert.ok(deadStatus === "" || deadStatus.startsWith("Z"), `${scenario.name}: descendant ${pid} must be reaped (status=${deadStatus})`);
    } finally {
      t.mock.timers.reset();
      if (!settled) {
        for (const file of [pidPath, parentPidPath]) {
          if (!existsSync(file)) continue;
          try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch { /* already dead */ }
        }
        await Promise.race([
          claimPromise?.catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
  };

  await runDetachedTimeoutCase({ name: "MIN60", configuredTimeoutSeconds: 60, expectedTimeoutMs: 60_000 });
  await runDetachedTimeoutCase({ name: "MAX3600", configuredTimeoutSeconds: 3600, expectedTimeoutMs: 3_600_000 });
  await runDetachedTimeoutCase({ name: "LEGACY900", legacy: true, expectedTimeoutMs: 900_000 });
});

test("gate-queue ticket 01: lead_set_contract advertises, validates, and forwards timeoutSeconds end-to-end through bridge.mjs JSON-RPC", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "factory-bridge-timeout-"));
  const stateDir = join(homeDir, "plugin-state", "paseo-factory");
  const repoDir = makeRepo(homeDir);
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const reg = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(reg.ok);
  const slug = reg.ok ? reg.slug : "demo";
  const registry = createFactoryRegistry({ stateDir, root: factory });
  const fakeDaemon = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({ send: async () => ({ messageId: `msg-${id}` }), cancel: async () => {}, archive: async () => {} }),
    },
  };
  const spool = startSpool(stateDir, factory, { registry, pollMs: 10, daemon: fakeDaemon as never, home: homeDir });
  t.after(() => spool.stop());

  const lead = new CorrelationRegistry(stateDir).issue({ role: "lead", projectSlug: slug, projectRoot: repoDir, agentId: "lead-timeout" });
  const child = spawn(process.execPath, [BRIDGE_BIN, "--correlation", lead.correlationId, "--state-dir", stateDir], {
    cwd: repoDir,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "MCP-TO-OK", gate: "true", timeoutSeconds: 1800, description: FOUR_PART_BRIEF } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "MCP-TO-DEF", gate: "true", description: FOUR_PART_BRIEF } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "MCP-TO-LOW", gate: "true", timeoutSeconds: 59, description: FOUR_PART_BRIEF } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "MCP-TO-HIGH", gate: "true", timeoutSeconds: 3601, description: FOUR_PART_BRIEF } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "MCP-TO-FLOAT", gate: "true", timeoutSeconds: 120.5, description: FOUR_PART_BRIEF } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lead_set_contract", arguments: { task: "MCP-TO-STR", gate: "true", timeoutSeconds: "900", description: FOUR_PART_BRIEF } } },
  ];

  const responses: Array<Record<string, unknown>> = [];
  let buf = Buffer.alloc(0);
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  await new Promise<void>((resolveDone, rejectDone) => {
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
        if (line !== "") responses.push(JSON.parse(line) as Record<string, unknown>);
        nl = buf.indexOf("\n");
      }
      if (responses.length >= requests.length) {
        clearTimeout(timer);
        child.kill();
        resolveDone();
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolveDone();
    });
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });

  const byId = new Map(responses.map((r) => [r.id, r]));
  const tools = (byId.get(1)!.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools;
  const contractTool = tools.find((tool) => tool.name === "lead_set_contract")!;
  const timeoutProp = contractTool.inputSchema.properties.timeoutSeconds as { type?: string; minimum?: number; maximum?: number } | undefined;
  assert.equal(timeoutProp?.type, "integer", "lead_set_contract schema advertises timeoutSeconds as integer");
  assert.equal(timeoutProp?.minimum, 60);
  assert.equal(timeoutProp?.maximum, 3600);
  assert.ok(contractTool.inputSchema.properties.mutationMode, "slpCatalog mutationMode extension stays preserved");

  const textOf = (id: number) => byId.get(id)!.result as { isError?: boolean; content: Array<{ text: string }> };
  const ok = textOf(2);
  assert.notEqual(ok.isError, true, ok.content[0]?.text);
  assert.match(ok.content[0]?.text ?? "", /timeout 1800s/);

  const def = textOf(3);
  assert.notEqual(def.isError, true, def.content[0]?.text);

  const projectFactory = registry.factoryForProject(slug);
  assert.equal(projectFactory.contractFor("MCP-TO-OK")?.timeoutSeconds, 1800);
  assert.equal(projectFactory.contractFor("MCP-TO-DEF")?.timeoutSeconds, undefined);
  assert.equal(contractTimeoutSeconds(projectFactory.contractFor("MCP-TO-DEF")), 900);

  for (const [id, taskId] of [[4, "MCP-TO-LOW"], [5, "MCP-TO-HIGH"], [6, "MCP-TO-FLOAT"], [7, "MCP-TO-STR"]] as const) {
    const bad = textOf(id);
    assert.equal(bad.isError, true, `id=${id} (${taskId}) must be refused`);
    assert.match(bad.content[0]?.text ?? "", /timeoutSeconds/i);
    assert.match(bad.content[0]?.text ?? "", /60.*3600/);
    assert.equal(projectFactory.contractFor(taskId), undefined, `${taskId} must not be persisted on ledger`);
  }
});
