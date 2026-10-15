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
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type DaemonReply = { ok: true } | { ok: false; reason: string };

/** How long a bridge call may take before the child is killed. */
const BRIDGE_TIMEOUT_MS = 30_000;

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

/** Resolves the paseo CLI's `dist/utils` directory from PATH — null when the CLI or its utils are absent. */
export function cliUtils(searchPath: string = process.env.PATH ?? ""): string | null {
  for (const dir of searchPath.split(":")) {
    if (dir === "") continue;
    const bin = join(dir, "paseo");
    if (!existsSync(bin)) continue;
    const utils = join(dirname(realpathSync(bin)), "..", "dist", "utils");
    if (existsSync(join(utils, "client.js")) && existsSync(join(utils, "daemon-target.js"))) return utils;
  }
  return null;
}

/** One bridge method call — JSON over stdio, one deadline, a named reason on any death. */
function bridgeCall(method: string, args: unknown[]): Promise<DaemonReply> {
  const utils = cliUtils();
  if (utils === null) {
    return Promise.resolve({ ok: false, reason: "the paseo CLI was not found on the plugin's PATH — cannot reach the daemon methods the in-process API lacks" });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", BRIDGE, pathToFileURL(utils).href, method], {
      env: { ...process.env, NO_COLOR: "1" },
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

/** Updates a live agent's model through the CLI's own daemon client (setAgentModel). */
export function setAgentModelViaCli(agentId: string, model: string): Promise<DaemonReply> {
  return bridgeCall("setAgentModel", [agentId, model]);
}

/** Cancels a running agent (`paseo agent stop`) — best-effort, a named reason on failure. */
export function stopAgentViaCli(agentId: string): Promise<DaemonReply> {
  return new Promise((resolve) => {
    const probe = spawnSync("paseo", ["agent", "stop", agentId], { encoding: "utf8", timeout: BRIDGE_TIMEOUT_MS });
    if (probe.status === 0) return resolve({ ok: true });
    const detail = (probe.stderr || probe.stdout || "").trim().split("\n")[0] ?? "";
    resolve({ ok: false, reason: detail !== "" ? detail : `paseo agent stop exited with ${probe.status ?? "a signal"}` });
  });
}
