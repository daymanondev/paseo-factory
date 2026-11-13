/**
 * The Factory tab's self-update door (`factory.self.update.status` / `.apply`).
 *
 * Paseo's own `plugin update` follows the repo's DEFAULT BRANCH, which once sat
 * at an old release while newer ones were tagged elsewhere — "Update" proposed
 * a downgrade. This module compares the installed version with the highest
 * `vX.Y.Z` release tag on the remote, and only offers an update when the
 * daemon's own update target IS that tag's commit, so the button can never
 * install anything but the latest release.
 *
 * Every outside call (git, the daemon) is injected, so tests run offline.
 */
import { execFile } from "node:child_process";
import {
  checkDaemonPluginUpdates,
  listDaemonPlugins,
  manageDaemonPlugin,
  readPluginVersionFromDisk,
  type DaemonPluginIdentity,
  type DaemonPluginItem,
} from "./daemon-cli.ts";

export const SELF_PLUGIN_ID = "paseo-factory";
export const DEFAULT_SELF_REMOTE = "https://github.com/daymanondev/paseo-factory.git";
/** `git ls-remote` gives up after this long — the status then reports `latest: null`. */
export const LS_REMOTE_TIMEOUT_MS = 15_000;
/** A good status answers from memory for this long (the Owner's Check button forces a fresh one). */
export const SELF_UPDATE_CACHE_MS = 10 * 60_000;

export interface RemoteTag {
  name: string;
  commit: string;
}
export type RemoteTagsReply = { ok: true; tags: RemoteTag[] } | { ok: false; reason: string };

export interface SelfUpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  note?: string;
}
export type SelfUpdateStatusReply = ({ ok: true } & SelfUpdateStatus) | { ok: false; code: string; error: string };
export type SelfUpdateApplyReply = { ok: true; from: string; to: string } | { ok: false; code: string; error: string };

export interface SelfUpdateDeps {
  home: string;
  /** The running plugin's directory — the version's fallback when the daemon list carries none. */
  pluginDir?: string;
  listPlugins?: typeof listDaemonPlugins;
  checkPluginUpdates?: typeof checkDaemonPluginUpdates;
  managePlugin?: typeof manageDaemonPlugin;
  /** `git ls-remote --tags` by default; tests inject a fake. Never throws. */
  listRemoteTags?: (remote: string) => Promise<RemoteTagsReply>;
  /** Runs right before the daemon update (the Settings path refreshes the Expo skill pack here). */
  beforeUpdate?: () => { ok: true } | { ok: false; reason: string };
  now?: () => number;
}

/** `v1.2.3` / `1.2.3` as a triple; anything else (pre-releases, branches) is not a release tag. */
export function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const delta = a[i]! - b[i]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Parses `git ls-remote --tags` output; a peeled `^{}` line (the commit an annotated tag points at) wins over the tag object's own sha. */
export function parseLsRemoteTags(stdout: string): RemoteTag[] {
  const plain = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{7,64})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (match === null) continue;
    (match[3] === undefined ? plain : peeled).set(match[2]!, match[1]!);
  }
  return [...plain.keys(), ...peeled.keys()]
    .filter((name, index, all) => all.indexOf(name) === index)
    .map((name) => ({ name, commit: (peeled.get(name) ?? plain.get(name))! }));
}

