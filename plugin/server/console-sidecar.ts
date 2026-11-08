/**
 * The Console sidecar (ADR 0051 §1) — the localhost-only HTTP listener the
 * plugin server starts in its own process at boot.
 *
 * It serves the committed `Web Console` bundle (the generated artifact under
 * `<pluginDir>/web/`, shipped through the normal release pipeline) and
 * dispatches an allowlisted set of `factory.*` RPCs **in-process** through
 * the same `SurfaceHandlers` the RN client's registered RPCs call — every
 * read and write still lands in the plugin server's single writer (ADR
 * 0004). The daemon session credential is never exposed to the browser and
 * the daemon WebSocket protocol is never proxied raw: the sidecar is the one
 * transport boundary.
 *
 * Laws this module keeps:
 * - `127.0.0.1` only — never binds a non-loopback interface.
 * - The localhost boundary (T-02): every request's `Host` must be the
 *   sidecar's own loopback host:port (DNS-rebinding guard); every `/rpc`
 *   whose `Origin` is present must be the sidecar's own origin; every `/rpc`
 *   must carry `content-type: application/json` (form-CSRF guard). Each
 *   refusal is data — a 4xx `Failure` body, never a 5xx.
 * - The allowlisted RPC door (T-02): only the named `factory.*` methods in
 *   `CONSOLE_RPC_ALLOWLIST` dispatch, each input validated by the shared RPC
 *   input schema (`plugin/shared/rpc.ts`); every other method name refuses
 *   as data. The browser never needs a token.
 * - The narrowed Scrum write (T-06): the console's `factory.scrum.command`
 *   entry additionally allowlists exactly the five Owner operations the
 *   Inbox resolves (`wait.answer`, `wait.cancel`, `design.decide`,
 *   `allowance.tasks`, `allowance.qa`); every other operation refuses as
 *   data (`forbidden_operation`) before any handler runs.
 * - The lane writes (T-08b): `factory.lanes.set`, `factory.lanes.reset`,
 *   and `factory.profiles.apply` join the allowlist as plain entries — the
 *   three Agents & Models acts, each validated by its existing shared
 *   schema and dispatched to the same single-writer `SurfaceHandlers`.
 * - The lifecycle writes (T-08c): `factory.profiles.save`,
 *   `factory.profiles.delete`, `factory.lead.rotate`, and
 *   `factory.supervisor.revoke` join as plain entries the same way — the
 *   profile CRUD and the two seat-retire acts, each on its existing shared
 *   schema. Rotate and revoke only ever retire a LIVE seat; they are not
 *   Start controls. The sibling writes stay outside the door:
 *   `factory.lanes.set.batch`, `factory.lead.ensure`, `factory.lead.dispatch`,
 *   `factory.supervisor.ensure`, and every `factory.project.*` keep refusing
 *   `unknown_method` as data (ADR 0017 — no Start/Ensure seat controls
 *   anywhere in the console).
 * - The plugin writes (T-09b, ADR 0051 §7): `factory.plugins.check.updates`,
 *   `factory.plugins.install`, and `factory.plugins.manage` join the door on
 *   their existing shared schemas, `check.updates` as a plain entry and the
 *   two writes NARROWED per input before any handler runs: manage refuses
 *   `remove` and `reload` (and `disable` of `paseo-factory`, the console's
 *   own host), install refuses the `paseo-factory` target and every developer
 *   field (`source`, `ref`, `mergeLedgers`, `overwriteConfigs`) — each
 *   refusal is data (`forbidden_operation`), the daemon's own answers
 *   (`daemon_failed` included) ride as data too.
 * - A start failure is logged, never thrown — the sidecar must never break
 *   plugin boot (the shell wraps the call, and `start()` itself resolves to
 *   `{ ok: false, reason }` rather than rejecting while ports fall back).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { z, ZodType } from "zod";
import { accept, agentTranscript, inbox, lanesReset, lanesSet, leadRotate, pluginsCheckUpdates, pluginsInstall, pluginsManage, profilesApply, profilesDelete, profilesSave, scrumCommand, snapshot, supervisorRevoke, taskDetail } from "../shared/rpc.ts";
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

// ---- the allowlisted RPC door (T-02) -------------------------------------------------------
//
// One named entry per method the console may call. The method name, the input
// schema, and the handler key all come from the shared contract
// (`plugin/shared/rpc.ts`) — the sidecar never invents a method, never
// validates with a private schema, and never reaches around the
// `SurfaceHandlers` (the same in-process door the RN client's registrations
// call, so every write lands in the single writer, ADR 0004).
//
// T-06 adds the one NARROWED write: `factory.scrum.command` dispatches with
// the shared input schema PLUS an operation allowlist of exactly the five
// Owner acts the Inbox needs (`wait.answer`, `wait.cancel`, `design.decide`,
// `allowance.tasks`, `allowance.qa`). Every other operation — `run.cancel`,
// `config.set`, `lead.operation`, `supervisor.decision`, … — refuses as data
// BEFORE any handler runs. The dispatch carries Owner authority the same way
// Accept does: the sidecar hands the handler the exact call the Owner's local
// UI makes, and no credential ever crosses to the browser (the localhost
// boundary is the boundary; `scrumCommand`'s own `caller` stays unset, its
// documented default `authority: "owner"`).

interface ConsoleRpcEntry {
  method: string;
  /** Validates with the shared schema, then dispatches — a schema refusal never reaches the handler. */
  run: (
    handlers: SurfaceHandlers,
    params: unknown,
    context: SurfaceCallContext,
  ) => Promise<{ ok: false; code: "bad_input" | "forbidden_operation"; error: string } | { ok: true; reply: unknown }>;
}

