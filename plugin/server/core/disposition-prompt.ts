/**
 * Disposition-aware Peer prompt synthesis (v0.5.0 ticket 03, ADR 0054 §3):
 * the shared vocabulary the plugin-server prompt builders (the Spool re-poke
 * continuation and the Peer-mark (200k) handoff successor prompt) branch on. The
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

/** The read-only three's canonical evidence expectations (ADR 0054 §2, ADR 0069). */
export const READ_ONLY_DISPOSITION_EVIDENCE: Record<"architect" | "reviewer" | "scout", string> = {
  architect:
    "alternatives considered, the strongest counterargument against your recommendation, the conditions that would reverse it, and supporting file:line evidence",
  reviewer:
    "argue the strongest evidence-backed weakness with concrete claim plus file:line evidence before agreeing (never manufacturing objections when evidence holds), separating blocking defects from non-blocking notes",
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
 * Closing user-turn premise/Gate verification reminder directing the Peer to
 * `agent_ask` before writing code when reality contradicts the brief (ADR 0069).
 */
export const PEER_PREMISE_CHECK_REMINDER =
  "Before writing code, verify the brief's premises and verification command against the actual repository; if reality conflicts with the brief, a prerequisite is missing, or an ambiguity changes behavior, call `agent_ask` immediately rather than guessing.";

/**
 * Contract shape accepted by `activeContractSnapshot` — extends `ContractSet`
 * with optional `reopenConditions` (ADR 0069).
 */
export type ContractSnapshotInput = ContractSet & { reopenConditions?: readonly string[] };

/**
 * Formats optional `reopenConditions` into a prominent `Reopen if:` block for
 * initial Peer briefs, snapshots, and handoff continuation prompts (ADR 0069).
 * Returns `""` when no non-empty conditions exist.
 */
export function formatReopenIfBlock(reopenConditions?: readonly string[]): string {
  if (!Array.isArray(reopenConditions)) return "";
  const items = reopenConditions.map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) return "";
  if (items.length === 1) return `Reopen if: ${items[0]}`;
  return ["Reopen if:", ...items.map((item) => `- ${item}`)].join("\n");
}

/**
 * The compact Active Contract Snapshot (spec Implementation Decision 3): what
 * a `lead_reply_peer` / `lead_repoke_agent` delivery always embeds so an
 * in-place `lead_set_contract` update (`resetPeer: false`) reaches the live
 * Peer — the CURRENT contract re-read at delivery time, never the epoch the
 * spool last cached.
 */
export function activeContractSnapshot(contract: ContractSnapshotInput | undefined): string {
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
  const reopenIf = formatReopenIfBlock(contract?.reopenConditions);
  return [
    `Active Contract Snapshot${contract === undefined ? "" : ` (contract seq ${contract.seq})`}:`,
    `Disposition: ${disposition}`,
    `Gate: ${gate.trim() === "" ? "(none)" : `\`${gate}\``}`,
    `Scope: ${scope}`,
    `Description: ${contract?.description === undefined || contract.description.trim() === "" ? "(no description on this Contract)" : contract.description}`,
    ...(reopenIf === "" ? [] : [reopenIf]),
  ].join("\n");
}

/**
 * The topology-blind, disposition-aware continuation footer for re-poke /
 * reply turns (`lead_reply_peer` / `lead_repoke_agent`): omits Factory
 * internals (`GateQueue` / `Owner` / `Supervisor`) and closes with the
 * `agent_ask` premise-check reminder (ADR 0069).
 */
export function repokeCompletionFooter(task: string, contract: ContractSnapshotInput | undefined): string {
  const disposition = contract?.disposition ?? "engineer";
  const gate = contract?.gate ?? "";
  const evidence = readOnlyDispositionEvidence(disposition);
  if (evidence === undefined) {
    const verificationClause =
      gate.trim() === ""
        ? "automated verification runs asynchronously"
        : `automated verification runs \`${gate}\` asynchronously`;
    return `Continue inside your Task worktree on branch factory/${task}, run fast slice checks during TDD (never pre-run the full cumulative Gate), commit your changes, call \`paseo-factory_agent_claim\` (or \`agent_claim\`), and end your turn immediately once \`queued\`; ${verificationClause}. ${PEER_PREMISE_CHECK_REMINDER}`;
  }
  const gateClause = gate.trim() === "" ? ":" : `, run the gate \`${gate}\` read-only,`;
  return [
    `Continue inside your Task worktree on branch factory/${task}${gateClause} this session is Read-Only (disposition ${disposition}) — ${READ_ONLY_DISPOSITION_FENCE}; never commit, never edit files.`,
    `When done, call \`paseo-factory_agent_claim\` (or \`agent_claim\`) with no commit and no sha, supplying \`--outcome --scope --verification --unknowns\` carrying your ${disposition} evidence: ${evidence}.`,
    PEER_PREMISE_CHECK_REMINDER,
  ].join(" ");
}

/**
 * Topology-blind, disposition-aware continuation footer for Peer-2 automatic
 * handoff prompts (`plugin/server/peer-handoff.ts`), preserving the read-only
 * fence while ending with the `agent_ask` premise-check reminder (ADR 0069).
 */
export function peerHandoffContinuationFooter(disposition: PeerDisposition | undefined): string {
  const effectiveDisposition = disposition ?? "engineer";
  const evidence = readOnlyDispositionEvidence(effectiveDisposition);
  if (evidence === undefined) {
    return `Run fast targeted modular slice tests sequentially with isolated fixtures and explicit timeouts while iterating (never invoke multi-worker bundlers or native compilers inside unit tests, and do not pre-run the full cumulative Gate before claiming). Commit, call \`agent_claim\` (or \`factory-claim\`) for the committed HEAD so automated verification runs asynchronously, and end your turn immediately when queued. ${PEER_PREMISE_CHECK_REMINDER}`;
  }
  return `This succession is Read-Only (disposition ${effectiveDisposition}): ${READ_ONLY_DISPOSITION_FENCE} — the worktree must stay clean at HEAD; never commit, never edit files. Call \`agent_claim\` (or \`factory-claim\`) with no commit and no sha, supplying \`outcome\`, \`scope\`, \`verification\`, and \`unknowns\` carrying your ${effectiveDisposition} evidence: ${evidence}, then end your turn. ${PEER_PREMISE_CHECK_REMINDER}`;
}
