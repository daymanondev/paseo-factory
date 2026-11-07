/**
 * A fixture `FactoryView` v3 — the console tests' snapshot. Every required
 * field is honest FactoryView data (empty streams, a vacant vault), with the
 * two Projects the shell assertions read and the Task/usage builders the
 * Tasks-screen tests fold.
 */
import type { AttemptView, FactoryView, TaskStatus, TaskView } from "../../../plugin/shared/view.ts";

const LANES = {
  supervisor: "pi/zai/glm-5.3",
  lead: "pi/zai/glm-5.3",
  worker: "pi/zai/glm-5.3",
  watch: "pi/zai/glm-5.3",
  retro: "pi/zai/glm-5.3",
  freshEyes: "pi/zai/glm-5.3",
};

/** One closed attempt — the verdict pill the fold's statuses read. */
export function fixtureAttempt(n: number, verdict: "green" | "red" | null): AttemptView {
  return {
    n,
    verdict,
    open: false,
    exit: verdict === null ? null : verdict === "green" ? 0 : 1,
    note: verdict === null ? "interrupted" : null,
    sha: verdict === null ? null : `${n}a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d`,
    respawned: false,
    gateLog: null,
    report: null,
    claimedAt: "2026-11-07T09:30:00.000Z",
    verdictAt: "2026-11-07T09:40:00.000Z",
    watch: null,
    eye: null,
  };
}

/** A Task row in the fold's own status vocabulary — every optional field honest. */
export function fixtureTask(task: string, status: TaskStatus, attempts: readonly AttemptView[] = []): TaskView {
  const accepted = status === "accepted";
  const green = [...attempts].findLast((attempt) => attempt.verdict === "green");
  return {
    task,
    workspace: `/Users/owner/code/research-slp/.paseo/worktrees/${task}`,
    description: `The ${task} contract`,
    status,
    accepted,
    acceptedBy: accepted ? "owner" : null,
    currentAttempt: attempts.length > 0 ? attempts[attempts.length - 1]!.n : undefined,
    verdict: green !== undefined ? "green" : attempts.length > 0 && attempts[attempts.length - 1]!.verdict === "red" ? "red" : undefined,
    lane: "pi/zai/glm-5.3",
    agentId: "agent-worker-1",
    costState: "metered",
    costUsd: 0.42,
    totalTokens: undefined,
    usageModel: attempts.length > 0 ? "glm-5.3" : undefined,
    needsHumanReason: status === "needs-human" ? "gate asked a question" : null,
    choke: { allowed: 3, denied: 0, blocked: 0 },
    attempts: [...attempts],
    lastSeq: 12,
  };
}

export function fixtureView(): FactoryView {
  return {
    version: 3,
    stateDir: "/tmp/paseo-factory-state",
    generatedAt: "2026-11-07T09:00:00.000Z",
    lanes: { ...LANES },
    machineLanes: { ...LANES },
    kpis: { needsHuman: 1, running: 2, readyToAccept: 1, accepted: 3, totalCostUsd: 0, totalTokens: 0 },
    tasks: [],
    agents: [],
    providers: [],
    supervisor: null,
    lead: null,
    retro: [],
    ledger: [],
    daemonError: null,
    project: null,
    projects: [
      {
        slug: "research-slp",
        root: "/Users/owner/code/research-slp",
        name: "research-slp",
        supervisorId: "agent-sup-1",
        leadId: "agent-lead-1",
        activeTaskCount: 4,
        executionMode: "slp",
      },
      {
        slug: "web-console-fixture",
        root: "/Users/owner/code/web-console-fixture",
        name: "web-console-fixture",
        supervisorId: null,
        leadId: null,
        activeTaskCount: 1,
        executionMode: "scrum",
      },
    ],
    corePlugin: {
      id: "paseo-factory",
      title: "Paseo Factory",
      tagline: "Verification core",
      description: "The Factory verification core.",
      canonicalSource: "https://github.com/andrew/paseo-factory",
      sidebarLabel: "Factory",
      sidebarIcon: "factory",
      capabilities: [],
      access: "public",
      status: "running",
      enabled: true,
      installKind: null,
      installedSource: null,
      currentRevision: null,
      version: "0.2.3",
      latestRevision: null,
      commitsBehind: null,
      updateAvailable: null,
      error: null,
    },
    companions: [],
    pluginsCheckedAt: null,
    vault: {
      configured: false,
      repo: null,
      branch: "main",
      nodeId: "node-1",
      hasPassphrase: false,
      cloneExists: false,
      lastHydratedAt: null,
      lastHydrateMode: null,
      lastPushedAt: null,
      sharedSecrets: { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
      hydratedApps: [],
      ghInstalled: false,
      ghAuthenticated: false,
      ghUser: null,
      suggestedRepo: null,
      error: null,
    },
    profiles: [],
    activeProfileId: null,
    activeProfileModified: false,
    hasProjectLaneOverride: false,
  };
}
