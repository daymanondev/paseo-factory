/** Bounded, durable succession for task-bound Peers. All mutations run on the Project lane. */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "./core/factory.ts";
import type { ContractSet } from "./core/events.ts";
import { projectStateDir } from "./core/project.ts";
import { projectTask } from "./core/task-state.ts";
import { atomicJson, readOptionalJson } from "./core/scrum/config.ts";
import { taskWorktreeBranch } from "./core/workspace.ts";
import type { LeadTurnEndedInput } from "./lead-mailbox.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "./surface-rpc.ts";
import { stopAgentViaCli, type DaemonReply } from "./daemon-cli.ts";
import { boundTaskPeers, peerIsRunning } from "./task-peers.ts";
import { associateTaskPeer, createTaskPeer, resolvePeerSpawnProvider, resolveSpawnWorkspaceAndParent } from "./spool.ts";
import { scrumSpawnLane } from "./scrum.ts";

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
  worktree?: string;
  provider?: string;
}

interface PeerHandoffDeps {
  factory: Factory;
  stateDir: string;
  home?: string;
  daemon: () => SurfaceDaemonApi;
  stopAgent?: (id: string, home?: string) => Promise<DaemonReply>;
  timeoutMs: number;
  readTokens: (agent: SurfaceAgentSnapshot) => { usedTokens: number | null };
  queueBlocked: (slug: string, task: string, epoch: number, text: string) => void;
  wake: (slug: string) => Promise<void>;
  log: (text: string) => void;
}

