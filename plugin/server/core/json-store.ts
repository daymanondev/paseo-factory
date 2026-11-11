/** Shared durable-JSON helpers for per-Project and machine state files. */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { FactoryError } from "./errors.ts";
import { LedgerAdmission } from "./history-admission.ts";
import { writeDurableFile } from "./history-stage.ts";

/** Reads a JSON file; a missing file is `undefined`, anything unreadable is a named refusal. */
export function readOptionalJson(path: string, code = "state-json-invalid"): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new FactoryError(code, `${code}: ${path}: ${String(error)}`);
  }
}

/** Crash-safe write: temp file, fsync, rename, directory fsync. */
export function atomicJson(path: string, value: unknown): void {
  writeDurableFile(path, JSON.stringify(value, null, 2) + "\n");
}

const mutation = new AsyncLocalStorage<string>();
/** Serialises state-directory writes behind the Ledger admission gate; re-entrant for the same state dir. */
export function stateMutation<T>(state: string, fn: () => T): T {
  return mutation.getStore() === state
    ? fn()
    : LedgerAdmission.stateMutation(state, () => mutation.run(state, fn));
}
