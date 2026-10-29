/** Canonical atomic spool transport; generated into standalone CLI and bridge assets. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The canonical semantic key of a spool request (v0.0.31, ADR 0017 §6): the
 * stable JSON serialization of every request field EXCEPT `id`. Generated
 * standalone clients and the daemon share this implementation.
 */
export function spoolRequestSemanticKey(req: unknown): string {
  if (req !== null && typeof req === "object" && !Array.isArray(req) && "id" in req) {
    const rest = { ...req };
    delete (rest as Record<string, unknown>).id;
    return stableStringify(rest);
  }
  return stableStringify(req);
}

/**
 * Scans `spool/requests/*.json` (filename order = submission order) for an
 * un-replied request whose semantic key matches — the offline-dedup seam
 * (ADR 0017 §6). Returns `{ id, path }` of the pending original, or undefined.
 */
export function findPendingSemanticDuplicate(spoolRoot: string, request: unknown): { id: string; path: string } | undefined {
  const requestsDir = join(spoolRoot, "requests");
  let names;
  try {
    names = readdirSync(requestsDir).sort();
  } catch {
    return undefined;
  }
  const key = spoolRequestSemanticKey(request);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (existsSync(join(spoolRoot, "replies", name))) continue;
    let body;
    try {
      body = JSON.parse(readFileSync(join(requestsDir, name), "utf8"));
    } catch {
      continue; // a half-written or corrupt file is never a dedup match
    }
    if (spoolRequestSemanticKey(body) === key) {
      return { id: name.slice(0, -".json".length), path: join(requestsDir, name) };
    }
  }
  return undefined;
}

export function submitSpoolRequest(spoolRoot: string, request: Record<string, unknown> & { id: string }): string {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const pending = findPendingSemanticDuplicate(spoolRoot, request);
  if (pending !== undefined) {
    request.id = pending.id;
    return pending.path;
  }
  const path = join(requestsDir, `${request.id}.json`);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(request)}\n`);
  renameSync(tmp, path);
  return path;
}

export function awaitSpoolReply(spoolRoot: string, id: string, timeoutMs = 600_000, pollMs = 50): Promise<Record<string, unknown> | null> {
  const replyPath = join(spoolRoot, "replies", `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const tick = () => {
      if (existsSync(replyPath)) {
        try {
          resolvePromise(JSON.parse(readFileSync(replyPath, "utf8")));
          return;
        } catch {
          // retry if mid-rename
        }
      }
      if (Date.now() >= deadline) {
        resolvePromise(null);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}
