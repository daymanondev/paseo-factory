/** Local writer provisioning is independent of synchronized Ledger snapshots. */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { historyHash } from "./history-identity.ts";
import { historyTargetPath } from "./history-stage.ts";
import { FactoryError } from "./errors.ts";

export function localWriterPath(stateDir: string, projectSlug?: string): string {
  const root = historyTargetPath(stateDir);
  const target = projectSlug === undefined ? join(root, "ledger.jsonl") : join(root, "projects", projectSlug, "ledger.jsonl");
  return join(dirname(root), `${basename(root)}-local-writers`, `${historyHash(target)}.json`);
}
export function readLocalWriterIdentity(stateDir: string, projectSlug?: string): string | undefined {
  let raw: string;
  try { raw = readFileSync(localWriterPath(stateDir, projectSlug), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let value: { version?: unknown; writerId?: unknown };
  try { value = JSON.parse(raw); } catch { throw new FactoryError("writer-identity-invalid", "Local writer identity is damaged; inspect it before explicit reprovisioning"); }
  if (value.version !== 1 || typeof value.writerId !== "string" || value.writerId.trim() === "") throw new FactoryError("writer-identity-invalid", "Unsupported local writer identity");
  return value.writerId;
}