export function createPeerHandoffRuntime(deps: PeerHandoffDeps) {
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
  const eligible = (contract: ContractSet) => {
    const current = projectTask(deps.factory.ledger.events, contract.task);
    return current.contract?.seq === contract.seq && !current.acceptance && current.verdict !== "green" && !current.attempts.some(attempt => attempt.gateOpen);
  };

  const finish = async (slug: string, contract: ContractSet, state: PeerHandoffState, live: SurfaceAgentSnapshot[], input?: LeadTurnEndedInput) => {
    if (!eligible(contract)) return;
    const task = contract.task, path = summaryPath(slug, task), daemon = deps.daemon();
    if (state.phase === "extracting") {
      let summary = "";
      try {
        if (statSync(path).size <= SUMMARY_BYTES) summary = readFileSync(path, "utf8");
      } catch { /* extraction file absent or unreadable */ }
      if (!summary.trim() && input?.outcome.kind === "completed") {
        summary = input.timeline.filter(item => item.type === "assistant_message").at(-1)?.text ?? "";
        if (!summary.trim()) {
          try {
            const timeline = await bounded(daemon.agents.ref(state.outgoingId!).timeline.refetch({ direction: "tail", limit: 20 }));
            summary = timeline.entries?.filter(entry => entry.item?.type === "assistant_message").at(-1)?.item?.text ?? "";
          } catch { /* Fuse fallback also covers unreadable native timelines. */ }
        }
      }
      if (!eligible(contract)) return;
      writeFileSync(path, capSummary(summary.trim() ? summary : INTERRUPTED));
      state.phase = "retiring";
      save(slug, task, state);
      clear(`${slug}:${task}`);
    }
    if (state.phase === "retiring") {
      const outgoing = live.find(agent => agent.id === state.outgoingId);
      if (outgoing) {
        await stopPeer(outgoing.id);
        if (!eligible(contract)) return;
        await bounded(daemon.agents.ref(outgoing.id).archive());
      }
      if (!eligible(contract)) return;
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
    if (!eligible(contract)) return;
    let successorId = all.find(agent => agent.labels.peerHandoff === handoffKey && agent.labels.project === slug && agent.labels.task === task)?.id;
    // Another caller may have supplied a replacement after a failed create.
    // Adopt it, and count even an already archived automatic successor.
    successorId ??= boundTaskPeers({ stateDir: deps.stateDir, slug, task, events: deps.factory.ledger.events, live: all }).find(agent => agent.id !== state.outgoingId)?.id;
    if (!successorId) {
      const frozen = await scrumSpawnLane(deps.factory, task, {}, undefined, `peer-handoff:${handoffKey}`);
      const provider = frozen ?? await resolvePeerSpawnProvider(deps.factory, state.provider ?? "", slug);
      const meta = await resolveSpawnWorkspaceAndParent(deps.factory, daemon, task, state.worktree, deps.home);
      const labels = { seat: "agent", project: slug, task, epoch: String(contract.seq), peerHandoff: handoffKey, ...(contract.execution ? { execution: "scrum", run: contract.execution.runId, specialization: contract.execution.role } : {}) };
      const prompt = [
          `# Peer handoff — Task ${task}`, "You are the fresh successor Peer at 0% context. Continue from the existing Task worktree state; preserve completed work and uncommitted edits.",
          "## Active Contract Brief", contract.description ?? "(no description)",
          `Allowed scope: ${contract.scope?.join(", ") ?? "the Task worktree"}`, `Required skills: ${contract.skills?.join(", ") ?? "role defaults"}`, `Gate: ${contract.gate}`,
          "## Machine-Verified Worktree Digest", digest,
          `## Outgoing Peer Handoff (${path})`, readFileSync(path, "utf8"),
          "Run targeted modular slice tests with isolated fixtures and explicit timeouts while iterating. Run the full cumulative Gate before calling factory-claim for the committed HEAD, then end your turn.",
        ].join("\n\n");
      if (!eligible(contract)) return;
      // Never reallocate/reset the worktree: this is continuation, including dirty files.
      successorId = await createTaskPeer({ factory: deps.factory, daemon, task, worktree: state.worktree, provider, prompt, home: deps.home, spawnMeta: meta, extraLabels: labels });
      if (!successorId) throw new Error("daemon did not create a successor Peer");
    }
    associateTaskPeer(deps.factory, task, successorId);
    state.phase = "idle";
    save(slug, task, state);
  };

  const observeProject = async (slug: string, root: string, input?: LeadTurnEndedInput): Promise<void> => {
    const events = deps.factory.ledger.events;
    const tasks = [...new Set(events.flatMap(event => event.event === "contract_set" && (event.workspace === root || event.workspace.startsWith(`${root}/`)) ? [event.task] : []))];
    if (tasks.length === 0) return;
    const page = await deps.daemon().agents.list({ filter: { includeArchived: false, includeBackground: true } });
    const live = page.entries.map(entry => entry.agent).filter(agent => agent.archivedAt === null);
    for (const task of tasks) {
      try {
        const projected = projectTask(deps.factory.ledger.events, task), contract = projected.contract!;
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
        const worktree = deps.factory.worktreeFor(task);
        if (!worktree) continue; // A standing seat/shared checkout is never a Task worktree.
        worktreeDigest(worktree, contract); // Refuse missing/wrong-branch worktrees before interrupting.
        const baseProvider = peer.provider.replace(/:[^/]+$/, "");
        const modelLane = peer.model && !baseProvider.includes("/") ? `${baseProvider}/${peer.model}` : baseProvider;
        const thinking = peer.thinkingOptionId ?? peer.provider.match(/:([^/]+)$/)?.[1];
        const provider = thinking ? `${modelLane}:${thinking}` : modelLane;
        state = { ...state, phase: "extracting", outgoingId: peer.id, requestedAt: Date.now(), worktree, provider };
        save(slug, task, state);
        rmSync(summaryPath(slug, task), { force: true }); // An earlier epoch/extraction is never continuity evidence.
        arm(slug, task, state.requestedAt!);
        try {
          if (peer.status === "error") throw new Error("outgoing Peer in error state");
          if (peerIsRunning(peer)) await stopPeer(peer.id);
          if (!eligible(contract)) continue;
          await bounded(deps.daemon().agents.ref(peer.id).send([
            `# Peer handoff extraction — Task ${task}`, "Your context crossed 160,000 tokens. Start no new work and submit no Claim during extraction.",
            `Commit coherent work-in-progress on factory/${task}; preserve remaining edits. Write ${summaryPath(slug, task)} as plain Markdown, at most 12 KB, with these four sections:`,
            "1. Completed & Verified Slice", "2. Worktree Git Status & Uncommitted Edits", "3. Remaining Requirements & Failing Checks", "4. Read-First Files for Successor",
            "Record completed checks and exact remaining failures. This bounded handoff is this turn's only deliverable; end your turn when written.",
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

function capSummary(text: string): string {
  return Buffer.from(text).subarray(0, SUMMARY_BYTES).toString("utf8").replace(/\uFFFD$/, "");
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
