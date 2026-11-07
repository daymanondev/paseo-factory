import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { makeConsoleFixture } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The Console sidecar's localhost boundary (T-02, ADR 0051 §1): the
 * DNS-rebinding guard (Host must be the sidecar's own loopback host:port),
 * the cross-site guard (/rpc Origin must be the sidecar's own origin when
 * present), and the form-CSRF guard (/rpc must carry
 * `content-type: application/json`). Every refusal is data — a 4xx Failure
 * body. Raw `http.request` drives the checks: only it can pin arbitrary
 * Host/Origin/content-type headers on the wire.
 */

interface RawReply {
  status: number;
  body: string;
}

function rawCall(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
  body?: string,
): Promise<RawReply> {
  return new Promise((resolveCall, reject) => {
    const outbound = request({ host: "127.0.0.1", port, path, method, headers }, (reply) => {
      const chunks: Buffer[] = [];
      reply.on("data", (chunk: Buffer) => chunks.push(chunk));
      reply.on("end", () => resolveCall({ status: reply.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outbound.on("error", reject);
    if (body !== undefined) outbound.write(body);
    outbound.end();
  });
}

test("console sidecar boundary: a foreign Host is refused as data on every route — the DNS-rebinding guard", async (t) => {
  const fixture = makeConsoleFixture(makeTempDir());
  const homeRoot = fixture.homeRoot;
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  const { port, close } = started.sidecar;
  t.after(async () => {
    await close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  // The rebinding probe: evil.example resolves to 127.0.0.1, so the TCP
  // handshake succeeds — the Host check is the thing that refuses it.
  for (const path of ["/", "/tasks", "/rpc"]) {
    const probe = await rawCall("evil.example", port, path, { host: `evil.example:${port}` });
    assert.equal(probe.status, 403, `Host evil.example on ${path} must refuse`);
    const refusal = JSON.parse(probe.body) as { ok: boolean; code?: string };
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, "bad_host");
  }

  // The sidecar's own loopback spellings answer normally — both the bound
  // host and `localhost`.
  const bound = await rawCall("127.0.0.1", port, "/", { host: `127.0.0.1:${port}` });
  assert.equal(bound.status, 200);
  const localhost = await rawCall("127.0.0.1", port, "/", { host: `localhost:${port}` });
  assert.equal(localhost.status, 200);

  // A Host naming another port on loopback is a foreign spelling — refused
  // as data (node's client always injects a Host, so "absent" never reaches
  // the wire from here; the auto-injected spelling is the legitimate one).
  const otherPort = await rawCall("127.0.0.1", port, "/", { host: `127.0.0.1:${port + 1}` });
  assert.equal(otherPort.status, 403);
});

test("console sidecar boundary: /rpc refuses a foreign Origin as data — the cross-site guard", async (t) => {
  const fixture = makeConsoleFixture(makeTempDir());
  const homeRoot = fixture.homeRoot;
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  const { port, close } = started.sidecar;
  t.after(async () => {
    await close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const jsonHeaders = { host: `127.0.0.1:${port}`, "content-type": "application/json", origin: "http://evil.example" };
  const foreign = await rawCall("127.0.0.1", port, "/rpc", jsonHeaders, "POST", JSON.stringify({ method: "factory.snapshot", params: {} }));
  assert.equal(foreign.status, 403);
  const refusal = JSON.parse(foreign.body) as { ok: boolean; code?: string };
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "bad_origin");

  // A sandboxed frame's literal `null` origin is present-and-foreign too.
  const nulled = await rawCall(
    "127.0.0.1",
    port,
    "/rpc",
    { ...jsonHeaders, origin: "null" },
    "POST",
    JSON.stringify({ method: "factory.snapshot", params: {} }),
  );
  assert.equal(nulled.status, 403);

  // The sidecar's own origins pass the guard (the dispatch itself may still
  // refuse the method — a different refusal, asserted by its own code).
  for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    const own = await rawCall(
      "127.0.0.1",
      port,
      "/rpc",
      { host: `127.0.0.1:${port}`, "content-type": "application/json", origin },
      "POST",
      JSON.stringify({ method: "factory.snapshot", params: {} }),
    );
    assert.equal(own.status, 200, `own origin ${origin} must pass the Origin guard`);
    assert.equal((JSON.parse(own.body) as { ok: boolean }).ok, true);
  }

  // An absent Origin (curl, the node tests' fetch) stays legal.
  const originless = await rawCall(
    "127.0.0.1",
    port,
    "/rpc",
    { host: `127.0.0.1:${port}`, "content-type": "application/json" },
    "POST",
    JSON.stringify({ method: "factory.snapshot", params: {} }),
  );
  assert.equal(originless.status, 200);
});

test("console sidecar boundary: /rpc without application/json refuses as data — the form-CSRF guard", async (t) => {
  const fixture = makeConsoleFixture(makeTempDir());
  const homeRoot = fixture.homeRoot;
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  const { port, close } = started.sidecar;
  t.after(async () => {
    await close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const host = `127.0.0.1:${port}`;
  // A plain HTML form's two native enctype spellings — both refused.
  for (const contentType of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain"]) {
    const form = await rawCall(
      "127.0.0.1",
      port,
      "/rpc",
      { host, "content-type": contentType },
      "POST",
      "method=factory.accept&task=T1&attempt=1",
    );
    assert.equal(form.status, 415, `content-type ${contentType} must refuse`);
    const refusal = JSON.parse(form.body) as { ok: boolean; code?: string };
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, "bad_content_type");
  }

  // Absent content-type refuses identically — the door answers JSON only.
  const absent = await rawCall("127.0.0.1", port, "/rpc", { host }, "POST", "{}");
  assert.equal(absent.status, 415);

  // `application/json` with parameters stays legal (fetch's default spelling).
  const parameterized = await rawCall(
    "127.0.0.1",
    port,
    "/rpc",
    { host, "content-type": "application/json; charset=utf-8" },
    "POST",
    JSON.stringify({ method: "factory.snapshot", params: {} }),
  );
  assert.equal(parameterized.status, 200);
});
