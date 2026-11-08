import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The sidecar's allowlisted RPC door (T-02): the named `factory.*` methods —
 * `factory.snapshot`, `factory.task.detail`, `factory.agent.transcript`,
 * `factory.accept`, `factory.inbox` (T-05's one cross-Project Scrum read),
 * T-06's NARROWED `factory.scrum.command`, T-08b's three lane writes
 * (`factory.lanes.set`, `factory.lanes.reset`, `factory.profiles.apply`),
 * T-08c's four lifecycle writes (`factory.profiles.save`,
 * `factory.profiles.delete`, `factory.lead.rotate`,
 * `factory.supervisor.revoke`), and T-09b's three plugin writes
 * (`factory.plugins.check.updates`, `factory.plugins.install`,
 * `factory.plugins.manage`) — dispatch in-process through the same
 * `SurfaceHandlers` the RN client's registrations call, every input
 * validated by the shared RPC input schema (`plugin/shared/rpc.ts`); every
 * other method name keeps refusing as data. The Scrum entry allowlists
 * exactly the five Owner operations the Inbox resolves, and the plugin
 * writes are narrowed per input — manage serves exactly enable/disable/
 * update (never remove/reload, never disabling the console's own host) and
 * install carries no developer field (never the core target, never a
 * source/ref or ledger/config override) — every narrowing refusal is
 * `forbidden_operation` as data BEFORE any handler runs. The siblings stay
 * OUTSIDE the door (ADR 0017 — no Start/Ensure seat control anywhere): the
 * batch save, `lead.ensure`, `lead.dispatch`, `supervisor.ensure`, and
 * every `project.*`.
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
  // name, and every sibling the lifecycle waves left outside the door — the
  // batch save, the ensure/dispatch seat acts (ADR 0017: the console can
  // retire a LIVE seat but never start one), and every project act — all
  // refuse identically: the door is a list, not a prefix.
  for (const method of [
    "factory.retro",
    "factory.lead.dispatch",
    "factory.sinister",
    "snapshot",
    "factory.lanes.set.batch",
    "factory.lead.ensure",
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
    assert.match(payload.error ?? "", /factory\.snapshot, factory\.task\.detail, factory\.agent\.transcript, factory\.accept, factory\.inbox, factory\.scrum\.command, factory\.lanes\.set, factory\.lanes\.reset, factory\.profiles\.apply, factory\.profiles\.save, factory\.profiles\.delete, factory\.lead\.rotate, factory\.supervisor\.revoke, factory\.plugins\.check\.updates, factory\.plugins\.install, factory\.plugins\.manage/, "the sentence names the allowlist");
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

test("console RPC door: the plugin writes are NARROWED — remove/reload, disabling the host, the core install target, and every developer field refuse before any handler runs", async (t) => {
  const homeRoot = makeTempDir();
  // Recording fakes at the daemon seams: a refusal never reaches them, so the
  // recordings prove which calls dispatched and which the door refused.
  const installs: { id: string; source: string; ref?: string }[] = [];
  const manages: { pluginId: string; action: string }[] = [];
  const checks: string[] = [];
  const fixture = makeConsoleFixture(homeRoot, {
    installPlugin: async (_home, input) => {
      installs.push(input);
      return { ok: false, reason: "no daemon behind the door test" };
    },
    managePlugin: async (_home, pluginId, action) => {
      manages.push({ pluginId, action });
      return { ok: false, reason: "no daemon behind the door test" };
    },
    checkPluginUpdates: async (home) => {
      checks.push(home);
      return { ok: false, reason: "no daemon behind the door test" };
    },
  });
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const call = (method: string, params: unknown) => post(started.sidecar.url + "/rpc", { method, params });
  const manage = (params: Record<string, unknown>) => call("factory.plugins.manage", params);
  const install = (params: Record<string, unknown>) => call("factory.plugins.install", params);

  // The narrowed refusals — every one a 400 `forbidden_operation` BEFORE any
  // handler runs: remove and reload stay developer acts for every plugin,
  // the console never disables its own host, the core target rides the
  // daemon's release pipeline, and a custom source/ref or a ledger/config
  // override is a developer act the console never carries.
  const refusals: { method: string; params: Record<string, unknown>; sentence: RegExp }[] = [
    { method: "factory.plugins.manage", params: { pluginId: "factory-burn-lab", action: "remove" }, sentence: /refuses action remove/ },
    { method: "factory.plugins.manage", params: { pluginId: "factory-burn-lab", action: "reload" }, sentence: /refuses action reload/ },
    { method: "factory.plugins.manage", params: { pluginId: "paseo-factory", action: "disable" }, sentence: /disable for paseo-factory/ },
    { method: "factory.plugins.install", params: { target: "paseo-factory" }, sentence: /refuses target paseo-factory/ },
    { method: "factory.plugins.install", params: { target: "factory-burn-lab", source: "git:some/fork:plugin" }, sentence: /refuses source/ },
    { method: "factory.plugins.install", params: { target: "factory-burn-lab", ref: "main" }, sentence: /refuses ref/ },
    { method: "factory.plugins.install", params: { target: "all", mergeLedgers: true }, sentence: /refuses mergeLedgers/ },
    { method: "factory.plugins.install", params: { target: "all", overwriteConfigs: true }, sentence: /refuses overwriteConfigs/ },
  ];
  for (const refused of refusals) {
    const reply = await call(refused.method, refused.params);
    assert.equal(reply.status, 400, `${refused.method} ${JSON.stringify(refused.params)} is narrowed off the console`);
    const payload = reply.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", refused.sentence, "the refusal spells the narrowed act it refused");
    assert.match(payload.error ?? "", /from the console/, "the sentence names whose door refused");
  }

  // The allowed shapes pass the narrowing and reach the handler — which then
  // answers with the fake daemon's own failure as data (`daemon_failed`), a
  // dispatch the door could never have written itself.
  for (const manageCall of [
    { pluginId: "factory-burn-lab", action: "enable" },
    { pluginId: "factory-burn-lab", action: "disable" },
    { pluginId: "paseo-factory", action: "update" },
  ]) {
    const reply = await manage(manageCall);
    assert.equal(reply.status, 200, `${manageCall.action} dispatches to the handler`);
    const payload = reply.payload as { ok: boolean; code?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "daemon_failed", "the fake daemon's failure rides as data — the call dispatched");
  }
  const installOk = await install({ target: "factory-burn-lab" });
  assert.equal(installOk.status, 200, "a canonical-source companion install dispatches");
  const installPayload = installOk.payload as { ok: boolean; code?: string };
  assert.equal(installPayload.ok, false);
  assert.equal(installPayload.code, "daemon_failed");
  const checkReply = await call("factory.plugins.check.updates", {});
  assert.equal(checkReply.status, 200, "the plain check entry dispatches");
  const checkPayload = checkReply.payload as { ok: boolean; code?: string };
  assert.equal(checkPayload.ok, false);
  assert.equal(checkPayload.code, "daemon_failed");

  // The seams saw ONLY the allowed shapes — the eight narrowing refusals above never dispatched.
  assert.deepEqual(
    manages,
    [
      { pluginId: "factory-burn-lab", action: "enable" },
      { pluginId: "factory-burn-lab", action: "disable" },
      { pluginId: "paseo-factory", action: "update" },
    ],
    "the manage seam recorded exactly the three allowed dispatches",
  );
  assert.deepEqual(installs, [{ id: "factory-burn-lab", source: "git:daymanondev/factory-burn-lab:plugin" }], "the install seam recorded the one canonical-source dispatch");
  assert.deepEqual(checks, [fixture.home], "the check seam recorded its one dispatch against the fixture home");
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
    { method: "factory.profiles.save", params: { projectRoot: "/tmp/fixture-project" } }, // name missing
    { method: "factory.profiles.save", params: { name: "", projectRoot: "/tmp/fixture-project" } }, // name empty
    { method: "factory.profiles.delete", params: {} }, // profileId missing
    { method: "factory.lead.rotate", params: {} }, // projectRoot missing
    { method: "factory.supervisor.revoke", params: { projectRoot: 42 } }, // projectRoot not a string
    { method: "factory.plugins.install", params: {} }, // target missing
    { method: "factory.plugins.install", params: { target: "factory-sinister" } }, // target not one of the family
    { method: "factory.plugins.manage", params: {} }, // pluginId missing
    { method: "factory.plugins.manage", params: { pluginId: "factory-burn-lab", action: "sinister" } }, // action not one of the five
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
