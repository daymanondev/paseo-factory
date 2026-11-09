/**
 * Disposition-aware Peer prompt synthesis (v0.5.0 ticket 03, ADR 0054 §3):
 * the shared vocabulary the plugin-server prompt builders (the Spool re-poke
 * continuation and the 160k Peer handoff successor prompt) branch on. The
 * plain-JS CLIs (`plugin/bin/driver.mjs`, `plugin/bin/bridge.mjs`) carry their
 * own mirrors — they cannot import this module (ADR 0004).
 *
 * A read-only Peer (`scout | architect | reviewer`) is never told to commit:
 * every completion instruction names the `read-only-disposition-fence`, keeps
 * the claim invocation free of `commit` / `--sha`, and states the
 * disposition's own Paseo Room evidence expectations (ADR 0054 §2) so the
 * 6-Field Handoff carries actionable findings.
 */
import { isReadOnlyPeerDisposition, type PeerDisposition } from "./events.ts";
import type { ContractSet } from "./events.ts";

/** The read-only three's canonical evidence expectations (ADR 0054 §2). */
export const READ_ONLY_DISPOSITION_EVIDENCE: Record<"architect" | "reviewer" | "scout", string> = {
  architect:
    "alternatives considered, the strongest counterargument against your recommendation, the conditions that would reverse it, and supporting file:line evidence",
  reviewer: "a concrete claim plus file:line evidence per finding, separating blocking defects from non-blocking notes",
  scout: "concrete file:line evidence paths, the remaining unknowns, and your confidence (low | medium | high)",
};

/** The evidence sentence a read-only disposition owes in its handoff — `undefined` for `engineer`. */
export function readOnlyDispositionEvidence(disposition: PeerDisposition | undefined): string | undefined {
  return isReadOnlyPeerDisposition(disposition)
    ? READ_ONLY_DISPOSITION_EVIDENCE[disposition as "architect" | "reviewer" | "scout"]
    : undefined;
}

/** The fence sentence every read-only completion instruction states (ADR 0054 §3). */
export const READ_ONLY_DISPOSITION_FENCE = "the read-only-disposition-fence forbids file edits and `git commit`";

/**
 * The compact Active Contract Snapshot (spec Implementation Decision 3): what
 * a `lead_repoke_agent` delivery always embeds so an in-place
 * `lead_set_contract` update (`resetPeer: false`) reaches the live Peer — the
 * CURRENT contract re-read at delivery time, never the epoch the spool last
 * cached.
 */
export function activeContractSnapshot(contract: ContractSet | undefined): string {
  const disposition = contract?.disposition ?? "engineer";
  const gate = contract?.gate ?? "";
  // A read-only Contract's scope is normalized to [] (recorded omitted on the
  // line — ADR 0054 §1): an omitted scope there reads as no writable boundary,
  // never as the engineer's unrestricted default.
  const scope =
    contract?.scope === undefined
      ? isReadOnlyPeerDisposition(disposition)
        ? "(none — read-only)"
        : "(unrestricted)"
      : contract.scope.length === 0
        ? "(none)"
        : contract.scope.join(", ");
  return [
    `Active Contract Snapshot${contract === undefined ? "" : ` (contract seq ${contract.seq})`}:`,
    `Disposition: ${disposition}`,
    `Gate: ${gate.trim() === "" ? "(none)" : `\`${gate}\``}`,
    `Scope: ${scope}`,
    `Description: ${contract?.description === undefined || contract.description.trim() === "" ? "(no description on this Contract)" : contract.description}`,
  ].join("\n");
}

/**
 * The disposition-aware completion footer both re-poke branches close with:
 * the engineer disposition keeps today's sentence verbatim; a read-only
 * disposition swaps the commit instruction for the fence, the claim
 * invocation without `commit` / `--sha`, and its own evidence expectations.
 */
export function repokeCompletionFooter(task: string, contract: ContractSet | undefined): string {
  const disposition = contract?.disposition ?? "engineer";
  const gate = contract?.gate ?? "";
  const evidence = readOnlyDispositionEvidence(disposition);
  if (evidence === undefined) {
    return `Continue inside your Task worktree on branch factory/${task}, run the gate \`${gate}\`, commit your changes, and call \`paseo-factory_agent_claim\` (or \`agent_claim\`).`;
  }
  const gateClause = gate.trim() === "" ? ":" : `, run the gate \`${gate}\` read-only,`;
  return [
    `Continue inside your Task worktree on branch factory/${task}${gateClause} this session is Read-Only (disposition ${disposition}) — ${READ_ONLY_DISPOSITION_FENCE}; never commit, never edit files.`,
    `When done, call \`paseo-factory_agent_claim\` (or \`agent_claim\`) with no commit and no sha, supplying \`--outcome --scope --verification --unknowns\` carrying your ${disposition} evidence: ${evidence}.`,
  ].join(" ");
}