/** The default `listRemoteTags`: a 15s `git ls-remote --tags`, no prompts, never throws. */
export function gitListRemoteTags(remote: string): Promise<RemoteTagsReply> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["ls-remote", "--tags", "--", remote],
        { encoding: "utf8", timeout: LS_REMOTE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null) {
            const detail = `${stderr ?? ""}`.trim().split("\n")[0] ?? "";
            return resolve({ ok: false, reason: detail !== "" ? detail : error.message });
          }
          resolve({ ok: true, tags: parseLsRemoteTags(stdout) });
        },
      );
    } catch (err) {
      resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** The highest `vX.Y.Z` among the tags, with its commit. */
export function highestReleaseTag(tags: readonly RemoteTag[]): { version: string; commit: string } | null {
  let best: { triple: [number, number, number]; version: string; commit: string } | null = null;
  for (const tag of tags) {
    const triple = parseSemver(tag.name);
    if (triple === null) continue;
    if (best === null || compareSemver(triple, best.triple) > 0) best = { triple, version: triple.join("."), commit: tag.commit };
  }
  return best === null ? null : { version: best.version, commit: best.commit };
}

/** Two commit ids name the same commit when one is a prefix of the other (abbreviated shas allowed, 7+ chars). */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

function remoteOf(item: DaemonPluginItem | undefined): string {
  const identity: DaemonPluginIdentity | undefined = item?.installation?.identity;
  if (identity?.kind === "git" && identity.remote !== "") return identity.remote;
  if (item?.remote !== undefined && item.remote !== "") return item.remote;
  return DEFAULT_SELF_REMOTE;
}

const NO_FAILURE_REASON = "no reason given";

/** One computed status; `cacheable` is false for an answer that only says something failed — that retries on the next ask. */
interface Computed {
  reply: SelfUpdateStatusReply;
  cacheable: boolean;
}

export function createSelfUpdate(deps: SelfUpdateDeps) {
  const now = deps.now ?? Date.now;
  let cached: { at: number; status: SelfUpdateStatus } | null = null;
  let inFlight: Promise<SelfUpdateStatusReply> | null = null;

  const compute = async (): Promise<Computed> => {
    const listed = await (deps.listPlugins ?? listDaemonPlugins)(deps.home);
    const item = listed.ok ? listed.plugins.find((p) => p.id === SELF_PLUGIN_ID) : undefined;
    const current = item?.version ?? (deps.pluginDir === undefined ? undefined : readPluginVersionFromDisk(deps.pluginDir));
    const currentTriple = current === undefined ? null : parseSemver(current);
    if (current === undefined || currentTriple === null) {
      return { reply: { ok: false, code: "version-unknown", error: "Could not read the installed Factory plugin version." }, cacheable: false };
    }
    const checkedAt = new Date(now()).toISOString();
    const done = (latest: string | null, updateAvailable: boolean, note?: string, cacheable = true): Computed => ({
      reply: { ok: true, current, latest, updateAvailable, checkedAt, ...(note === undefined ? {} : { note }) },
      cacheable,
    });
    const kind = item?.installation?.identity?.kind ?? item?.source;
    if (kind === "directory") {
      return done(null, false, "Installed from a local folder — reinstall from Settings → Plugins to switch to releases.");
    }

    const tagsReply = await (deps.listRemoteTags ?? gitListRemoteTags)(remoteOf(item));
    if (!tagsReply.ok) return done(null, false, `Could not reach the release list (${tagsReply.reason || NO_FAILURE_REASON}).`, false);
    const latest = highestReleaseTag(tagsReply.tags);
    if (latest === null) return done(null, false, "No release tags were found on the remote.", false);
    if (compareSemver(parseSemver(latest.version)!, currentTriple) <= 0) return done(latest.version, false);

    // A newer release exists. The downgrade guard: the daemon's own update must land exactly on that tag's commit.
    const daemon = await (deps.checkPluginUpdates ?? checkDaemonPluginUpdates)(deps.home);
    const target = daemon.ok ? daemon.statuses.find((row) => row.id === SELF_PLUGIN_ID)?.latestRevision ?? null : null;
    if (!daemon.ok || target === null) {
      const why = daemon.ok ? "it reported no target" : daemon.reason;
      return done(latest.version, false, `Could not confirm what Paseo would install (${why}). Update from Settings → Plugins.`, false);
    }
    if (!sameCommit(target, latest.commit)) {
      return done(latest.version, false, `Paseo's update source is not on v${latest.version} yet — update from Settings → Plugins after the default branch catches up.`);
    }
    return done(latest.version, true);
  };

  const status = async (input: { force?: boolean } = {}): Promise<SelfUpdateStatusReply> => {
    if (input.force !== true) {
      if (cached !== null && now() - cached.at < SELF_UPDATE_CACHE_MS) return { ok: true, ...cached.status };
      if (inFlight !== null) return inFlight;
    }
    const job: Promise<SelfUpdateStatusReply> = compute()
      .then(({ reply, cacheable }) => {
        if (reply.ok && cacheable) {
          const { ok: _ok, ...rest } = reply;
          cached = { at: now(), status: rest };
        }
        return reply;
      })
      .catch((err): SelfUpdateStatusReply => ({ ok: false, code: "failed", error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        if (inFlight === job) inFlight = null;
      });
    inFlight = job;
    return job;
  };

  const apply = async (): Promise<SelfUpdateApplyReply> => {
    const fresh = await status({ force: true });
    if (!fresh.ok) return fresh;
    if (!fresh.updateAvailable || fresh.latest === null) {
      return { ok: false, code: "no-update", error: fresh.note ?? "Factory is already up to date." };
    }
    const prepared = deps.beforeUpdate?.() ?? { ok: true as const };
    if (!prepared.ok) return { ok: false, code: "skill-update-failed", error: prepared.reason };
    cached = null;
    const reply = await (deps.managePlugin ?? manageDaemonPlugin)(deps.home, SELF_PLUGIN_ID, "update");
    if (!reply.ok) return { ok: false, code: "daemon_failed", error: reply.reason };
    return { ok: true, from: fresh.current, to: fresh.latest };
  };

  return { status, apply };
}
