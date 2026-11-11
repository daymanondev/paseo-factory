/** Bounded, durable succession for task-bound Peers. All mutations run on the Project lane. */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "./core/factory.ts";
import type { ContractSet, LedgerEvent } from "./core/events.ts";
import { projectStateDir } from "./core/project.ts";
import { projectTask } from "./core/task-state.ts";
import { atomicJson, readOptionalJson } from "./core/json-store.ts";
import { taskWorktreeBranch } from "./core/workspace.ts";
import type { LeadTurnEndedInput } from "./lead-mailbox.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "./surface-rpc.ts";
import { stopAgentViaCli, type DaemonReply } from "./daemon-cli.ts";
import { boundTaskPeers, peerIsRunning } from "./task-peers.ts";
import { associateTaskPeer, createTaskPeer, resolvePeerSpawnProvider, resolveSpawnWorkspaceAndParent } from "./spool.ts";
import { READ_ONLY_DISPOSITION_FENCE, readOnlyDispositionEvidence } from "./core/disposition-prompt.ts";
import { capHandoffText, validHandoffText } from "./handoff-text.ts";

export const PEER_HANDOFF_TOKENS = 160_000;
const MAX_PEER_HANDOFFS = 1;
const SUMMARY_BYTES = 12 * 1024;
const INTERRUPTED = "The outgoing Peer was interrupted during handoff extraction. Rely on the machine-verified worktree digest and inspect the remaining requirements and checks.";

interface PeerHandoffState {
  contractEpochSeq: number;
  peerHandoffCount: number;
  phase: "idle" | "extracting" | "retiring" | "spawning" | "blocked";
  outgoingId?: string;
  requestedAt?: number;
  localHandoffStamp?: string | null;
  worktree?: string;
  provider?: string;
}

interface PeerHandoffDeps {
  factory: Factory;
  /**
   * The slug → owning Project's Factory resolver (v0.0.89, ADR 0045 §1): the
   * post-split root Factory carries no Contracts, so every Contract, worktree,
   * and spawn read goes through the OWNING Project's Factory. Absent (the
   * unwired entrances), the one `factory` stands exactly as before.
   */
  factoryFor?: (slug: string, task: string) => Factory;
  /** The Project's merged Ledger stream — its own Factory's events plus the wired Factory's bridged tasks. */
  eventsFor?: (slug: string) => readonly LedgerEvent[];
  stateDir: string;
  home?: string;
  daemon: () => SurfaceDaemonApi;
  stopAgent?: (id: string, home?: string) => Promise<DaemonReply>;
  timeoutMs: number;
  readTokens: (agent: SurfaceAgentSnapshot) => { usedTokens: number | null };
  /**
   * The usage-rollup flush (v0.0.87, ADR 0043 §3): the outgoing Peer's final
   * cumulative usage lands in `<projectStateDir>/usage.json` BEFORE the seat
   * stops and archives — a handoff never loses the predecessor's tokens.
   */
  recordUsage?: (input: { slug: string; task: string; agent: SurfaceAgentSnapshot }) => Promise<void>;
  queueBlocked: (slug: string, task: string, epoch: number, text: string) => void;
  wake: (slug: string) => Promise<void>;
  log: (text: string) => void;
}

