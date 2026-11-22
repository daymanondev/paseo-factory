import { spawn } from "node:child_process";
import { inspectArtifact } from "./artifact.ts";
import { killProcessGroup } from "./process-policy.ts";
import { DEFAULT_GATE_TIMEOUT_MS, GATE_OUTPUT_CAP_BYTES, REPORT_NOTE_MAX_CHARS } from "./constants.ts";
import type { Verdict } from "./events.ts";

export interface GateInput {
  /** Shell command from the contract, e.g. `npm test`. Run through /bin/sh. */
  cmd: string;
  /** Task workspace — the command's cwd and the base for the artifact path. */
  cwd: string;
  /** Required relative path. The existing target must resolve inside cwd for a green verdict. */
  artifact?: string | undefined;
  /** Kill + red after this long. Defaults to DEFAULT_GATE_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
  /** Optional cancellation signal to immediately reap `-pgid` and end red. */
  signal?: AbortSignal | undefined;
  /** Optional daemon-shutdown signal: reaps `-pgid` cleanly without marking owner cancel. */
  shutdownSignal?: AbortSignal | undefined;
  /** Note recorded when aborted via `signal` (defaults to `"cancelled-by-owner"`). */
  cancelNote?: string | undefined;
  /** Optional callback invoked right after spawning with the shell PID (diagnostic metadata only). */
  onSpawn?: ((pid: number | undefined) => void) | undefined;
}

export interface GateResult {
  exit: number | null;
  verdict: Verdict;
  note: string;
  timedOut: boolean;
  /** True when stopped via `signal`. */
  cancelled?: boolean;
  /** True when stopped via `shutdownSignal` (plugin unload/restart). */
  abortedOnShutdown?: boolean;
  /**
   * The raw combined stdout+stderr as it arrived, tail-capped to
   * GATE_OUTPUT_CAP_BYTES — persisted in full per attempt (ticket 02a) and fed
   * to the fresh-eyes pass. Undefined only for results synthesized without a
   * gate run (pre-gate station reds); a spawn failure rejects instead.
   */
  output?: string;
  /**
   * Whether the contract's artifact existed inside the execution Workspace when the gate closed:
   * the watch's `artifact_check` code answer, as a fact rather than a parsed
   * note. True/false whenever the gate ran with an artifact; undefined when
   * there was no artifact or no gate run.
   */
  artifactPresent?: boolean;
}

function resolvedCancelNote(signal: AbortSignal | undefined, cancelNote: string | undefined): string {
  const reason = signal?.reason;
  if (typeof reason === "string" && reason.trim() !== "") return reason.trim();
  return cancelNote ?? "cancelled-by-owner";
}

/**
 * Runs the contract's gate command and returns the facts: exit code, a capped
 * one-line note from the output tail, and the verdict. The verdict is green
 * only when the command exits 0 AND the contract's artifact exists inside its Workspace.
 *
 * Timeout policy stays minimal: kill the process group and record red. The
 * captured output survives in full (capped at 2 MB) in the result and, one
 * level up, in `gate-<task>-<attempt>.log` next to the report.
 */
