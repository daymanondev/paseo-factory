/**
 * The spool client's declaration — see spool-client.mjs for why it exists
 * (plain .mjs, no build step, no plugin server imports; the protocol's
 * plugin half lives in plugin/server/spool.ts and test/cli.test.ts runs
 * both halves against each other).
 */

export declare function stateDirFor(paseoHome: string): string;
/** `--home` flag > `PASEO_HOME` > `~/.paseo`, with `~` expansion. */
/** Which rung of the home precedence won: `--home`, `PASEO_HOME` or the `~/.paseo` default. */
export declare function resolveHomeSource(flag: string | undefined, env?: Record<string, string | undefined>): "--home" | "PASEO_HOME" | "default";
export declare function resolveHome(flag: string | undefined): string;
/** The Factory seat the shell is stamped with (`PASEO_FACTORY_SEAT`), or undefined for the Owner. */
export declare function stampedSeatFromEnv(env?: Record<string, string | undefined>): "supervisor" | "lead" | "agent" | undefined;
export declare function spoolRootFor(stateDir: string): string;
/** Drops a request file (write-then-rename) and returns its path; the id travels in the filename and the body. */
export declare function submit(spoolRoot: string, request: { id: string; kind: string; [key: string]: unknown }): string;
/** Polls for the plugin's reply; resolves the parsed reply, or null on timeout. */
export declare function awaitReply(spoolRoot: string, id: string, timeoutMs: number, pollMs?: number): Promise<Record<string, unknown> | null>;
/** Time-prefixed request id — filenames sort in submission order. */
export declare function randomId(): string;
/**
 * The canonical semantic key of a spool request (v0.0.31, ADR 0017 §6): the
 * stable JSON serialization of every request field EXCEPT `id`.
 */
export declare function spoolRequestSemanticKey(req: unknown): string;
/**
 * Finds an un-replied request whose semantic key matches the incoming one —
 * the offline-dedup seam. Returns `{ id, path }` of the pending original, or
 * undefined when nothing matches.
 */
export declare function findPendingSemanticDuplicate(
  spoolRoot: string,
  request: unknown,
): { id: string; path: string } | undefined;