/** The console's five Scrum Owner acts — every other `factory.scrum.command` operation refuses before any handler runs. */
export const CONSOLE_SCRUM_OPERATIONS: readonly string[] = ["wait.answer", "wait.cancel", "design.decide", "allowance.tasks", "allowance.qa"];

/**
 * The console's narrowed plugin manage acts (T-09b): `enable`, `disable`, and
 * `update` only — `remove` and `reload` stay developer acts, and the console
 * never disables its own host plugin.
 */
export const CONSOLE_PLUGIN_MANAGE_ACTIONS: readonly string[] = ["enable", "disable", "update"];

/**
 * The install fields the console never carries (T-09b): a custom `source` or
 * `ref`, and the ledger/config overrides — developer acts stay off the console.
 */
export const CONSOLE_PLUGIN_INSTALL_FORBIDDEN_FIELDS: readonly string[] = ["source", "ref", "mergeLedgers", "overwriteConfigs"];

/** A per-entry input narrowing — refuses BEFORE any handler runs, data never a dispatch. */
interface ConsoleRpcNarrowing {
  /** The operation allowlist (the Scrum door, T-06) — any other `operation` value refuses. */
  operations?: readonly string[];
  /** A method-specific refusal sentence for this exact input, or null to dispatch (the plugin writes, T-09b). */
  refuse?: (input: Record<string, unknown>) => string | null;
}

/** The typed constructor — each closure's input is the shared schema's own inference. */
function consoleRpcEntry<S extends ZodType>(
  method: string,
  schema: S,
  dispatch: (handlers: SurfaceHandlers, input: z.output<S>, context: SurfaceCallContext) => Promise<unknown>,
  narrowing?: ConsoleRpcNarrowing,
): ConsoleRpcEntry {
  return {
    method,
    run: async (handlers, params, context) => {
      const parsed = schema.safeParse(params);
      if (!parsed.success) {
        return { ok: false, code: "bad_input", error: `${method} refused the input — ${parsed.error.message}` };
      }
      if (narrowing !== undefined) {
        // The narrowed-entry law: the operation allowlist refuses BEFORE any
        // handler runs — a forbidden act is data (`forbidden_operation`), never
        // a dispatch the handler itself must police.
        const operation = (parsed.data as { operation?: unknown }).operation;
        if (narrowing.operations !== undefined && (typeof operation !== "string" || !narrowing.operations.includes(operation))) {
          return {
            ok: false,
            code: "forbidden_operation",
            error: `${method} refuses operation ${typeof operation === "string" ? operation : JSON.stringify(operation) ?? String(operation)} from the console (operations: ${narrowing.operations.join(", ")})`,
          };
        }
        if (narrowing.refuse !== undefined) {
          const sentence = narrowing.refuse(parsed.data as Record<string, unknown>);
          if (sentence !== null) return { ok: false, code: "forbidden_operation", error: sentence };
        }
      }
      return { ok: true, reply: await dispatch(handlers, parsed.data, context) };
    },
  };
}

/** The manage narrowing (T-09b): remove/reload refuse for every plugin, disable refuses for the console's own host. */
function pluginManageRefusal(input: { pluginId?: unknown; action?: unknown }): string | null {
  const action = input.action;
  if (action === "remove" || action === "reload") {
    return `factory.plugins.manage refuses action ${action} from the console (actions: ${CONSOLE_PLUGIN_MANAGE_ACTIONS.join(", ")}) — remove and reload stay developer acts`;
  }
  if (input.pluginId === "paseo-factory" && action === "disable") {
    return "factory.plugins.manage refuses action disable for paseo-factory from the console — the console's own host plugin cannot be disabled here";
  }
  return null;
}

