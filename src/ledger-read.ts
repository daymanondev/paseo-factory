import { readFileSync } from "node:fs";
import { parseLedgerJsonl } from "./ledger-validation.ts";
import type { LedgerValidationOptions } from "./ledger-validation.ts";

/** Read-only adapter: only ENOENT means absent; never repairs or quarantines a live file. */
export function readLedgerEvents(path: string, options: LedgerValidationOptions = {}) {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true as const };
    return { failed: error };
  }
  return parseLedgerJsonl(raw, options);
}
