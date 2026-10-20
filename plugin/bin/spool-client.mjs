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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

function stampedSeatFromEnv(env = process.env) {
  const raw = typeof env.PASEO_FACTORY_SEAT === "string" ? env.PASEO_FACTORY_SEAT.trim() : "";
  return raw === "supervisor" || raw === "lead" || raw === "agent" ? raw : undefined;
}

/**
 * Drops a request file and returns it. The id travels in the filename and the
 * body — a reply to this exact id is the only thing this client will accept.
 */
export function submit(spoolRoot, request) {
  const seat = request.seat ?? stampedSeatFromEnv();
  const payload = seat === undefined || request.seat !== undefined || request.kind === "claim" ? request : { ...request, seat };
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
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