/** The install narrowing (T-09b): the core target and every developer field refuse — canonical-source installs only. */
function pluginInstallRefusal(input: Record<string, unknown>): string | null {
  if (input.target === "paseo-factory") {
    return "factory.plugins.install refuses target paseo-factory from the console — the core plugin rides the daemon's own release pipeline";
  }
  const forbidden = CONSOLE_PLUGIN_INSTALL_FORBIDDEN_FIELDS.filter((field) => input[field] !== undefined);
  if (forbidden.length > 0) {
    return `factory.plugins.install refuses ${forbidden.join(", ")} from the console — custom sources, refs, and ledger/config overrides stay developer acts`;
  }
  return null;
}

export const CONSOLE_RPC_ALLOWLIST: readonly ConsoleRpcEntry[] = [
  consoleRpcEntry(snapshot.name, snapshot.input, (handlers, input, context) => handlers.snapshot(input, context)),
  consoleRpcEntry(taskDetail.name, taskDetail.input, (handlers, input, context) => handlers.taskDetail(input, context)),
  consoleRpcEntry(agentTranscript.name, agentTranscript.input, (handlers, input, context) => handlers.agentTranscript(input, context)),
  consoleRpcEntry(accept.name, accept.input, (handlers, input, context) => handlers.accept(input, context)),
  consoleRpcEntry(inbox.name, inbox.input, (handlers, input) => handlers.inbox(input)),
  // The narrowed Scrum door (T-06): the shared schema, the five Owner acts, no `caller` — Owner authority the way Accept carries it.
  consoleRpcEntry(scrumCommand.name, scrumCommand.input, (handlers, input, context) => handlers.scrumCommand(input, context), {
    operations: CONSOLE_SCRUM_OPERATIONS,
  }),
  // The lane writes (T-08b) — the Agents & Models screen's three Owner acts,
  // plain allowlisted entries (no operation narrowing): the shared schemas
  // already bound them (`lane` is a `LaneName`, `value` a non-empty string,
  // `projectRoot` the scope). The batch save stays OUTSIDE the door, as do
  // every ensure/dispatch seat act and every project act.
  consoleRpcEntry(lanesSet.name, lanesSet.input, (handlers, input, context) => handlers.lanesSet(input, context)),
  consoleRpcEntry(lanesReset.name, lanesReset.input, (handlers, input, context) => handlers.lanesReset(input, context)),
  consoleRpcEntry(profilesApply.name, profilesApply.input, (handlers, input, context) => handlers.profilesApply(input, context)),
  // The lifecycle writes (T-08c) — the same plain-entry law: the profile
  // CRUD (`profilesSave` snapshots the scope's CURRENT table when `lanes` is
  // omitted; `profilesDelete` tombstones the id) and the two seat-retire
  // acts (`leadRotate`, `supervisorRevoke`), each on its existing shared
  // schema. Rotate and revoke only retire a LIVE seat — the handler refuses
  // `no-lead`/`no-supervisor` when none exists; nothing here can START one
  // (ADR 0017 — `supervisor.ensure` and `lead.ensure` stay outside the door).
  consoleRpcEntry(profilesSave.name, profilesSave.input, (handlers, input, context) => handlers.profilesSave(input, context)),
  consoleRpcEntry(profilesDelete.name, profilesDelete.input, (handlers, input) => handlers.profilesDelete(input)),
  consoleRpcEntry(leadRotate.name, leadRotate.input, (handlers, input, context) => handlers.leadRotate(input, context)),
  consoleRpcEntry(supervisorRevoke.name, supervisorRevoke.input, (handlers, input, context) => handlers.supervisorRevoke(input, context)),
  // The plugin writes (T-09b) — the Integrations screen's Owner acts.
  // `check.updates` is a plain entry (the on-demand probe the stamp renders);
  // the two writes are NARROWED per input before any handler runs: manage
  // serves exactly enable/disable/update (never remove/reload, never disabling
  // the console's own host), install serves canonical-source companion
  // installs only (never the core target, never a source/ref/ledger/config
  // override — developer acts). A daemon-side failure still rides as data
  // (`daemon_failed`) from the handler itself.
  consoleRpcEntry(pluginsCheckUpdates.name, pluginsCheckUpdates.input, (handlers, input, context) => handlers.pluginsCheckUpdates(input, context)),
  consoleRpcEntry(pluginsInstall.name, pluginsInstall.input, (handlers, input, context) => handlers.pluginsInstall(input, context), {
    refuse: pluginInstallRefusal,
  }),
  consoleRpcEntry(pluginsManage.name, pluginsManage.input, (handlers, input, context) => handlers.pluginsManage(input, context), {
    refuse: pluginManageRefusal,
  }),
];

