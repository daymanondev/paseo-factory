import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { acceptViaSidecar } from "../web/src/accept.ts";
import { invokeRpc } from "../web/src/rpc.ts";
import { loadSnapshotViaSidecar } from "../web/src/useSnapshot.ts";
import { makeConsoleFixture, makeReadyToAcceptTask } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-02): at least one test drives the console's
 * REAL transport — `web/src/rpc.ts` / `web/src/accept.ts` /
 * `web/src/useSnapshot.ts`, the exact functions the browser bundle calls —
 * against a REAL started sidecar over a REAL Factory fixture, proving the
 * Owner's Accept lands in the ledger through the single writer AND the
 * localhost boundary's refusals fire over the same live listener.
 */

/** A raw wire-level POST — only it can carry the foreign headers the boundary must refuse. */
function rawRpc(
  port: number,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; payload: { ok: boolean; code?: string } }> {
  return new Promise((resolveRpc, reject) => {
    const payload = JSON.stringify(body);
    const outbound = request(
      {
        host: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: { "content-length": String(Buffer.byteLength(payload)), ...headers },
      },
      (reply) => {
        const chunks: Buffer[] = [];
        reply.on("data", (chunk: Buffer) => chunks.push(chunk));
        reply.on("end", () => resolveRpc({ status: reply.statusCode ?? 0, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      },
    );
    outbound.on("error", reject);
    outbound.write(payload);
    outbound.end();
  });
}

test("RG-1: the console's real transport accepts a green Attempt over a real sidecar, and the ledger records it", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  makeReadyToAcceptTask(fixture.factory, homeRoot, "T-ACCEPT");

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  const { url, port, close } = started.sidecar;
  t.after(async () => {
    await close();
    rmSync(homeRoot, { recursive: true, force: true });
  });
  const atSidecar = fixture.atSidecar(started.sidecar);

  // 1. The browser's own snapshot loader sees the ready-to-accept Task.
  const before = await loadSnapshotViaSidecar({}, atSidecar);
  assert.ok(before.ok, before.ok ? "" : `${before.code}: ${before.error}`);
  const taskBefore = before.view.tasks.find((task) => task.task === "T-ACCEPT");
  assert.ok(taskBefore, "the fixture task rides the snapshot");
  assert.equal(taskBefore.status, "ready-to-accept");

  // 2. The browser's own accept transport submits the green Attempt — the
  //    same `invokeRpc` POST /rpc the Tasks screen's Accept button rides.
  const acceptance = await acceptViaSidecar({ task: "T-ACCEPT", attempt: 1 }, atSidecar);
  assert.ok(acceptance.ok, acceptance.ok ? "" : `${acceptance.code}: ${acceptance.error}`);
  assert.equal(typeof acceptance.seq, "number");

  // 3. The single writer recorded it: the Factory's own ledger carries the
  //    attempt_accepted line for exactly this task and attempt.
  const accepted = fixture.factory.ledger.eventsFor("T-ACCEPT").find((event) => event.event === "attempt_accepted");
  assert.ok(accepted, "the acceptance landed in the ledger via the sidecar's in-process dispatch");
  assert.equal(accepted.attempt, 1);

  // 4. The next snapshot — the refresh the screen triggers — shows it Accepted.
  const after = await loadSnapshotViaSidecar({}, atSidecar);
  assert.ok(after.ok, after.ok ? "" : `${after.code}: ${after.error}`);
  const taskAfter = after.view.tasks.find((task) => task.task === "T-ACCEPT");
  assert.equal(taskAfter?.status, "accepted");
  assert.equal(taskAfter?.accepted, true);

  // 5. A second Accept of the same attempt is the handler's idempotent
  //    refusal as data — never a second ledger line.
  const dup = await acceptViaSidecar({ task: "T-ACCEPT", attempt: 1 }, atSidecar);
  assert.ok(dup.ok === false);
  assert.ok(dup.ok === false && dup.code === "already-accepted", `the refusal code rides verbatim (got ${dup.code})`);

  // 6. The boundary refusals fire over the same live listener — the journey
  //    is only real if its guards are: a rebinding Host, a foreign Origin,
  //    and a form's content-type all refuse as data while the door keeps
  //    answering the browser's own shape.
  const host = `127.0.0.1:${port}`;
  const rebinding = await rawRpc(port, { host: `evil.example:${port}`, "content-type": "application/json" }, { method: "factory.accept", params: { task: "T-ACCEPT", attempt: 1 } });
  assert.equal(rebinding.status, 403);
  assert.equal(rebinding.payload.code, "bad_host");
  const crossSite = await rawRpc(port, { host, "content-type": "application/json", origin: "http://evil.example" }, { method: "factory.accept", params: { task: "T-ACCEPT", attempt: 1 } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.payload.code, "bad_origin");
  const form = await rawRpc(port, { host, "content-type": "application/x-www-form-urlencoded" }, { method: "factory.accept", params: { task: "T-ACCEPT", attempt: 1 } });
  assert.equal(form.status, 415);
  assert.equal(form.payload.code, "bad_content_type");

  // The unlisted write next door still refuses over the real transport seam.
  const unlisted = await invokeRpc("factory.lead.dispatch", { prompt: "go" }, atSidecar);
  assert.ok(unlisted.ok === false && unlisted.code === "unknown_method");
  assert.equal(url.startsWith("http://127.0.0.1:"), true, "the served URL is the loopback bind");
});
