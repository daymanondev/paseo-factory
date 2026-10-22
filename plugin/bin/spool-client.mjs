#!/usr/bin/env node
/**
 * The CLI half of the spool protocol (ADR 0004) — shared by `factory-claim`
 * (the Agent's command) and `factory` (the Owner's command). Plain .mjs on
 * purpose: the daemon's node may lack TypeScript stripping, so the CLIs carry
 * no build step and import no plugin server code. The plugin side lives in
 * `plugin/server/spool.ts`; `test/cli.test.ts` runs both halves against each
 * other so the duplicated protocol cannot drift.
 *
 * Writes are write-then-rename so the plugin never reads a half-written
 * request; replies are read only after they land atomically on the plugin side.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same state root the plugin resolves (`plugin-state/<plugin id>` under the daemon home). */
export function stateDirFor(paseoHome) {
  return join(paseoHome, "plugin-state", "paseo-factory");
}

/** `--home` flag > `PASEO_HOME` > `~/.paseo`, with `~` expansion. */
export function resolveHome(flag) {
  const raw = flag ?? (process.env.PASEO_HOME && process.env.PASEO_HOME.trim() !== "" ? process.env.PASEO_HOME : join(homedir(), ".paseo"));
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

export function spoolRootFor(stateDir) {
  return join(stateDir, "spool");
}

/**
 * Stable JSON serialization of any value — object keys sorted, recursively
 * (arrays keep their order). The canonical form `spoolRequestSemanticKey`
 * builds on; pure, so the same body always serializes to the same string.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The canonical semantic key of a spool request (v0.0.31, ADR 0017 §6): the
 * stable JSON serialization of every request field EXCEPT `id`. Two requests
 * carrying the same payload semantics — a retried `claim` from an offline
 * window, each retry minting a fresh id — key identically, so both the submit
 * side (`submit`, `submitSpoolRequest` in bridge.mjs) and the plugin's drain
 * can deduplicate them. Duplicated on purpose in `plugin/bin/bridge.mjs` and
 * `plugin/server/spool.ts` — the bin .mjs files import no plugin server code
 * (ADR 0004) and bridge.mjs is copied standalone into `<stateDir>/bin/` — with
 * `test/cli.test.ts` guarding the copies against drift.
 */
export function spoolRequestSemanticKey(req) {
  if (req !== null && typeof req === "object" && !Array.isArray(req) && "id" in req) {
    const rest = { ...req };
    delete rest.id;
    return stableStringify(rest);
  }
  return stableStringify(req);
}

/**
 * Scans `spool/requests/*.json` (in filename order — ids are time-prefixed, so
 * submission order) for an un-replied request whose semantic key matches the
 * incoming one — the offline-dedup seam (ADR 0017 §6). Files that already have
 * their reply in `spool/replies/`, and unreadable bodies, never match. Returns
 * `{ id, path }` of the pending original, or undefined when nothing matches.
 */
export function findPendingSemanticDuplicate(spoolRoot, request) {
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

function stampedSeatFromEnv(env = process.env) {
  const raw = typeof env.PASEO_FACTORY_SEAT === "string" ? env.PASEO_FACTORY_SEAT.trim() : "";
  return raw === "supervisor" || raw === "lead" || raw === "agent" ? raw : undefined;
}

/**
 * Drops a request file and returns its path — unless an un-replied request
 * with the identical semantic payload already sits in `spool/requests/`
 * (v0.0.31, ADR 0017 §6), in which case that pending request's id and file are
 * reused and NO second file is written: a retried submit while the plugin is
 * offline stacks zero duplicates. On dedup the incoming `request.id` is
 * mutated to the reused id, so the caller polls the reply of the request that
 * is actually queued. The id travels in the filename and the body — a reply to
 * this exact id is the only thing this client will accept.
 */
export function submit(spoolRoot, request) {
  const seat = request.seat ?? stampedSeatFromEnv();
  const payload = seat === undefined || request.seat !== undefined || request.kind === "claim" ? request : { ...request, seat };
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const pending = findPendingSemanticDuplicate(spoolRoot, payload);
  if (pending !== undefined) {
    request.id = pending.id;
    if (payload !== request) payload.id = pending.id;
    return pending.path;
  }
  const path = join(requestsDir, `${payload.id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
  renameSync(tmp, path);
  return path;
}

/** Polls for the plugin's reply; resolves the parsed reply, or null on timeout. */
export function awaitReply(spoolRoot, id, timeoutMs, pollMs = 200) {
  const replyPath = join(spoolRoot, "replies", `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (existsSync(replyPath)) {
        try {
          resolve(JSON.parse(readFileSync(replyPath, "utf8")));
          return;
        } catch {
          // A half-visible read should be impossible (atomic rename), but if
          // it ever happens, keep polling rather than fail on one bad instant.
        }
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * Time-prefixed, so request filenames sort in submission order: the plugin
 * drains the requests directory in name order, and a contract submitted just
 * before its claim must not be overtaken.
 */
export function randomId() {
  return `${Date.now().toString(36)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}