export function createPeerHandoffRuntime(deps: PeerHandoffDeps) {
  const factoryOf = (slug: string, task: string): Factory => deps.factoryFor?.(slug, task) ?? deps.factory;
  const eventsOf = (slug: string): readonly LedgerEvent[] => deps.eventsFor?.(slug) ?? deps.factory.ledger.events;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clear = (key: string) => { const timer = timers.get(key); if (timer) clearTimeout(timer); timers.delete(key); };
  const statePath = (slug: string, task: string) => join(projectStateDir(deps.stateDir, slug), `peer-handoff-${task}.json`);
  const summaryPath = (slug: string, task: string) => join(projectStateDir(deps.stateDir, slug), `peer-handoff-${task}.md`);
  const save = (slug: string, task: string, state: PeerHandoffState) => atomicJson(statePath(slug, task), state);
  const arm = (slug: string, task: string, requestedAt: number) => {
    const key = `${slug}:${task}`;
    if (timers.has(key)) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      void deps.wake(slug).catch(error => deps.log(`Peer handoff timeout recovery: ${String(error)}`));
    }, Math.max(0, requestedAt + deps.timeoutMs - Date.now()));
    timer.unref?.();
    timers.set(key, timer);
  };
  const bounded = async <T>(job: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Peer handoff operation timed out")), deps.timeoutMs); timer.unref?.(); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const stopPeer = async (id: string) => {
    const result = await bounded((deps.stopAgent ?? stopAgentViaCli)(id, deps.home));
    if (!result.ok) throw new Error(`cannot stop Peer ${id}: ${result.reason}`);
  };
  const eligible = (slug: string, contract: ContractSet) => {
    const current = projectTask(eventsOf(slug), contract.task);
    return current.contract?.seq === contract.seq && !current.acceptance && current.verdict !== "green" && !current.attempts.some(attempt => attempt.gateOpen);
  };

  const finish = async (slug: string, contract: ContractSet, state: PeerHandoffState, live: SurfaceAgentSnapshot[], input?: LeadTurnEndedInput): Promise<void> => {
    if (!eligible(slug, contract)) return;
    const task = contract.task, path = summaryPath(slug, task), daemon = deps.daemon();
    if (state.phase === "extracting") {
      let summary: string | undefined;
      if (input?.outcome.kind === "completed") {
        const reply = input.timeline.filter(item => item.type === "assistant_message").at(-1)?.text;
        if (validHandoffText(reply)) summary = reply;
        if (summary === undefined) {
          try {
            const timeline = await bounded(daemon.agents.ref(state.outgoingId!).timeline.refetch({ direction: "tail", limit: 20 }));
            const reply = timeline.entries?.filter(entry => entry.item?.type === "assistant_message").at(-1)?.item?.text;
            if (validHandoffText(reply)) summary = reply;
          } catch { /* Fuse fallback also covers unreadable native timelines. */ }
        }
      }
      for (const candidate of [path, join(state.worktree!, ".paseo-peer-handoff.md")]) {
        if (summary !== undefined) break;
        try {
          const unchangedLocal = candidate !== path && state.localHandoffStamp !== undefined && fileStamp(candidate) === state.localHandoffStamp;
          if (!unchangedLocal && statSync(candidate).mtimeMs + 1 >= state.requestedAt!) {
            const disk = readFileSync(candidate, "utf8");
            if (validHandoffText(disk)) summary = disk;
          }
        } catch { /* Extraction file absent or unreadable. */ }
      }
      if (!eligible(slug, contract)) return;
      writeFileSync(path, capHandoffText(summary ?? INTERRUPTED, SUMMARY_BYTES));
      state.phase = "retiring";
      save(slug, task, state);
      clear(`${slug}:${task}`);
    }
    if (state.phase === "retiring") {
      const outgoing = live.find(agent => agent.id === state.outgoingId);
      if (outgoing) {
        if (deps.recordUsage !== undefined) await deps.recordUsage({ slug, task, agent: outgoing });
        await stopPeer(outgoing.id);
        if (!eligible(slug, contract)) return;
        await bounded(daemon.agents.ref(outgoing.id).archive());
      }
      if (!eligible(slug, contract)) return;
      state.phase = state.peerHandoffCount >= MAX_PEER_HANDOFFS ? "blocked" : "spawning";
      // Reserve the sole successor before creating it. Restart recovery adopts
      // a matching labelled session instead of creating a second successor.
      if (state.phase === "spawning") state.peerHandoffCount = 1;
      save(slug, task, state);
    }
    const digest = worktreeDigest(state.worktree!, contract);
    if (state.phase === "blocked") {
      deps.queueBlocked(slug, task, contract.seq, `BLOCKED (context-ceiling): Task ${task} exhausted both its initial Peer and 1 automatic Peer handoff (2 x 160,000 tokens) in the current Contract epoch without reaching a green Claim.\n\n${digest}\n\nHandoff: ${path}\nInspect the partial Task worktree progress, land or preserve verified work, and re-contract / split the remaining scope into a narrower follow-up wave.`);
      // Idle with the spent budget avoids duplicate escalation on every sweep.
      state.phase = "idle";
      save(slug, task, state);
      return;
    }
    if (state.phase !== "spawning") return;
    const handoffKey = `${contract.seq}:${state.outgoingId}`;
    const census = await daemon.agents.list({ filter: { includeArchived: true, includeBackground: true } });
    const all = census.entries.map(entry => entry.agent);
    if (!eligible(slug, contract)) return;
    let successorId = all.find(agent => agent.labels.peerHandoff === handoffKey && agent.labels.project === slug && agent.labels.task === task)?.id;
    // Another caller may have supplied a replacement after a failed create.
    // Adopt it, and count even an already archived automatic successor.
    successorId ??= boundTaskPeers({ stateDir: deps.stateDir, slug, task, events: eventsOf(slug), live: all }).find(agent => agent.id !== state.outgoingId)?.id;
    if (!successorId) {
      const provider = await resolvePeerSpawnProvider(factoryOf(slug, task), state.provider ?? "", slug);
      const meta = await resolveSpawnWorkspaceAndParent(factoryOf(slug, task), daemon, task, state.worktree, deps.home);
      const labels = { seat: "agent", project: slug, task, epoch: String(contract.seq), peerHandoff: handoffKey };
      // The disposition-aware completion (v0.5.0 ticket 03, ADR 0054 §3): the
      // engineer successor keeps the cumulative-Gate + committed-HEAD claim
      // instruction verbatim; a read-only successor is fenced — the worktree
      // stays clean at HEAD, no commit, and the claim carries its
      // disposition's own evidence expectations instead of a sha.
      const disposition = contract.disposition ?? "engineer";
      const readOnlyEvidence = readOnlyDispositionEvidence(contract.disposition);
      const prompt = [
          `# Peer handoff — Task ${task}`, "You are the fresh successor Peer at 0% context. Continue from the existing Task worktree state; preserve completed work and uncommitted edits.",
          "## Active Contract Brief",
          ...(readOnlyEvidence === undefined ? [] : [`Disposition: ${disposition} (Read-Only)`]),
          contract.description ?? "(no description)",
          `Allowed scope: ${contract.scope?.join(", ") ?? "the Task worktree"}`, `Required skills: ${contract.skills?.join(", ") ?? "role defaults"}`,
          `Gate: ${readOnlyEvidence !== undefined && contract.gate.trim() === "" ? "(none)" : contract.gate}`,
          "## Machine-Verified Worktree Digest", digest,
          `## Outgoing Peer Handoff (${path})`, readFileSync(path, "utf8"),
          readOnlyEvidence === undefined
            ? "Run targeted modular slice tests with isolated fixtures and explicit timeouts while iterating. Run the full cumulative Gate before calling factory-claim for the committed HEAD, then end your turn."
            : `This succession is Read-Only (disposition ${disposition}): ${READ_ONLY_DISPOSITION_FENCE} — the worktree must stay clean at HEAD; never commit, never edit files. Call factory-claim with no commit and no sha, supplying \`--outcome --scope --verification --unknowns\` carrying your ${disposition} evidence: ${readOnlyEvidence}, then end your turn.`,
        ].join("\n\n");
      if (!eligible(slug, contract)) return;
      // Never reallocate/reset the worktree: this is continuation, including dirty files.
      successorId = await createTaskPeer({ factory: factoryOf(slug, task), daemon, task, worktree: state.worktree, provider, prompt, home: deps.home, spawnMeta: meta, extraLabels: labels });
      if (!successorId) throw new Error("daemon did not create a successor Peer");
    }
    associateTaskPeer(factoryOf(slug, task), task, successorId);
    state.phase = "idle";
    save(slug, task, state);
  };

  const observeProject = async (slug: string, root: string, input?: LeadTurnEndedInput): Promise<void> => {
    const events = eventsOf(slug);
    const tasks = [...new Set(events.flatMap(event => event.event === "contract_set" && (event.workspace === root || event.workspace.startsWith(`${root}/`)) ? [event.task] : []))];
    if (tasks.length === 0) return;
    const page = await deps.daemon().agents.list({ filter: { includeArchived: false, includeBackground: true } });
    const live = page.entries.map(entry => entry.agent).filter(agent => agent.archivedAt === null);
    for (const task of tasks) {
      try {
        const projected = projectTask(eventsOf(slug), task), contract = projected.contract!;
        if (contract.workspace !== root && !contract.workspace.startsWith(`${root}/`)) continue;
        const key = `${slug}:${task}`;
        let state = readOptionalJson(statePath(slug, task)) as PeerHandoffState | undefined;
        if (state?.contractEpochSeq !== contract.seq) {
          clear(key);
          state = { contractEpochSeq: contract.seq, peerHandoffCount: 0, phase: "idle" };
          save(slug, task, state);
        }
        if (projected.acceptance || projected.attempts.some(attempt => attempt.gateOpen) || projected.verdict === "green") { clear(key); continue; }
        if (state.phase !== "idle") {
          const outgoingId = state.outgoingId;
          if (state.phase !== "extracting" || (input !== undefined && input.agentId === outgoingId && input.outcome.kind !== "canceled") || Date.now() >= state.requestedAt! + deps.timeoutMs || !live.some(agent => agent.id === outgoingId && agent.status !== "error")) {
            await finish(slug, contract, state, live, input?.agentId === state.outgoingId ? input : undefined);
          } else arm(slug, task, state.requestedAt!);
          continue;
        }
        const peers = boundTaskPeers({ stateDir: deps.stateDir, slug, task, events, live });
        const peer = peers[0];
        if (!peer || (input && input.agentId !== peer.id) || (deps.readTokens(peer).usedTokens ?? 0) < PEER_HANDOFF_TOKENS) continue;
        const worktree = factoryOf(slug, task).worktreeFor(task);
        if (!worktree) continue; // A standing seat/shared checkout is never a Task worktree.
        worktreeDigest(worktree, contract); // Refuse missing/wrong-branch worktrees before interrupting.
        const baseProvider = peer.provider.replace(/:[^/]+$/, "");
        const modelLane = peer.model && !baseProvider.includes("/") ? `${baseProvider}/${peer.model}` : baseProvider;
        const thinking = peer.thinkingOptionId ?? peer.provider.match(/:([^/]+)$/)?.[1];
        const provider = thinking ? `${modelLane}:${thinking}` : modelLane;
        state = { ...state, phase: "extracting", outgoingId: peer.id, requestedAt: Date.now(), worktree, provider, localHandoffStamp: fileStamp(join(worktree, ".paseo-peer-handoff.md")) };
        save(slug, task, state);
        rmSync(summaryPath(slug, task), { force: true }); // An earlier epoch/extraction is never continuity evidence.
        arm(slug, task, state.requestedAt!);
        try {
          if (peer.status === "error") throw new Error("outgoing Peer in error state");
          if (peerIsRunning(peer)) await stopPeer(peer.id);
          if (!eligible(slug, contract)) continue;
          await bounded(deps.daemon().agents.ref(peer.id).send([
            `# Peer handoff extraction — Task ${task}`, "Your context crossed 160,000 tokens. Start no new work and submit no Claim during extraction.",
            "Preserve the existing committed work and uncommitted edits. Put the entire Markdown handoff directly in your final assistant message, in one piece, without running shell commands or writing files to disk. The plugin server reads your reply and persists it automatically, capping it at 12 KB. Use these four sections:",
            "1. Completed & Verified Slice", "2. Worktree Git Status & Uncommitted Edits", "3. Remaining Requirements & Failing Checks", "4. Read-First Files for Successor",
            "Record completed checks and exact remaining failures. This bounded handoff is this turn's only deliverable; end your turn after the complete Markdown document.",
          ].join("\n\n")));
        } catch (error) {
          deps.log(`Peer handoff extraction bypassed: ${String(error)}`);
          await finish(slug, contract, state, live);
        }
      } catch (error) { deps.log(`Peer handoff ${slug}/${task} deferred: ${String(error)}`); }
    }
  };
  return {
    observeProject,
    reset(slug: string) { for (const key of timers.keys()) if (key.startsWith(`${slug}:`)) clear(key); },
    stop() { for (const key of timers.keys()) clear(key); },
  };
}

function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return null; }
}

function worktreeDigest(cwd: string, contract: ContractSet): string {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(`worktree git ${args[0]} failed: ${result.stderr || result.error}`);
    return result.stdout.trim() || "(none)";
  };
  const branch = git(["branch", "--show-current"]);
  if (branch !== taskWorktreeBranch(contract.task)) throw new Error(`unexpected Task worktree branch ${branch}`);
  return [`Worktree: ${cwd}`, `Branch: ${branch}`, `HEAD: ${git(["rev-parse", "HEAD"])}`, `git status --short:\n${git(["status", "--short"])}`, `git log --oneline ${contract.base ?? "HEAD"}..HEAD:\n${git(["log", "--oneline", `${contract.base ?? "HEAD"}..HEAD`])}`].join("\n\n");
}
