/**
 * The daemon CLI bridge (v0.0.13, ADR 0009 §3): the few daemon acts the
 * in-process PaseoApi does not expose — setting a live agent's model, and
 * stopping a running agent — ride a child process into the paseo CLI's own
 * client (the PigMonitor-proven pattern): locate `paseo` on PATH, resolve
 * `<cli>/../dist/utils`, spawn node importing its `connectToDaemon` +
 * `selectDaemonTarget`, call the method, print JSON. `paseo agent stop` is a
 * plain CLI invocation. Both are best-effort callers: a failure is a named
 * reason in the reply, never a thrown error — the config of record stays
 * lanes.json either way.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter as pathDelimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type DaemonReply = { ok: true } | { ok: false; reason: string };

/** How long a bridge call may take before the socket/child is closed. */
const BRIDGE_TIMEOUT_MS = 30_000;

/** Direct daemon WebSocket call using `<home>/paseo.pid` and `<home>/local-credential` (same protocol as driver.mjs). */
function daemonWsRequest(
  home: string,
  message: Record<string, unknown>,
  responseType: string,
): Promise<DaemonReply> | null {
  const pidPath = join(home, "paseo.pid");
  const credPath = join(home, "local-credential");
  if (!existsSync(pidPath) || !existsSync(credPath)) return null;
  let listen: string;
  let token: string;
  try {
    const pid = JSON.parse(readFileSync(pidPath, "utf8")) as { listen?: unknown };
    token = readFileSync(credPath, "utf8").trim();
    if (typeof pid.listen !== "string" || pid.listen === "" || token === "") return null;
    listen = pid.listen;
  } catch {
    return null;
  }
  const requestId = `factory-bridge-${randomUUID().slice(0, 8)}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${listen}/ws`);
    let settled = false;
    const finish = (reply: DaemonReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `no ${responseType} within ${BRIDGE_TIMEOUT_MS}ms` }), BRIDGE_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: `paseo-factory-surface-${randomUUID().slice(0, 8)}`,
          clientType: "cli",
          protocolVersion: 1,
          auth: { kind: "localCredential", token },
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (envelope.type === "hello.rejected") {
        finish({ ok: false, reason: `daemon rejected hello: ${String(envelope.reason ?? "")}` });
        return;
      }
      if (envelope.type !== "session" || typeof envelope.message !== "object" || envelope.message === null) return;
      const msg = envelope.message as { type?: string; payload?: { status?: string; requestId?: string; error?: string | null } };
      if (msg.type === "status" && msg.payload?.status === "server_info") {
        ws.send(JSON.stringify({ type: "session", message: { ...message, requestId } }));
        return;
      }
      if (msg.type === "rpc_error" && msg.payload?.requestId === requestId) {
        finish({ ok: false, reason: msg.payload.error ?? "daemon rpc error" });
        return;
      }
      if (msg.type === responseType && msg.payload?.requestId === requestId) {
        if (typeof msg.payload.error === "string" && msg.payload.error !== "") {
          finish({ ok: false, reason: msg.payload.error });
        } else {
          finish({ ok: true });
        }
      }
    });
    ws.addEventListener("error", () => finish({ ok: false, reason: `daemon socket error (ws://${listen}/ws)` }));
    ws.addEventListener("close", () => finish({ ok: false, reason: "daemon socket closed before response" }));
  });
}

/** The bridge body: import the CLI's own daemon client, call one method, print JSON. */
const BRIDGE = `
const [utils, method] = process.argv.slice(1);
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const args = JSON.parse(Buffer.concat(input).toString("utf8"));
const { connectToDaemon } = await import(utils + "/client.js");
const { selectDaemonTarget } = await import(utils + "/daemon-target.js");
const client = await connectToDaemon({ target: selectDaemonTarget({}) });
try {
  const result = await client[method](...args);
  process.stdout.write(JSON.stringify(result ?? null));
} finally {
  await client.close();
}
`;

