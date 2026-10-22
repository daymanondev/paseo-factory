#!/usr/bin/env node
/**
 * factory-claim — the Agent's single factory command (ADR 0004).
 *
 * Claims that a task is finished at a specific commit. The factory does not
 * trust the claim: the plugin resolves the sha, checks the Workspace sits
 * clean at it, runs the contract's gate, and records the verdict in the
 * ledger with a report. This CLI only submits the claim through the spool and
 * prints what the factory answered.
 *
 * The generated wrapper at `<stateDir>/bin/factory-claim` execs this script
 * with the daemon's node binary and `FACTORY_STATE_DIR` baked in, so agents
 * never need to know where state lives. Direct dev runs must set
 * `FACTORY_STATE_DIR` (or `PASEO_HOME`) themselves.
 *
 * Exit codes: 0 verdict GREEN · 1 verdict RED · 2 not processed (bad usage,
 * rejected, or the plugin never answered).
 */
import { parseArgs } from "node:util";
import { awaitReply, randomId, resolveHome, spoolRootFor, stateDirFor, submit } from "./spool-client.mjs";

const usage = `usage: factory-claim --task <id> --sha <commit-sha> [--wait-secs <n>]

Claim that the task is finished at a specific commit. The factory does not
trust the claim: it runs the contract's gate at the claimed commit and
records the verdict (paseo-factory v0.0.1).`;

const DEFAULT_WAIT_SECS = 600; // gate timeout default is 300s — leave headroom

let args;
try {
  args = parseArgs({
    strict: true,
    options: {
      task: { type: "string" },
      sha: { type: "string" },
      "wait-secs": { type: "string", default: String(DEFAULT_WAIT_SECS) },
      help: { type: "boolean", default: false },
    },
  });
} catch (err) {
  console.error(`factory-claim: ${err instanceof Error ? err.message : String(err)}\n\n${usage}`);
  process.exit(2);
}

if (args.values.help) {
  console.log(usage);
  process.exit(0);
}

if (typeof args.values.task !== "string" || typeof args.values.sha !== "string") {
  console.error(`factory-claim: --task and --sha are both required\n\n${usage}`);
  process.exit(2);
}

const waitSecs = Number(args.values["wait-secs"]);
if (!Number.isFinite(waitSecs) || waitSecs <= 0) {
  console.error(`factory-claim: --wait-secs must be a positive number\n\n${usage}`);
  process.exit(2);
}

const stateDir = process.env.FACTORY_STATE_DIR ?? stateDirFor(resolveHome());
const spoolRoot = spoolRootFor(stateDir);

const request = {
  id: randomId(),
  kind: "claim",
  task: args.values.task,
  sha: args.values.sha,
  ...(process.env.PASEO_AGENT_ID === undefined ? {} : { agent: process.env.PASEO_AGENT_ID }),
};

submit(spoolRoot, request);
const reply = await awaitReply(spoolRoot, request.id, waitSecs * 1000);

if (reply === null) {
  // The stop-on-timeout instruction (v0.0.31, ADR 0017 §6): the single
  // deduplicated request stays durably queued in spool/requests/ — reloading
  // the plugin resumes the pipeline — so the caller must stop retrying and
  // end its turn immediately.
  console.error(
    `factory-claim: No reply from the factory plugin after ${waitSecs}s (request ${request.id} remains queued in spool/requests/). ` +
      `The paseo-factory plugin may be stopped — DO NOT retry or call this tool again; end your turn immediately so the plugin can process the queued request when reloaded.`,
  );
  process.exit(2);
}

if (!reply.ok) {
  console.error(`factory-claim: ${reply.message}`);
  process.exit(2);
}

console.log(`factory-claim: task ${args.values.task} attempt ${reply.attempt} — ${reply.verdict.toUpperCase()}`);
if (reply.note !== undefined && reply.note !== "") {
  console.log(`note: ${reply.note}`);
}
if (reply.reportPath !== undefined) {
  console.log(`report: ${reply.reportPath}`);
}
process.exit(reply.verdict === "green" ? 0 : 1);
