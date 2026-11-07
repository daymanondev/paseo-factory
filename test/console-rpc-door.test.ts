import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The sidecar's allowlisted RPC door (T-02): the named `factory.*` methods —
 * `factory.snapshot`, `factory.task.detail`, `factory.agent.transcript`,
 * `factory.accept`, `factory.inbox` (T-05's one cross-Project Scrum read),
 * T-06's NARROWED `factory.scrum.command`, and T-08b's three lane writes
 * (`factory.lanes.set`, `factory.lanes.reset`, `factory.profiles.apply`) —
 * dispatch in-process through the same `SurfaceHandlers` the RN client's
 * registrations call, every input validated by the shared RPC input schema
 * (`plugin/shared/rpc.ts`); every other method name keeps refusing as data.
 * The Scrum entry allowlists exactly the five Owner operations the Inbox
 * resolves — every other operation refuses `forbidden_operation` as data
 * BEFORE any handler runs. The lane writes' siblings stay OUTSIDE the door:
 * the batch save, the profile CRUD (T-08c), the seat lifecycle
 * (`lead.*`/`supervisor.*`), and every `project.*`.
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

  // A write RPC outside the allowlist, a read RPC outside it, an invented
  // name, and every lane-write sibling T-08b left outside the door — the
  // batch save, the profile CRUD, the seat lifecycle, the project acts — all
  // refuse identically: the door is a list, not a prefix.
  for (const method of [
    "factory.retro",
    "factory.lead.dispatch",
    "factory.sinister",
    "snapshot",
    "factory.lanes.set.batch",
    "factory.profiles.save",
    "factory.profiles.delete",
    "factory.lead.rotate",
    "factory.lead.ensure",
    "factory.supervisor.revoke",
    "factory.supervisor.ensure",
    "factory.project.reset",
    "factory.project.add",
    "factory.project.delete",
    "factory.project.pick.folder",
  ]) {
    const refusal = await post(started.sidecar.url + "/rpc", { method, params: {} });
    assert.equal(refusal.status, 404, `${method} is not allowlisted`);
    const payload = refusal.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "unknown_method");
    assert.match(payload.error ?? "", /factory\.snapshot, factory\.task\.detail, factory\.agent\.transcript, factory\.accept, factory\.inbox, factory\.scrum\.command, factory\.lanes\.set, factory\.lanes\.reset, factory\.profiles\.apply/, "the sentence names the allowlist");
  }
});

test("console RPC door: factory.scrum.command serves ONLY the five Owner operations — every other operation refuses before any handler runs", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const scrum = (operation: string, extra: Record<string, unknown> = {}) =>
    post(started.sidecar.url + "/rpc", {
      method: "factory.scrum.command",
      params: { projectRoot: "/tmp/fixture-project", operation, runId: "run-x", requestId: `door-${operation}`, expectedRevision: 1, ...extra },
    });

  // The console's five Owner acts pass the narrowing and reach the handler —
  // which then refuses for its own honest reasons (no such project), proving
  // dispatch happened rather than the door refusing.
  for (const operation of ["wait.answer", "wait.cancel", "design.decide", "allowance.tasks", "allowance.qa"]) {
    const reply = await scrum(operation, { payload: { pendingId: "q1", rationale: "why" } });
    assert.equal(reply.status, 200, `${operation} dispatches to the handler`);
    const payload = reply.payload as { ok: boolean; code?: string };
    assert.equal(payload.ok, false);
    assert.notEqual(payload.code, "forbidden_operation", `${operation} is one of the console's five acts`);
  }

  // Every other operation — the dangerous writes the Inbox must never reach —
  // refuses as data BEFORE any handler runs.
  for (const operation of ["run.cancel", "run.continue", "config.set", "config.reset", "lead.operation", "supervisor.decision", "run.create", "wait.request", "preview", "sinister.act"]) {
    const refusal = await scrum(operation);
    assert.equal(refusal.status, 400, `${operation} is forbidden from the console`);
    const payload = refusal.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", /factory\.scrum\.command refuses operation/, "the refusal names the refused operation");
    assert.match(payload.error ?? "", new RegExp(operation.replaceAll(".", "\\.")), "the sentence spells the operation it refused");
  }

  // The narrowing refuses before dispatch: the root Factory's ledger records no line.
  assert.equal(fixture.factory.ledger.events.length, 0);
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
    { method: "factory.lanes.set", params: { lane: "sinister", value: "pi/zai/glm-5.3", projectRoot: "/tmp/fixture-project" } }, // lane not one of the six
    { method: "factory.lanes.set", params: { lane: "lead", value: "", projectRoot: "/tmp/fixture-project" } }, // value empty
    { method: "factory.lanes.reset", params: { projectRoot: "" } }, // projectRoot empty
    { method: "factory.profiles.apply", params: { projectRoot: "/tmp/fixture-project" } }, // profileId missing
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
