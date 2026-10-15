import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { FactoryError } from "../src/errors.ts";
import { saveLanes } from "../src/lanes.ts";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Gates run with this process's environment — the plugin's under the daemon,
 * this suite's here — and fixture contracts gate on `npm test`. A suite started
 * by absolute node path (exactly what the factory's own gate does) can carry a
 * PATH without npm on it, so resolve npm from beside the running node before
 * any gate inherits this env. No assertion depends on it; without it the
 * fixture gates die at `npm: command not found` instead of running.
 */
process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;

/** Predicate for assert.throws / assert.rejects that matches a FactoryError code. */
export function factoryErrorCode(code: string): (err: unknown) => err is FactoryError {
  return (err: unknown): err is FactoryError => err instanceof FactoryError && err.code === code;
}

export function makeTempDir(prefix = "paseo-factory-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function disposeDir(t: TestContext, dir: string): void {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
}

export function copyFixture(name: string, dest: string): void {
  cpSync(join(repoRoot, "fixtures", name), dest, { recursive: true });
}

/**
 * Makes `dir` a git workspace with one commit and returns that commit's full
 * sha — claims are verified against the workspace (ADR 0002), so tests need a
 * real commit to claim, never a fake sha.
 */
export function gitCommitAll(dir: string, message = "test commit"): string {
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Factory Test"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", message]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/** Commits current changes (the agent's "work") and returns the new full sha. */
export function gitCommitChanges(dir: string, message: string): string {
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  };
  run(["add", "-A"]);
  run(["commit", "-q", "-m", message]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/** One request the fake eye received — body already parsed when JSON. */
export interface FakeEyeRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export type FakeEyeResponse = { status: number; payload: unknown; headers?: Record<string, string> } | { hang: true };

export interface FakeEye {
  url: string;
  requests: FakeEyeRequest[];
  /** Closes the listener so the port refuses connections — a dead daemon. */
  stop(): Promise<void>;
}

/**
 * A local stand-in for the eye's Anthropic-messages API: hermetic, loopback
 * only, no network. `respond` is called per request so a test can change its
 * answer mid-pass (retry rules); `{ hang: true }` never answers, for budget
 * tests. Every request is recorded for prompt-content assertions.
 */
export async function startFakeEye(t: TestContext, respond: () => FakeEyeResponse): Promise<FakeEye> {
  const requests: FakeEyeRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // kept raw — non-JSON bodies are a legitimate failure case
      }
      requests.push({ path: req.url ?? "/", headers: req.headers, body });
      const answer = respond();
      if ("hang" in answer) return;
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
      res.end(JSON.stringify(answer.payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  t.after(() => stop());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake eye did not get a port");
  return { url: `http://127.0.0.1:${address.port}`, requests, stop };
}

/** Writes the eye's config (ticket 04 shape) pointing at the fake server. */
export function writeEyeConfig(stateDir: string, baseUrl: string, model = "fake-eye-1"): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "eye.json"), `${JSON.stringify({ provider: "fake", model, apiKey: "test-key", baseUrl }, null, 2)}\n`);
}

/** The standard Anthropic-messages text answer. */
export function eyeAnswer(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

/** One recorded invocation of the fake lane CLI. */
export interface FakeCopilotCall {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

/** What one fake CLI invocation answers — the result shape the runner contract returns. */
export interface FakeCliResult {
  code: number;
  stdout: string;
  stderr?: string;
  timedOut?: boolean;
  /** Delay before answering (ms) — budget tests let the clock run out. */
  delayMs?: number;
}

/**
 * A stand-in for a lane's CLI runner (the watch's Copilot seam, generalized
 * to every family in v0.0.13): records every invocation and answers from a
 * script — hermetic, no network, no binary. The script is called per
 * invocation so a test can fail the first call and pass the second (the
 * retry rule) or run out the budget.
 */
export function fakeCopilotRunner(script: (call: FakeCopilotCall, index: number) => FakeCliResult) {
  const calls: FakeCopilotCall[] = [];
  const runner = async (call: FakeCopilotCall) => {
    calls.push(call);
    const answer = script(call, calls.length - 1);
    if (answer.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "", timedOut: answer.timedOut ?? false };
  };
  return { runner, calls };
}

/** Writes lanes.json lanes over the defaults (v0.0.13) — the config tests pin a lane with. */
export function writeLanes(stateDir: string, lanes: Record<string, string>): void {
  const result = saveLanes(stateDir, lanes);
  if (!result.ok) throw new Error(result.reason);
}

/** The CLI's happy answer: the five `name: number` lines, the strict output contract satisfied. */
export function copilotAnswerLines(answers: Record<string, number>): string {
  return Object.entries(answers)
    .map(([name, probability]) => `${name}: ${probability}`)
    .join("\n");
}