/**
 * Resolves the paseo CLI's `dist/utils` directory from PATH — null when the CLI or its utils are absent.
 * The search path splits on `node:path`'s `delimiter` (`:` on POSIX, `;` on Windows, v0.0.17) —
 * the separator is a parameter only so tests can exercise the Windows arm on any host.
 */
export function cliUtils(searchPath: string = process.env.PATH ?? "", separator: string = pathDelimiter): string | null {
  for (const dir of searchPath.split(separator)) {
    if (dir === "") continue;
    const bin = join(dir, "paseo");
    if (!existsSync(bin)) continue;
    const utils = join(dirname(realpathSync(bin)), "..", "dist", "utils");
    if (existsSync(join(utils, "client.js")) && existsSync(join(utils, "daemon-target.js"))) return utils;
  }
  return null;
}

/** One bridge method call — JSON over stdio, one deadline, a named reason on any death. */
function bridgeCall(method: string, args: unknown[], home?: string): Promise<DaemonReply> {
  const utils = cliUtils();
  if (utils === null) {
    return Promise.resolve({ ok: false, reason: "the paseo CLI was not found on the plugin's PATH — cannot reach the daemon methods the in-process API lacks" });
  }
  return new Promise((resolve) => {
    const env = home === undefined ? { ...process.env, NO_COLOR: "1" } : { ...process.env, PASEO_HOME: home, NO_COLOR: "1" };
    const child = spawn(process.execPath, ["--input-type=module", "-e", BRIDGE, pathToFileURL(utils).href, method], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), BRIDGE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      const stderr = Buffer.concat(err).toString("utf8");
      const said = /^\w*Error: (.+)$/m.exec(stderr)?.[1] ?? stderr.trim();
      resolve({ ok: false, reason: said !== "" ? said : `the paseo CLI bridge exited with ${code ?? "a signal"}` });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(args));
  });
}

/** Updates a live agent's model over the daemon's WebSocket RPC (or CLI fallback). */
export function setAgentModelViaCli(agentId: string, model: string, home?: string): Promise<DaemonReply> {
  const targetHome = home ?? process.env.PASEO_HOME;
  if (targetHome !== undefined) {
    const wsCall = daemonWsRequest(targetHome, { type: "set_agent_model_request", agentId, modelId: model }, "set_agent_model_response");
    if (wsCall !== null) return wsCall;
  }
  return bridgeCall("setAgentModel", [agentId, model], home);
}

/** Updates a live agent's thinking option over the daemon's WebSocket RPC (or CLI fallback). */
export function setAgentThinkingViaCli(agentId: string, thinkingOptionId: string, home?: string): Promise<DaemonReply> {
  const targetHome = home ?? process.env.PASEO_HOME;
  if (targetHome !== undefined) {
    const wsCall = daemonWsRequest(targetHome, { type: "set_agent_thinking_request", agentId, thinkingOptionId }, "set_agent_thinking_response");
    if (wsCall !== null) return wsCall;
  }
  return bridgeCall("setAgentThinkingOption", [agentId, thinkingOptionId], home);
}

/** Cancels a running agent over the daemon's WebSocket RPC (or `paseo agent stop` fallback). */
export function stopAgentViaCli(agentId: string, home?: string): Promise<DaemonReply> {
  const targetHome = home ?? process.env.PASEO_HOME;
  if (targetHome !== undefined) {
    const wsCall = daemonWsRequest(targetHome, { type: "cancel_agent_request", agentId }, "cancel_agent_response");
    if (wsCall !== null) return wsCall;
  }
  return new Promise((resolve) => {
    const argv = home === undefined ? ["agent", "stop", agentId] : ["--home", home, "agent", "stop", agentId];
    const env = home === undefined ? process.env : { ...process.env, PASEO_HOME: home };
    const probe = spawnSync("paseo", argv, { encoding: "utf8", timeout: BRIDGE_TIMEOUT_MS, env });
    if (probe.status === 0) return resolve({ ok: true });
    const detail = (probe.stderr || probe.stdout || "").trim().split("\n")[0] ?? "";
    resolve({ ok: false, reason: detail !== "" ? detail : `paseo agent stop exited with ${probe.status ?? "a signal"}` });
  });
}