export function runGate(input: GateInput): Promise<GateResult> {
  const { cmd, cwd, artifact, signal, shutdownSignal, cancelNote, onSpawn } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

  if (shutdownSignal?.aborted) {
    return Promise.resolve({
      exit: null,
      verdict: "red",
      note: "daemon-shutdown",
      timedOut: false,
      abortedOnShutdown: true,
    });
  }
  if (signal?.aborted) {
    return Promise.resolve({
      exit: null,
      verdict: "red",
      note: resolvedCancelNote(signal, cancelNote),
      timedOut: false,
      cancelled: true,
    });
  }

  return new Promise((resolve, reject) => {
    let raw = "";
    let timedOut = false;
    let cancelled = false;
    let abortedOnShutdown = false;
    let settled = false;

    // detached: true makes the shell a process-group leader so a timeout can
    // kill the whole tree (npm spawns children), not just the shell.
    // NODE_TEST_CONTEXT must not leak: it switches a nested `node --test`
    // gate into silent child mode (0 tests, exit 0 — a false green).
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(cmd, {
      shell: true,
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn?.(child.pid);

    // One interleaved stream, kept from the end: the note's summary and the
    // persisted log both want the output as it happened, not stdout-then-stderr.
    const keepRaw = (prev: string, chunk: Buffer): string => (prev + chunk.toString("utf8")).slice(-GATE_OUTPUT_CAP_BYTES);
    child.stdout.on("data", (chunk: Buffer) => {
      raw = keepRaw(raw, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      raw = keepRaw(raw, chunk);
    });

    let graceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanup: Promise<void> | undefined;
    const reapGroup = (immediateSigKill = false): Promise<void> => {
      if (immediateSigKill) killProcessGroup(child, "SIGKILL");
      if (cleanup !== undefined) return cleanup;
      if (immediateSigKill) {
        cleanup = Promise.resolve();
      } else {
        killProcessGroup(child, "SIGTERM");
        cleanup = new Promise((done) => {
          graceKillTimer = setTimeout(() => {
            killProcessGroup(child, "SIGKILL");
            done();
          }, 50);
        });
      }
      return cleanup;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      reapGroup(true);
    }, timeoutMs);

    const onAbort = () => {
      if (settled || timedOut || abortedOnShutdown) return;
      cancelled = true;
      clearTimeout(timer);
      void reapGroup(true);
    };
    const onShutdown = () => {
      if (settled || timedOut || cancelled) return;
      abortedOnShutdown = true;
      clearTimeout(timer);
      void reapGroup(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

    child.on("exit", () => {
      // Command execution ended. Cleanup has its own bound and must finish
      // even when redirected descendants let both output streams close early.
      clearTimeout(timer);
      void reapGroup(false);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      shutdownSignal?.removeEventListener("abort", onShutdown);
      clearTimeout(timer);
      if (graceKillTimer !== undefined) clearTimeout(graceKillTimer);
      reject(err);
    });

    child.on("close", async (code) => {
      if (settled) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      shutdownSignal?.removeEventListener("abort", onShutdown);
      await reapGroup(false);
      if (settled) return;
      settled = true;

      const artifactState = artifact === undefined ? undefined : inspectArtifact(cwd, artifact);
      if (abortedOnShutdown) {
        resolve({
          exit: null,
          verdict: "red",
          note: "daemon-shutdown",
          timedOut: false,
          abortedOnShutdown: true,
        });
        return;
      }
      if (timedOut) {
        resolve({ exit: null, verdict: "red", note: `gate killed after ${timeoutMs}ms (timeout)`, timedOut: true, output: raw, ...(artifactState === undefined ? {} : { artifactPresent: artifactState.present }) });
        return;
      }
      if (cancelled) {
        resolve({
          exit: null,
          verdict: "red",
          note: resolvedCancelNote(signal, cancelNote),
          timedOut: false,
          cancelled: true,
          output: raw,
          ...(artifactState === undefined ? {} : { artifactPresent: artifactState.present }),
        });
        return;
      }

      const outputNote = clipNote(raw);
      if (artifactState !== undefined && !artifactState.present) {
        const missingNote = artifactState.note;
        resolve({
          exit: code,
          verdict: "red",
          note: code === 0 ? missingNote : outputNote === "" ? missingNote : outputNote,
          timedOut: false,
          output: raw,
          artifactPresent: false,
        });
        return;
      }

      const verdict: Verdict = code === 0 ? "green" : "red";
      const note = code === null && outputNote === "" ? "killed by signal" : outputNote;
      resolve({ exit: code, verdict, note, timedOut: false, output: raw, ...(artifact === undefined ? {} : { artifactPresent: true }) });
    });
  });
}

/**
 * The note keeps its one-line summary role: whitespace collapsed, at most
 * REPORT_NOTE_MAX_CHARS measured from the end (test summaries live at the
 * end). A truncation cuts at a word boundary and is marked with a leading
 * ellipsis — a note must never begin mid-word (ticket 02c).
 */
function clipNote(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= REPORT_NOTE_MAX_CHARS) return collapsed;
  const budget = REPORT_NOTE_MAX_CHARS - 1; // leave room for the ellipsis
  let kept = collapsed.slice(-budget);
  // The char just before the cut tells whether the first kept word is whole.
  if (!/\s/.test(collapsed[collapsed.length - budget - 1] ?? "")) {
    kept = kept.replace(/^\S+\s*/, "");
  }
  return `…${kept}`;
}
