import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import {
  CONSOLE_SIDECAR_DEFAULT_PORTS,
  CONSOLE_STATE_FILE,
  startConsoleSidecar,
  type ConsoleSidecarStart,
} from "../plugin/server/console-sidecar.ts";
import { fakeCopilotRunner, makeTempDir } from "./helpers.ts";

/**
 * The Console sidecar (ADR 0051 §1) against a real Factory on a temp home —
 * never `~/.paseo` — on an ephemeral port: it serves the committed Web
 * Console bundle (SPA fallback included) and dispatches `factory.snapshot`
 * in-process through the same handlers the RN client's registrations call.
 * Every listener the tests open closes in teardown.
 */

interface Fixture {
  stateDir: string;
  webRoot: string;
  handlers: ReturnType<typeof createSurfaceHandlers>;
  start: (overrides?: Partial<Parameters<typeof startConsoleSidecar>[0]>) => Promise<ConsoleSidecarStart>;
}

function makeFixture(homeRoot: string): Fixture {
  const home = join(homeRoot, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const webRoot = join(homeRoot, "console-bundle");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(
    join(webRoot, "index.html"),
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Factory Console (fixture)</title></head><body><div id=\"root\"></div></body></html>\n",
  );
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log('fixture bundle');\n");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner, eyeCliProbe: () => false });
  // The transport test's daemon: an empty, fully-typed slice — the snapshot
  // needs no live seats to answer the view, and SurfaceDeps.daemon is required.
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async () => ({ entries: [] }),
      create: async () => ({ id: "unused" }),
      ref: (id: string) => ({
        send: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: { refetch: async () => ({ entries: [], error: null }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
  const handlers = createSurfaceHandlers({ factory, stateDir, home, daemon });
  return {
    stateDir,
    webRoot,
    handlers,
    start: async (overrides) =>
      startConsoleSidecar({
        handlers,
        stateDir,
        webRoot: () => webRoot,
        // The ephemeral port — never the Owner's stable default during tests.
        ports: [0],
        onLog: () => {},
        ...overrides,
      }),
  };
}

async function get(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual" });
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** A raw GET whose path goes on the wire verbatim — `fetch` normalizes `..` away client-side. */
function rawGet(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveGet, reject) => {
    const outbound = request({ host, port, path, method: "GET" }, (reply) => {
      const chunks: Buffer[] = [];
      reply.on("data", (chunk: Buffer) => chunks.push(chunk));
      reply.on("end", () => resolveGet({ status: reply.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outbound.on("error", reject);
    outbound.end();
  });
}

test("console sidecar: serves the bundle, falls back to index.html for SPA routes, and stays inside the bundle root", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  const { url, port, host, close } = started.sidecar;
  t.after(async () => {
    await close();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  assert.equal(host, "127.0.0.1", "the sidecar binds loopback only");
  assert.notEqual(port, CONSOLE_SIDECAR_DEFAULT_PORTS[0], "tests ride an ephemeral port, never the Owner's default");

  const index = await get(`${url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await index.text(), /Factory Console \(fixture\)/);

  const asset = await get(`${url}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await asset.text(), /fixture bundle/);

  // The SPA fallback: a screen path that is no committed file renders the app,
  // as a document — never an octet-stream download of the missed route.
  const route = await get(`${url}/tasks`);
  assert.equal(route.status, 200);
  assert.match(route.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await route.text(), /Factory Console \(fixture\)/);

  // Path traversal never escapes the bundle root — the raw client sends the
  // literal `..` segment (fetch would normalize it away before the wire), and
  // the percent-encoded spelling must decode to the same refusal.
  const escape = await rawGet(host, port, "/../ledger.jsonl");
  assert.equal(escape.status, 404, "a traversal attempt must not serve state files");
  assert.doesNotMatch(escape.body, /fixture bundle/);
  const encoded = await rawGet(host, port, "/%2e%2e/ledger.jsonl");
  assert.equal(encoded.status, 404);
  assert.doesNotMatch(encoded.body, /fixture bundle/);

  // The bound URL is discoverable — the state file records it.
  const state = JSON.parse(readFileSync(join(fixture.stateDir, CONSOLE_STATE_FILE), "utf8")) as { url?: string; port?: number };
  assert.equal(state.url, url);
  assert.equal(state.port, port);
});

test("console sidecar: dispatches factory.snapshot in-process through the surface handlers", async (t) => {
  const homeRoot = makeTempDir();
  t.after(() => rmSync(homeRoot, { recursive: true, force: true }));
  const fixture = makeFixture(homeRoot);
  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(() => started.sidecar.close());

  const reply = await post(`${started.sidecar.url}/rpc`, { method: "factory.snapshot", params: {} });
  assert.equal(reply.status, 200);
  const payload = (await reply.json()) as { ok: boolean; view?: { version?: number; projects?: unknown[] } };
  assert.ok(payload.ok, "the snapshot RPC answers the view, never an exception");
  assert.equal(payload.view?.version, 3, "FactoryView v3 rides the sidecar");
  assert.ok(Array.isArray(payload.view?.projects), "the project list rides the snapshot");

  // The read surface's one method: anything else refuses as data.
  const unknown = await post(`${started.sidecar.url}/rpc`, { method: "factory.accept", params: { task: "T1", attempt: 1 } });
  assert.equal(unknown.status, 404);
  const refusal = (await unknown.json()) as { ok: boolean; code?: string };
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "unknown_method", "write RPCs arrive with T-02's boundary — never unguarded here");

  const badBody = await post(`${started.sidecar.url}/rpc`, "not-json");
  assert.equal(badBody.status, 400);

  const wrongVerb = await get(`${started.sidecar.url}/rpc`);
  assert.equal(wrongVerb.status, 405);
});

test("console sidecar: a busy preferred port falls back, and close clears the state file", async (t) => {
  const homeRoot = makeTempDir();
  t.after(() => rmSync(homeRoot, { recursive: true, force: true }));
  const fixture = makeFixture(homeRoot);

  // Hold a port so the sidecar's first preference is busy.
  const held = createServer();
  await new Promise<void>((resolveListen) => held.listen({ port: 0, host: "127.0.0.1" }, () => resolveListen()));
  t.after(() => new Promise<void>((resolveClose) => held.close(() => resolveClose())));
  const heldPort = (held.address() as { port: number }).port;

  const started = await fixture.start({ ports: [heldPort, 0] });
  assert.ok(started.ok, started.ok ? "" : started.reason);
  const { port, close } = started.sidecar;
  assert.notEqual(port, heldPort, "a busy port falls back to the next candidate");
  assert.ok(existsSync(join(fixture.stateDir, CONSOLE_STATE_FILE)));
  await close();
  assert.equal(existsSync(join(fixture.stateDir, CONSOLE_STATE_FILE)), false, "close clears the discovery record");
});

test("console sidecar: a start failure resolves as data — never a thrown boot breaker", async (t) => {
  const homeRoot = makeTempDir();
  t.after(() => rmSync(homeRoot, { recursive: true, force: true }));
  const fixture = makeFixture(homeRoot);
  // A host that cannot be bound fails every port: the sidecar reports why.
  const failed = await fixture.start({ host: "999.999.999.999", ports: [0] });
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.reason.length > 0, "the refusal carries a sentence");

  // An unrecorded plugin directory keeps the RPC door working while static routes degrade to 503.
  const degraded = await fixture.start({ webRoot: () => undefined });
  assert.ok(degraded.ok, degraded.ok ? "" : degraded.reason);
  t.after(() => degraded.sidecar.close());
  const rpc = await post(`${degraded.sidecar.url}/rpc`, { method: "factory.snapshot", params: {} });
  assert.equal(rpc.status, 200);
  const bundle = await get(`${degraded.sidecar.url}/`);
  assert.equal(bundle.status, 503);
  assert.match(await bundle.text(), /bundle is not served yet/);
});
