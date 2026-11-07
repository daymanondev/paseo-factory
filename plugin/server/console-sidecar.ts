/**
 * The Console sidecar (ADR 0051 §1) — the localhost-only HTTP listener the
 * plugin server starts in its own process at boot.
 *
 * It serves the committed `Web Console` bundle (the generated artifact under
 * `<pluginDir>/web/`, shipped through the normal release pipeline) and
 * dispatches `factory.snapshot` **in-process** through the same
 * `SurfaceHandlers` the RN client's registered RPCs call — every read still
 * lands in the plugin server's single writer (ADR 0004). The daemon session
 * credential is never exposed to the browser and the daemon WebSocket
 * protocol is never proxied raw: the sidecar is the one transport boundary.
 *
 * Laws this module keeps:
 * - `127.0.0.1` only — never binds a non-loopback interface.
 * - Read surface only (T-01): `factory.snapshot` dispatches; every other
 *   method name refuses as data. Write RPCs arrive with T-02's boundary
 *   hardening (Host/Origin checks), never here unguarded.
 * - A start failure is logged, never thrown — the sidecar must never break
 *   plugin boot (the shell wraps the call, and `start()` itself resolves to
 *   `{ ok: false, reason }` rather than rejecting while ports fall back).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { SurfaceHandlers } from "./surface-rpc.ts";
import type { SurfaceCallContext } from "./surface-rpc.ts";

/** The stable default port (with fallbacks when busy) — the Owner's bookmark is `http://127.0.0.1:4767`. */
export const CONSOLE_SIDECAR_DEFAULT_PORTS = [4767, 4768, 4769, 4787] as const;

/** The state file name under `<stateDir>/` that records the bound URL for discovery (`factory console`). */
export const CONSOLE_STATE_FILE = "console.json";

/** The RPC request body the console posts to `/rpc`. */
export interface ConsoleRpcRequest {
  method: string;
  params?: unknown;
}

export interface ConsoleSidecarOptions {
  /** The same handlers the plugin server's `factory.*` registrations call — the single writer's door. */
  handlers: SurfaceHandlers;
  /** The plugin state dir — the bound URL lands in `<stateDir>/console.json`. */
  stateDir: string;
  /**
   * Resolves the committed console bundle directory (the generated
   * `<pluginDir>/web/` artifact), evaluated per request: the plugin directory
   * can refresh mid-lifetime after an update, and the bundle keeps serving
   * from the new checkout without a sidecar restart. `undefined` while the
   * daemon has not recorded a local plugin directory — static routes then
   * answer 503 with a sentence, the RPC door keeps working.
   */
  webRoot?: () => string | undefined;
  /** Loopback only by law; overridable so tests can force a failing bind. */
  host?: string;
  /** Ports to try in order (default `[4767, 4768, 4769, 4787, 0]`); `0` is the OS's ephemeral pick. */
  ports?: number[];
  /** The call context handed to every dispatch — the shell's daemon capture. */
  context?: () => SurfaceCallContext;
  onLog?: (message: string) => void;
}

export interface ConsoleSidecarHandle {
  url: string;
  host: string;
  port: number;
  server: Server;
  /** Stops the listener, drops connections, and clears the state file. */
  close: () => Promise<void>;
}

export type ConsoleSidecarStart =
  | { ok: true; sidecar: ConsoleSidecarHandle }
  | { ok: false; reason: string };

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const MAX_RPC_BODY_BYTES = 256 * 1024;

type SnapshotReply = Awaited<ReturnType<SurfaceHandlers["snapshot"]>>;