/** The named allowlist as the refusal sentence spells it. */
const allowlistSentence = () => CONSOLE_RPC_ALLOWLIST.map((entry) => entry.method).join(", ");

// ---- the localhost boundary (T-02) ---------------------------------------------------------

/**
 * The boundary a bound sidecar checks every request against: the loopback
 * `host:port` spellings the browser may legitimately send, and the sidecar's
 * own origins for the RPC door's CSRF check. Built only after `listen()` —
 * the port of an ephemeral bind is unknowable before it.
 */
interface LoopbackBoundary {
  /** `Host` headers (lowercased) the sidecar answers — anything else is a rebinding probe. */
  allowedHosts: readonly string[];
  /** Exact-match `Origin` values `/rpc` accepts — a foreign origin is a cross-site probe. */
  ownOrigins: readonly string[];
}

function loopbackBoundary(host: string, port: number): LoopbackBoundary {
  // `localhost:<port>` is as loopback as the bound spelling — the Owner may
  // type either; a non-loopback name can never appear here because the
  // listener never leaves 127.0.0.1.
  return {
    allowedHosts: [`${host}:${port}`, `localhost:${port}`].map((value) => value.toLowerCase()),
    ownOrigins: [`http://${host}:${port}`, `http://localhost:${port}`].map((value) => value.toLowerCase()),
  };
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
  // Set the moment `listen()` names the port — no request can arrive before
  // the listener exists, so the boundary is always present when checked.
  let boundary: LoopbackBoundary | undefined;
  const server = createServer((request, response) => {
    void handle(options, boundary, request, response).catch((error) => {
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
  boundary = loopbackBoundary(host, port);
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

async function handle(options: ConsoleSidecarOptions, boundary: LoopbackBoundary | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The DNS-rebinding guard (T-02) — first gate on EVERY request, static
  // routes included: a Host that is not this listener's own loopback
  // host:port is a rebinding probe (evil.example → 127.0.0.1), refused as
  // data before any path is even looked at.
  if (boundary !== undefined) {
    const host = (request.headers.host ?? "").toLowerCase();
    if (!boundary.allowedHosts.includes(host)) {
      return json(response, 403, { ok: false, code: "bad_host", error: `the console sidecar answers its own loopback host only — Host ${host || "(absent)"} is refused` });
    }
  }
  const path = request.url ?? "/";
  if (path === "/rpc") return rpc(options, boundary, request, response);
  if (request.method !== "GET" && request.method !== "HEAD") return text(response, 405, "method not allowed");
  await serveBundle(options, path, request.method === "HEAD", response);
}

async function rpc(options: ConsoleSidecarOptions, boundary: LoopbackBoundary | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") return json(response, 405, { ok: false, code: "method_not_allowed", error: "the console RPC door answers POST only" });
  // The form-CSRF guard (T-02): a browser form can only post its own body
  // types — `application/json` is exactly the type fetch's `invokeRpc` sends
  // and a plain `<form>` cannot. Parameters (`; charset=utf-8`) stay legal.
  const contentType = (request.headers["content-type"] ?? "").split(";", 2)[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "application/json") {
    return json(response, 415, { ok: false, code: "bad_content_type", error: `the console RPC door answers application/json only — content-type ${contentType || "(absent)"} is refused` });
  }
  // The cross-site guard (T-02): same-origin fetch sends the sidecar's own
  // origin; an absent Origin (curl, tests) is legal; anything else —
  // including the literal `null` a sandboxed frame sends — refuses as data.
  const origin = request.headers.origin;
  if (origin !== undefined && !boundary?.ownOrigins.includes(origin.toLowerCase())) {
    return json(response, 403, { ok: false, code: "bad_origin", error: `the console RPC door answers its own origin only — Origin ${origin} is refused` });
  }
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
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return json(response, 400, { ok: false, code: "bad_request", error: "params must be an object" });
  }
  // The allowlisted door (T-02): dispatch in-process through the same
  // handler the RN client's registration calls. The context makes the
  // handler fall back to the deps' daemon capture when the shell wires none
  // — the identical in-process single-writer path. Every allowlisted input
  // is validated by the SHARED schema before the handler ever sees it.
  const entry = CONSOLE_RPC_ALLOWLIST.find((allowed) => allowed.method === payload.method);
  if (entry === undefined) {
    return json(response, 404, { ok: false, code: "unknown_method", error: `${payload.method} is not served by the console sidecar (allowlist: ${allowlistSentence()})` });
  }
  const context = options.context?.() ?? {};
  const outcome = await entry.run(options.handlers, params, context);
  if (!outcome.ok) return json(response, 400, { ok: false, code: outcome.code, error: outcome.error });
  return json(response, 200, outcome.reply);
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
