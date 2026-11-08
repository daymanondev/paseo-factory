import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createDefaultVaultRunner } from "../plugin/server/core/vault-transport.ts";
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
 * `factory.supervisor.revoke`), T-09b's three plugin writes
 * (`factory.plugins.check.updates`, `factory.plugins.install`,
 * `factory.plugins.manage`), T-10b's three vault writes
 * (`factory.vault.configure`, `factory.vault.pull`,
 * `factory.vault.push`), T-10c's two NARROWED vault round-trip writes
 * (`factory.vault.sync`, `factory.vault.hydrate`), T-10d's key import
 * (`factory.vault.import`, a plain entry on its all-optional schema),
 * T-10e's two NARROWED Danger Zone writes (`factory.project.reset`,
 * `factory.project.delete`), T-11b's NARROWED retro write
 * (`factory.retro`), and T-12's Add-Project wizard writes
 * (`factory.project.add`, NARROWED to refuse the empty add, and
 * `factory.project.pick.folder`, a plain entry) —
 * dispatch in-process through the same `SurfaceHandlers` the RN client's
 * registrations call, every input validated by the shared RPC input schema
 * (`plugin/shared/rpc.ts`); every other method name keeps refusing as data.
 * The Scrum entry allowlists exactly the five Owner operations the Inbox
 * resolves, and the plugin, round-trip vault, Danger Zone, retro, and add
 * writes are narrowed per input — manage serves exactly enable/disable/update
 * (never remove/reload, never disabling the console's own host), install
 * carries no developer field (never the core target, never a source/ref or
 * ledger/config override), sync refuses the three fields configure owns
 * (repo, branch, passphrase), hydrate refuses its repo/ref overrides, BOTH
 * project writes require a non-empty `projectRoot` (an unscoped
 * reset/delete of the root Factory refuses) while delete also refuses the
 * `seat` field, the retro write requires the same non-empty
 * `projectRoot` (an unscoped pass over the root Factory refuses — the pass
 * runs against exactly the scoped Project's ledger), and the add write
 * requires a path (BOTH `projectRoot` and `path` empty refuses) — every
 * narrowing refusal is `forbidden_operation` as data BEFORE any handler
 * runs. The siblings stay OUTSIDE the door (ADR 0017 — no Start/Ensure
 * seat control anywhere): the batch save, `lead.ensure`, `lead.dispatch`,
 * `supervisor.ensure`, and the retro ratification (`retro.ratify` — its
 * handler ensures a Supervisor seat; the Owner's decision is pending).
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
  // batch save and the ensure/dispatch seat acts (ADR 0017: the console can
  // retire a LIVE seat but never start one), and the retro ratification
  // (`retro.ratify` ensures a Supervisor seat) — all refuse identically:
  // the door is a list, not a prefix.
  for (const method of [
    "factory.retro.ratify",
    "factory.lead.dispatch",
    "factory.sinister",
    "snapshot",
    "factory.lanes.set.batch",
    "factory.lead.ensure",
    "factory.supervisor.ensure",
  ]) {
    const refusal = await post(started.sidecar.url + "/rpc", { method, params: {} });
    assert.equal(refusal.status, 404, `${method} is not allowlisted`);
    const payload = refusal.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "unknown_method");
    assert.match(payload.error ?? "", /factory\.snapshot, factory\.task\.detail, factory\.agent\.transcript, factory\.accept, factory\.inbox, factory\.scrum\.command, factory\.lanes\.set, factory\.lanes\.reset, factory\.profiles\.apply, factory\.profiles\.save, factory\.profiles\.delete, factory\.lead\.rotate, factory\.supervisor\.revoke, factory\.plugins\.check\.updates, factory\.plugins\.install, factory\.plugins\.manage, factory\.vault\.configure, factory\.vault\.pull, factory\.vault\.push, factory\.vault\.sync, factory\.vault\.hydrate, factory\.vault\.import, factory\.project\.reset, factory\.project\.delete, factory\.retro, factory\.project\.add, factory\.project\.pick\.folder\)/, "the sentence names the allowlist through its last entry");
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

test("console RPC door: the vault round-trip writes are NARROWED — sync's repo/branch/passphrase and hydrate's repo/ref refuse before any handler runs", async (t) => {
  const homeRoot = makeTempDir();
  // The hybrid runner the vault dispatch leg needs: `gh` answers the
  // deterministic missing-binary ENOENT (no host `gh` flips the fold or the
  // unconfigured sync's probe), while `git` stays real.
  const gitRunner = createDefaultVaultRunner();
  const runner: import("../plugin/server/core/vault.ts").VaultRunner = async (call) => {
    if (call.command === "gh") {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    }
    return gitRunner(call);
  };
  const fixture = makeConsoleFixture(homeRoot, { vaultRunner: runner });
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const call = (method: string, params: unknown) => post(started.sidecar.url + "/rpc", { method, params });

  // The narrowed refusals — every one a 400 `forbidden_operation` BEFORE any
  // handler runs: the console's sync carries ONLY its checkboxes because
  // configure owns repo/branch/passphrase, and its hydrate carries ONLY its
  // checkboxes because the direct hydrate reads the configured repo/branch —
  // a one-shot write can never move the home's vault of record.
  const refusals: { method: string; params: Record<string, unknown>; sentence: RegExp }[] = [
    { method: "factory.vault.sync", params: { repo: "octocat/other-vault" }, sentence: /refuses repo/ },
    { method: "factory.vault.sync", params: { branch: "release" }, sentence: /refuses branch/ },
    { method: "factory.vault.sync", params: { passphrase: "correct-horse-battery-staple" }, sentence: /refuses passphrase/ },
    { method: "factory.vault.hydrate", params: { repo: "octocat/other-vault" }, sentence: /refuses repo/ },
    { method: "factory.vault.hydrate", params: { ref: "release" }, sentence: /refuses ref/ },
  ];
  for (const refused of refusals) {
    const reply = await call(refused.method, refused.params);
    assert.equal(reply.status, 400, `${refused.method} ${JSON.stringify(refused.params)} is narrowed off the console`);
    const payload = reply.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", refused.sentence, "the refusal spells the narrowed field it refused");
    assert.match(payload.error ?? "", /from the console/, "the sentence names whose door refused");
  }

  // The allowed shapes — the checkbox-only inputs — pass the narrowing and
  // reach the handler, which then refuses for its own honest reason on this
  // unconfigured home (`vault-not-configured` as data with HTTP 200): the
  // door could never have written that sentence itself.
  for (const method of ["factory.vault.sync", "factory.vault.hydrate"]) {
    const reply = await call(method, {});
    assert.equal(reply.status, 200, `${method} with its checkbox-only input dispatches to the handler`);
    const payload = reply.payload as { ok: boolean; code?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "vault-not-configured", `${method}'s handler refusal rides as data — the call dispatched`);
  }
});

test("console RPC door: the Danger Zone writes are NARROWED — the unscoped reset/delete and delete's seat field refuse before any handler runs", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const call = (method: string, params: unknown) => post(started.sidecar.url + "/rpc", { method, params });

  // The narrowed refusals — every one a 400 `forbidden_operation` BEFORE any
  // handler runs: both writes REQUIRE a non-empty projectRoot (the slug doors
  // the schema allows stay shut too — an unscoped reset/delete of the root
  // Factory is never the console's act), and delete also refuses the `seat`
  // field (Project deletion is Owner-only).
  const refusals: { method: string; params: Record<string, unknown>; sentence: RegExp }[] = [
    { method: "factory.project.reset", params: {}, sentence: /refuses the unscoped reset/ },
    { method: "factory.project.reset", params: { projectRoot: "" }, sentence: /refuses the unscoped reset/ },
    { method: "factory.project.reset", params: { project: "some-slug" }, sentence: /refuses the unscoped reset/ },
    { method: "factory.project.delete", params: {}, sentence: /refuses the unscoped delete/ },
    { method: "factory.project.delete", params: { projectSlug: "some-slug" }, sentence: /refuses the unscoped delete/ },
    { method: "factory.project.delete", params: { projectRoot: "/tmp/fixture-project", seat: "agent" }, sentence: /refuses seat/ },
    { method: "factory.project.delete", params: { projectRoot: "/tmp/fixture-project", seat: "lead" }, sentence: /refuses seat/ },
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

  // The allowed shapes — a non-empty projectRoot — pass the narrowing and
  // reach the handler, which then refuses for its own honest reason on this
  // unregistered root (`unknown-project` as data with HTTP 200): the door
  // could never have written that sentence itself.
  for (const method of ["factory.project.reset", "factory.project.delete"]) {
    const reply = await call(method, { projectRoot: "/tmp/door-unregistered-project" });
    assert.equal(reply.status, 200, `${method} with its scoped input dispatches to the handler`);
    const payload = reply.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "unknown-project", `${method}'s handler refusal rides as data — the call dispatched`);
    assert.match(payload.error ?? "", /does not resolve/, "the handler's own sentence names why it refused");
  }

  // The narrowing refuses before dispatch: the root Factory's ledger records no line.
  assert.equal(fixture.factory.ledger.events.length, 0);
});

test("console RPC door: the retro write is NARROWED — the unscoped retro refuses before any handler runs", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const call = (method: string, params: unknown) => post(started.sidecar.url + "/rpc", { method, params });

  // The narrowed refusals — every one a 400 `forbidden_operation` BEFORE any
  // handler runs: the retro REQUIRES a non-empty projectRoot (the slug doors
  // the schema allows stay shut too — the console's pass runs against exactly
  // the scoped Project's own ledger, never the root Factory).
  const refusals: { params: Record<string, unknown>; sentence: RegExp }[] = [
    { params: {}, sentence: /refuses the unscoped retro/ },
    { params: { projectRoot: "" }, sentence: /refuses the unscoped retro/ },
    { params: { project: "some-slug" }, sentence: /refuses the unscoped retro/ },
  ];
  for (const refused of refusals) {
    const reply = await call("factory.retro", refused.params);
    assert.equal(reply.status, 400, `factory.retro ${JSON.stringify(refused.params)} is narrowed off the console`);
    const payload = reply.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", refused.sentence, "the refusal spells the narrowed act it refused");
    assert.match(payload.error ?? "", /from the console/, "the sentence names whose door refused");
  }

  // The allowed shape — a non-empty projectRoot — passes the narrowing and
  // reaches the handler, which then refuses for its own honest reason on this
  // unresolvable root (`unknown-project` as data with HTTP 200): the door
  // could never have written that sentence itself.
  const scoped = await call("factory.retro", { projectRoot: "/tmp/door-unregistered-project" });
  assert.equal(scoped.status, 200, "factory.retro with its scoped input dispatches to the handler");
  const scopedPayload = scoped.payload as { ok: boolean; code?: string; error?: string };
  assert.equal(scopedPayload.ok, false);
  assert.equal(scopedPayload.code, "unknown-project", "the handler's own refusal rides as data — the call dispatched");
  assert.match(scopedPayload.error ?? "", /could not resolve/, "the handler's own sentence names why it refused");

  // The narrowing refuses before dispatch: the root Factory's ledger records no line.
  assert.equal(fixture.factory.ledger.events.length, 0);
});