function text(response: ServerResponse, status: number, body: string, contentType: "text/plain; charset=utf-8" | "application/json; charset=utf-8" = "text/plain; charset=utf-8"): void {
  response.writeHead(status, { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  text(response, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RPC_BODY_BYTES) {
        request.destroy();
        reject(new Error("rpc body exceeds 256 KB"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen({ port, host });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolveStop) => {
    server.closeAllConnections?.();
    server.close(() => resolveStop());
  });
}

/**
 * Starts the Console sidecar. Never rejects while walking the port list — a
 * busy port falls back, and a bind that cannot succeed at all resolves to
 * `{ ok: false, reason }` so plugin boot continues (ADR 0051: the sidecar
 * must never break the boot).
 */
export async function startConsoleSidecar(options: ConsoleSidecarOptions): Promise<ConsoleSidecarStart> {
  const host = options.host ?? "127.0.0.1";
  const ports = options.ports ?? [...CONSOLE_SIDECAR_DEFAULT_PORTS, 0];
  const log = options.onLog ?? (() => {});
  const statePath = join(options.stateDir, CONSOLE_STATE_FILE);
  const server = createServer((request, response) => {
    void handle(options, request, response).catch((error) => {
      log(`console sidecar: request deferred — ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) text(response, 500, "console sidecar error");
      else response.end();
    });
  });

  let bound: { port: number } | undefined;
  let lastReason = "";
  for (const port of ports) {
    try {
      await listen(server, port, host);
      bound = { port: (server.address() as { port: number }).port };
      break;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      // EADDRINUSE/EACCES walk to the next candidate; anything else (bad
      // host, no loopback) cannot succeed on any port — stop trying.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") break;
    }
  }
  if (bound === undefined) {
    await stopServer(server);
    return { ok: false, reason: lastReason || "no port could be bound" };
  }
  const port = bound.port;
  const url = `http://${host}:${port}`;

  // The discovery record (ADR 0051 §1): the bound URL is durably discoverable
  // — `factory console` reads this file; a stale record is replaced on every
  // successful bind of this lifetime.
  try {
    await writeFile(statePath, `${JSON.stringify({ url, host, port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch (error) {
    log(`console sidecar: state file not written — ${error instanceof Error ? error.message : String(error)}`);
  }
  log(`console sidecar: Web Console served at ${url} (state file ${statePath})`);

  const sidecar: ConsoleSidecarHandle = {
    url,
    host,
    port,
    server,
    close: async () => {
      await stopServer(server);
      try {
        const recorded = JSON.parse(await readFile(statePath, "utf8")) as { port?: number };
        if (recorded.port === port) await rm(statePath, { force: true });
      } catch {
        // An unreadable or absent state file never blocks shutdown.
      }
    },
  };
  return { ok: true, sidecar };
}

async function handle(options: ConsoleSidecarOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = request.url ?? "/";
  if (path === "/rpc") return rpc(options, request, response);
  if (request.method !== "GET" && request.method !== "HEAD") return text(response, 405, "method not allowed");
  await serveBundle(options, path, request.method === "HEAD", response);
}

async function rpc(options: ConsoleSidecarOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") return json(response, 405, { ok: false, code: "method_not_allowed", error: "the console RPC door answers POST only" });
  let payload: ConsoleRpcRequest;
  try {
    payload = JSON.parse((await readBody(request)).toString("utf8")) as ConsoleRpcRequest;
  } catch (error) {
    return json(response, 400, { ok: false, code: "bad_request", error: `unreadable JSON body — ${error instanceof Error ? error.message : String(error)}` });
  }
  if (typeof payload?.method !== "string" || payload.method.trim() === "") {
    return json(response, 400, { ok: false, code: "bad_request", error: "the RPC body must name a method" });
  }
  const params = payload.params ?? {};
  if (typeof params !== "object" || params === null) {
    return json(response, 400, { ok: false, code: "bad_request", error: "params must be an object" });
  }
  // The read surface's one method (T-01): dispatch in-process through the
  // same handler the RN client's `factory.snapshot` registration calls. The
  // empty context makes the handler fall back to the deps' daemon capture —
  // the identical in-process single-writer path. Writes (T-02) refuse here
  // until their boundary hardening lands.
  if (payload.method === "factory.snapshot") {
    const context = options.context?.() ?? {};
    const reply: SnapshotReply = await options.handlers.snapshot(params as { projectRoot?: string }, context);
    return json(response, 200, reply);
  }
  return json(response, 404, { ok: false, code: "unknown_method", error: `${payload.method} is not served by the console sidecar (read surface only — factory.snapshot)` });
}

async function serveBundle(options: ConsoleSidecarOptions, requestPath: string, headOnly: boolean, response: ServerResponse): Promise<void> {
  const root = options.webRoot?.();
  if (root === undefined) {
    return text(response, 503, "the Web Console bundle is not served yet — the daemon has not recorded this plugin's directory (config.json); the RPC door keeps working");
  }
  const search = requestPath.split("?", 2)[0].split("#", 2)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(search);
  } catch {
    return text(response, 400, "unreadable path");
  }
  // Path-traversal guard: the resolved candidate must stay inside the bundle root.
  const candidate = normalize(resolve(root, `.${decoded.replace(/\0/g, "")}`));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return text(response, 404, "not found");
  }
  let served = candidate;
  let body: Buffer;
  try {
    body = await readFile(served);
  } catch {
    // The SPA fallback: any path that is not a committed bundle file renders
    // the app — the router keeps the screen across reloads (the prototype's
    // boot-redirect defect, fixed by construction). The served path (and so
    // its MIME type) moves to the fallback document, never the missed route.
    served = join(root, "index.html");
    try {
      body = await readFile(served);
    } catch (error) {
      return text(response, 500, `the Web Console bundle is missing its index.html under ${root} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const type = MIME_TYPES[extname(served).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type, "content-length": String(body.length) });
  response.end(headOnly ? undefined : body);
}
