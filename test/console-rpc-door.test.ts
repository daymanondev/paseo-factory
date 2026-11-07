import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The sidecar's allowlisted RPC door (T-02): the named `factory.*` methods —
 * `factory.snapshot`, `factory.task.detail`, `factory.agent.transcript`,
 * `factory.accept`, `factory.inbox` (T-05's one cross-Project Scrum read) —
 * dispatch in-process through the same `SurfaceHandlers` the RN client's
 * registrations call, every input validated by the shared RPC input schema
 * (`plugin/shared/rpc.ts`); every other method name keeps refusing as data.
 */

async function post(url: string, body: unknown): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

test("console RPC door: the allowlisted read pair answers over the real listener", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  makeReadyToAcceptTask(fixture.factory, homeRoot, "T9");
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const snapshot = await post(started.sidecar.url + "/rpc", { method: "factory.snapshot", params: {} });
  assert.equal(snapshot.status, 200);
  const view = snapshot.payload as { ok: boolean; view?: { tasks?: { task: string; status: string }[] } };
  assert.equal(view.ok, true);
  assert.equal(view.view?.tasks?.[0]?.status, "ready-to-accept", "the fixture task folds to ready-to-accept");

  const detail = await post(started.sidecar.url + "/rpc", { method: "factory.task.detail", params: { task: "T9" } });
  assert.equal(detail.status, 200);
  const detailPayload = detail.payload as { ok: boolean; detail?: { contract?: { gate?: string }; task?: { attempts?: { n: number; verdict: string | null }[] } } };
  assert.equal(detailPayload.ok, true);
  assert.equal(detailPayload.detail?.contract?.gate, "npm test");
  assert.equal(detailPayload.detail?.task?.attempts?.[0]?.verdict, "green");
});

test("console RPC door: unlisted methods keep refusing as data, whatever their name", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // A write RPC outside the allowlist, a read RPC outside it, T-06's not-yet-
  // exposed Scrum write door, and an invented name all refuse identically —
  // the door is a list, not a prefix.
  for (const method of ["factory.retro", "factory.lanes.set", "factory.lead.dispatch", "factory.scrum.command", "factory.sinister", "snapshot"]) {
    const refusal = await post(started.sidecar.url + "/rpc", { method, params: {} });
    assert.equal(refusal.status, 404, `${method} is not allowlisted`);
    const payload = refusal.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "unknown_method");
    assert.match(payload.error ?? "", /factory\.snapshot, factory\.task\.detail, factory\.agent\.transcript, factory\.accept, factory\.inbox/, "the sentence names the allowlist");
  }
});

test("console RPC door: inputs are validated by the SHARED schema before any handler runs", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const cases: { method: string; params: unknown }[] = [
    { method: "factory.accept", params: { task: "T1" } }, // attempt missing
    { method: "factory.accept", params: { task: "T1", attempt: "1" } }, // attempt not a number
    { method: "factory.task.detail", params: {} }, // task missing
    { method: "factory.agent.transcript", params: {} }, // agent missing
    { method: "factory.snapshot", params: { projectRoot: 42 } }, // projectRoot not a string
  ];
  for (const call of cases) {
    const refusal = await post(started.sidecar.url + "/rpc", call);
    assert.equal(refusal.status, 400, `${call.method} ${JSON.stringify(call.params)} must fail schema validation`);
    const payload = refusal.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "bad_input");
    assert.match(payload.error ?? "", new RegExp(call.method), "the refusal names the method it refused");
  }

  // A schema refusal never touches the handler: the ledger records no line.
  assert.equal(fixture.factory.ledger.events.length, 0);
});

test("console RPC door: a handler refusal rides as data with HTTP 200 — never a 5xx", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // Accept on a task with no contract: the handler's own refusal (the
  // envelope law — a Failure union, not an exception).
  const refusal = await post(started.sidecar.url + "/rpc", { method: "factory.accept", params: { task: "NOPE", attempt: 1 } });
  assert.equal(refusal.status, 200);
  const payload = refusal.payload as { ok: boolean; code?: string; error?: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "unknown-task");
});
