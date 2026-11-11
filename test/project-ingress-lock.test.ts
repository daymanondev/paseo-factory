import { test } from "node:test";
import assert from "node:assert/strict";
import { withProjectIngressLock } from "../src/project-ingress-lock.ts";
import * as core from "../src/index.ts";

/** The Project ingress lock (ADR 0056): SLP dispatch admission is serialized per Project, nothing more. */

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test("jobs for one Project run strictly one after another, in submission order", async () => {
  const log: string[] = [];
  const job = (name: string, ms: number) => withProjectIngressLock("/state", "alpha", async () => {
    log.push(`${name}:start`);
    await tick(ms);
    log.push(`${name}:end`);
    return name;
  });
  const results = await Promise.all([job("a", 20), job("b", 1), job("c", 1)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("different Projects never wait on each other", async () => {
  const log: string[] = [];
  const slow = withProjectIngressLock("/state", "alpha", async () => { log.push("alpha:start"); await tick(30); log.push("alpha:end"); });
  const quick = withProjectIngressLock("/state", "beta", async () => { log.push("beta:start"); log.push("beta:end"); });
  await Promise.all([slow, quick]);
  assert.deepEqual(log, ["alpha:start", "beta:start", "beta:end", "alpha:end"]);
});

test("a job that re-enters its own Project's lane runs inline instead of deadlocking", async () => {
  const value = await withProjectIngressLock("/state", "alpha", () => withProjectIngressLock("/state", "alpha", async () => "inner"));
  assert.equal(value, "inner");
});

test("a failed job does not poison the queue behind it", async () => {
  const failing = withProjectIngressLock("/state", "alpha", async () => { throw new Error("boom"); });
  const following = withProjectIngressLock("/state", "alpha", async () => "ok");
  await assert.rejects(failing, /boom/);
  assert.equal(await following, "ok");
});

test("the core package exports no Scrum namespace and no execution-mode switch", () => {
  assert.equal("scrum" in core, false);
  assert.equal("switchExecution" in core, false);
  assert.equal("readExecution" in core, false);
});