test("console RPC door: the Add-Project wizard writes — the empty add refuses before any handler runs, the scoped add and the picker dispatch", async (t) => {
  const homeRoot = makeTempDir();
  // The picker seam (T-12): the fake answers the cancelled arm — a REAL
  // osascript dialog must never open on the test host, and the cancelled
  // reply proves the plain entry dispatches to the handler.
  const prompts: string[] = [];
  const fixture = makeConsoleFixture(homeRoot, {
    pickFolder: (prompt) => {
      prompts.push(prompt ?? "(none)");
      return null;
    },
  });
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const call = (method: string, params: unknown) => post(started.sidecar.url + "/rpc", { method, params });

  // The narrowed refusal — a 400 `forbidden_operation` BEFORE any handler
  // runs: the wizard always carries the chosen folder, so an add with BOTH
  // directory doors empty never dispatches (a whitespace-only spelling the
  // schema's own min(1) cannot see refuses here too; an empty STRING is the
  // schema's own bad_input, never the narrowing's).
  const refusals: { params: Record<string, unknown>; sentence: RegExp }[] = [
    { params: {}, sentence: /refuses the empty add/ },
    { params: { projectRoot: "  " }, sentence: /refuses the empty add/ },
  ];
  for (const refused of refusals) {
    const reply = await call("factory.project.add", refused.params);
    assert.equal(reply.status, 400, `factory.project.add ${JSON.stringify(refused.params)} is narrowed off the console`);
    const payload = reply.payload as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "forbidden_operation");
    assert.match(payload.error ?? "", refused.sentence, "the refusal spells the narrowed act it refused");
    assert.match(payload.error ?? "", /from the console/, "the sentence names whose door refused");
  }

  // The allowed shape — a non-empty path — passes the narrowing and reaches
  // the handler, which then refuses for its own honest reason on this
  // nonexistent path (`missing-directory` as data with HTTP 200): the door
  // could never have written that sentence itself.
  const scoped = await call("factory.project.add", { path: "/tmp/door-unregistered-project" });
  assert.equal(scoped.status, 200, "factory.project.add with a path dispatches to the handler");
  const scopedPayload = scoped.payload as { ok: boolean; code?: string; error?: string };
  assert.equal(scopedPayload.ok, false);
  assert.equal(scopedPayload.code, "missing-directory", "the handler's own refusal rides as data — the call dispatched");
  assert.match(scopedPayload.error ?? "", /does not exist/, "the handler's own sentence names why it refused");

  // The picker is a plain entry: the fake seam's cancelled arm answers the
  // handler's own `{ok, cancelled, path: null}` with HTTP 200 — dispatch
  // proof with no dialog, and the prompt rode the call.
  const picked = await call("factory.project.pick.folder", { prompt: "Choose the project folder" });
  assert.equal(picked.status, 200, "factory.project.pick.folder dispatches to the handler");
  const pickedPayload = picked.payload as { ok: boolean; cancelled?: boolean; path?: string | null };
  assert.equal(pickedPayload.ok, true);
  assert.equal(pickedPayload.cancelled, true, "the cancelled arm rides as data");
  assert.equal(pickedPayload.path, null);
  assert.deepEqual(prompts, ["Choose the project folder"], "the picker seam saw the one dispatch");

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
    { method: "factory.profiles.save", params: { projectRoot: "/tmp/fixture-project" } }, // name missing
    { method: "factory.profiles.save", params: { name: "", projectRoot: "/tmp/fixture-project" } }, // name empty
    { method: "factory.profiles.delete", params: {} }, // profileId missing
    { method: "factory.lead.rotate", params: {} }, // projectRoot missing
    { method: "factory.supervisor.revoke", params: { projectRoot: 42 } }, // projectRoot not a string
    { method: "factory.plugins.install", params: {} }, // target missing
    { method: "factory.plugins.install", params: { target: "factory-sinister" } }, // target not one of the family
    { method: "factory.plugins.manage", params: {} }, // pluginId missing
    { method: "factory.plugins.manage", params: { pluginId: "factory-burn-lab", action: "sinister" } }, // action not one of the five
    { method: "factory.vault.configure", params: { branch: "main" } }, // repo missing
    { method: "factory.vault.configure", params: { repo: "octocat/factory-vault", branch: "" } }, // branch empty
    { method: "factory.vault.sync", params: { mergeLedgers: "yes" } }, // mergeLedgers not a boolean
    { method: "factory.vault.hydrate", params: { overwriteConfigs: 1 } }, // overwriteConfigs not a boolean
    { method: "factory.vault.import", params: { ascKeyPath: 42 } }, // a path field not a string
    { method: "factory.vault.import", params: { syncAfterImport: "yes" } }, // syncAfterImport not a boolean
    { method: "factory.project.reset", params: { projectRoot: 42 } }, // projectRoot not a string
    { method: "factory.project.reset", params: { keepSeats: "yes" } }, // keepSeats not a boolean
    { method: "factory.project.delete", params: { projectRoot: "/tmp/fixture-project", seat: 7 } }, // seat not a string
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

  // The vault writes dispatch the same way — pull on an unconfigured home is
  // the vendored core's own `vault-not-configured` refusal as data, proving
  // T-10b's entries reach the handler rather than the door refusing.
  const vaultRefusal = await post(started.sidecar.url + "/rpc", { method: "factory.vault.pull", params: {} });
  assert.equal(vaultRefusal.status, 200);
  const vaultPayload = vaultRefusal.payload as { ok: boolean; code?: string; error?: string };
  assert.equal(vaultPayload.ok, false);
  assert.equal(vaultPayload.code, "vault-not-configured");

  // The key import (T-10d) dispatches the same way — a missing key file is
  // the vendored core's own `vault-import-file-not-found` refusal as data
  // (syncAfterImport spelled false so no transport ever runs), proving the
  // plain entry reaches the handler rather than the door refusing.
  const importRefusal = await post(started.sidecar.url + "/rpc", {
    method: "factory.vault.import",
    params: { ascKeyPath: "/nonexistent/AuthKey_XYZ.p8", syncAfterImport: false },
  });
  assert.equal(importRefusal.status, 200);
  const importPayload = importRefusal.payload as { ok: boolean; code?: string; error?: string };
  assert.equal(importPayload.ok, false);
  assert.equal(importPayload.code, "vault-import-file-not-found");
});
