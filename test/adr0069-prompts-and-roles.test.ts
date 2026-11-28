import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRoleKickoffPrompt,
  FOOTER_MARK,
  LEAD_WAVE_LAWS,
  renderRoleAppendSystem,
  renderRoleContract,
  renderSeatBootstrapPrompt,
} from "../src/roles-contract.ts";
import {
  activeContractSnapshot,
  formatReopenIfBlock,
  PEER_PREMISE_CHECK_REMINDER,
  peerHandoffContinuationFooter,
  READ_ONLY_DISPOSITION_EVIDENCE,
  READ_ONLY_DISPOSITION_FENCE,
  repokeCompletionFooter,
} from "../src/disposition-prompt.ts";
import { renderBrief } from "../plugin/bin/driver.mjs";
import { injectRoleOnCreate } from "../plugin/server/roles.ts";
import type { AgentCreateRequest } from "../plugin/server/roles.ts";
import type { ContractSet } from "../src/events.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

function makeGitRepo(dir: string): string {
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

const FORBIDDEN_TOPOLOGY_TERMS = [
  /\bOwner\b/,
  /\bSupervisor\b/,
  /\bDriver\b/,
  /Factory CLI/i,
  /GateQueue/i,
  /Gate queue/i,
  /paseo-factory verification loop/i,
  /agent_escalate_blocker/,
];

function assertTopologyBlind(text: string, label: string): void {
  for (const pattern of FORBIDDEN_TOPOLOGY_TERMS) {
    assert.doesNotMatch(text, pattern, `${label} must be topology-blind (matched ${pattern})`);
  }
}

function makeContract(overrides: Partial<ContractSet & { reopenConditions?: string[] }> = {}): ContractSet & { reopenConditions?: string[] } {
  return {
    seq: 1,
    ts: "2026-11-23T00:00:00.000Z",
    event: "contract_set",
    task: "T-69",
    workspace: "/tmp/repo",
    gate: "npm test",
    artifact: "src/index.ts",
    base: "0".repeat(40),
    description: "Implement bounded slice.",
    ...overrides,
  };
}

test("renderRoleContract('agent') neutral core is topology-blind and disposition-neutral, while disposition-scoped surfaces teach active disposition clauses (ADR 0069, ADR 0074)", () => {
  const neutralSurfaces = [
    renderRoleContract("agent", { task: "T-69", project: { root: "/tmp/repo", slug: "repo-123" } }),
    renderRoleAppendSystem("agent", { task: "T-69" }),
    buildRoleKickoffPrompt("agent", { task: "T-69", project: { root: "/tmp/repo", slug: "repo-123" } }),
  ];

  for (const surface of neutralSurfaces) {
    assertTopologyBlind(surface, "Neutral Peer role surface");
    assert.match(surface, /^#?.*You are an independent Peer/m);
    assert.match(surface, /provisional brief/i);
    assert.match(surface, /isolated Task worktree/i);
    assert.match(surface, /Contract Before Test/);
    assert.match(surface, /Six-Field Handoff/);
    assert.match(surface, /agent_ask/);
    assert.match(surface, /`reopen_premise` \| `gate_mismatch` \| `dependency` \| `clarify` \| `blocked`/);
    assert.match(surface, /`foundation` \| `dependency` \| `lifecycle` \| `API` \| `ownership` \| `verification`/);
    assert.match(surface, /agent_claim/);
    for (const leaked of ["read-only-disposition-fence", "--runInBand", "strongest evidence-backed weakness", "alternatives considered"]) {
      assert.ok(!surface.includes(leaked), `neutral Peer surface must omit disposition-specific term \`${leaked}\``);
    }
  }

  for (const disposition of ["engineer", "scout", "architect", "reviewer"] as const) {
    const scoped = renderRoleContract("agent", {
      task: "T-69",
      project: { root: "/tmp/repo", slug: "repo-123" },
      disposition,
    });
    const kickoff = buildRoleKickoffPrompt("agent", {
      task: "T-69",
      project: { root: "/tmp/repo", slug: "repo-123" },
      disposition,
    });
    for (const surface of [scoped, kickoff]) {
      assertTopologyBlind(surface, `Peer role surface (${disposition})`);
      assert.match(surface, new RegExp(`You are an independent ${disposition}`));
      if (disposition === "engineer") {
        assert.match(surface, /automated verification runs.*asynchronously/i);
        assert.match(surface, /never weaken or skip tests/i);
      } else {
        assert.match(surface, /read-only-disposition-fence/);
        assert.ok(!surface.includes("--sha") && !surface.includes("for the committed HEAD"), `${disposition} omits --sha`);
      }
      if (disposition === "reviewer") {
        assert.match(surface, /Outcome, Spec\/Invariants, and Diff\/Commit/i);
      }
    }
  }
});

test("LEAD_WAVE_LAWS, Lead contract, and Lead bootstrap feature lead_reply_peer, reopenConditions, and anonymized Devil's Advocate reviewer (ADR 0069)", () => {
  const leadBootstrap = renderSeatBootstrapPrompt({
    seat: "lead",
    home: "/tmp/home",
    stateDir: "/tmp/state",
    nodePath: process.execPath,
    path: "/usr/bin",
    lane: "codex",
    project: { root: "/tmp/repo", slug: "repo-123" },
  });
  const leadSurfaces = [
    renderRoleContract("lead", { project: { root: "/tmp/repo", slug: "repo-123" } }),
    leadBootstrap,
    LEAD_WAVE_LAWS.join("\n"),
  ];

  for (const surface of leadSurfaces) {
    assert.match(surface, /lead_reply_peer/);
    assert.match(surface, /lead_repoke_agent/);
    assert.match(surface, /reopenConditions/);
    assert.match(surface, /Outcome \+ Spec\/Invariants \+ Diff\/Commit/i);
    assert.match(surface, /strongest.*file:line.*weakness without manufacturing objections/i);
  }

  const leadContract = renderRoleContract("lead");
  assert.match(leadContract, /paseo-factory_lead_reply_peer/);
  assert.match(leadContract, /If paseo_factory MCP is absent, use the factory CLI fallback via factory --help\./);
  assert.match(leadBootstrap, /\[--reopen-if <text>\]/);
  for (const surface of leadSurfaces) {
    assert.match(surface, /strictly project-owned verification\/run facts/);
    assert.match(surface, /never record Factory MCP tool names, CLI commands\/flags, or SLP workflow laws/);
  }
});

test("disposition-prompt helpers render Reopen if:, keep continuation topology-blind, and append agent_ask premise check (ADR 0069)", () => {
  assert.equal(formatReopenIfBlock(undefined), "");
  assert.equal(formatReopenIfBlock([]), "");
  assert.equal(formatReopenIfBlock(["  ", ""]), "");
  assert.equal(formatReopenIfBlock(["  Schema lacks field X  "]), "Reopen if: Schema lacks field X");
  assert.equal(
    formatReopenIfBlock(["Schema lacks field X", "Gate expects old CLI flag"]),
    "Reopen if:\n- Schema lacks field X\n- Gate expects old CLI flag",
  );

  const snapshotWithout = activeContractSnapshot(makeContract());
  assert.ok(!snapshotWithout.includes("Reopen if:"));
  assertTopologyBlind(snapshotWithout, "activeContractSnapshot without reopenConditions");

  const snapshotWith = activeContractSnapshot(makeContract({ reopenConditions: ["API returns 404", "Migration fails"] }));
  assert.ok(snapshotWith.includes("Reopen if:\n- API returns 404\n- Migration fails"));
  assertTopologyBlind(snapshotWith, "activeContractSnapshot with reopenConditions");

  const engFooter = repokeCompletionFooter("T-69", makeContract({ disposition: "engineer" }));
  assertTopologyBlind(engFooter, "repokeCompletionFooter engineer");
  assert.ok(engFooter.includes("automated verification runs `npm test` asynchronously"));
  assert.ok(engFooter.includes(PEER_PREMISE_CHECK_REMINDER));
  assert.doesNotMatch(engFooter, /run the gate `/i);

  for (const ro of ["architect", "reviewer", "scout"] as const) {
    const roFooter = repokeCompletionFooter("T-69", makeContract({ disposition: ro, gate: "" }));
    assertTopologyBlind(roFooter, `repokeCompletionFooter ${ro}`);
    assert.ok(roFooter.includes(READ_ONLY_DISPOSITION_FENCE));
    assert.ok(roFooter.includes(READ_ONLY_DISPOSITION_EVIDENCE[ro]));
    assert.ok(roFooter.includes(PEER_PREMISE_CHECK_REMINDER));
  }

  assert.match(READ_ONLY_DISPOSITION_EVIDENCE.reviewer, /strongest evidence-backed weakness.*file:line.*before agreeing/i);
  assert.match(READ_ONLY_DISPOSITION_EVIDENCE.reviewer, /never manufacturing objections when evidence holds/i);
  assert.match(READ_ONLY_DISPOSITION_EVIDENCE.reviewer, /blocking defects/i);

  const engHandoff = peerHandoffContinuationFooter("engineer");
  assertTopologyBlind(engHandoff, "peerHandoffContinuationFooter engineer");
  assert.match(engHandoff, /do not pre-run the full cumulative Gate/i);
  assert.match(engHandoff, /end your turn immediately when queued/i);
  assert.ok(engHandoff.includes(PEER_PREMISE_CHECK_REMINDER));

  const revHandoff = peerHandoffContinuationFooter("reviewer");
  assertTopologyBlind(revHandoff, "peerHandoffContinuationFooter reviewer");
  assert.ok(revHandoff.includes(READ_ONLY_DISPOSITION_FENCE));
  assert.ok(revHandoff.includes(READ_ONLY_DISPOSITION_EVIDENCE.reviewer));
  assert.ok(revHandoff.includes(PEER_PREMISE_CHECK_REMINDER));
});

test("driver renderBrief is topology-blind, renders Reopen if:, mirrors Devil's Advocate reviewer, and ends with agent_ask reminder (ADR 0069)", () => {
  const eng = renderBrief("T-69", "/custom/bin", "Implement feature", ["tdd"], "factory/T-69", "engineer", ["Schema lacks field X"]);
  assertTopologyBlind(eng, "driver engineer brief");
  assert.ok(eng.includes("automated verification runs asynchronously"));
  assert.ok(eng.includes("Reopen if: Schema lacks field X"));
  assert.ok(eng.endsWith(PEER_PREMISE_CHECK_REMINDER), "Reopen if + agent_ask reminder sit at the end for user-turn recency");

  const multi = renderBrief("T-69", "/custom/bin", "Implement feature", undefined, "factory/T-69", undefined, ["Cond A", "Cond B"]);
  assert.ok(multi.includes("Reopen if:\n- Cond A\n- Cond B"));
  assert.ok(multi.endsWith(PEER_PREMISE_CHECK_REMINDER));

  const rev = renderBrief("T-69", "/custom/bin", "Audit slice", undefined, "factory/T-69", "reviewer", ["Diff missing tests"]);
  assertTopologyBlind(rev, "driver reviewer brief");
  assert.ok(rev.includes("Disposition guidance (reviewer):"));
  assert.ok(rev.includes(READ_ONLY_DISPOSITION_EVIDENCE.reviewer));
  assert.ok(!rev.includes("--sha"));
  assert.ok(rev.includes("Reopen if: Diff missing tests"));
  assert.ok(rev.endsWith(PEER_PREMISE_CHECK_REMINDER));

  const scout = renderBrief("T-69", "/custom/bin", "Map codebase", undefined, "factory/T-69", "scout");
  assertTopologyBlind(scout, "driver scout brief");
  assert.ok(scout.includes("Disposition guidance (scout):"));
  assert.ok(scout.includes(READ_ONLY_DISPOSITION_EVIDENCE.scout));
  assert.ok(!scout.includes("--sha"));

  const arch = renderBrief("T-69", "/custom/bin", "Design seam", undefined, "factory/T-69", "architect");
  assertTopologyBlind(arch, "driver architect brief");
  assert.ok(arch.includes("Disposition guidance (architect):"));
  assert.ok(arch.includes(READ_ONLY_DISPOSITION_EVIDENCE.architect));
  assert.ok(!arch.includes("--sha"));
});

test("plugin/server/roles.ts preserves legacy Peer markers alongside the new independent-engineer marker to prevent duplicate contracts (ADR 0069)", (t) => {
  const dir = makeTempDir("roles-legacy-markers-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const worktreeDir = join(stateDir, "projects", "repo-stub", "worktrees", "T-69");
  mkdirSync(worktreeDir, { recursive: true });

  for (const legacyIntro of [
    "You are a Peer of the paseo-factory verification loop (task T-69, project repo): old prose.",
    "You are a working Agent of the paseo-factory verification loop (task T-69): older prose.",
    "You are an independent engineer (task T-69, project repo) working a provisional brief.",
  ]) {
    const existingPrompt = `Host instructions.\n\n${legacyIntro}\n${FOOTER_MARK} tdd, diagnosing-bugs, codebase-design`;
    const result = injectRoleOnCreate<AgentCreateRequest>(
      {
        config: {
          provider: "claude",
          cwd: worktreeDir,
          systemPrompt: existingPrompt,
        },
      },
      stateDir,
      userHome,
    );
    assert.ok(result !== undefined);
    const updated = result.config.systemPrompt ?? "";
    assert.ok(updated.startsWith("Host instructions."), "host instructions preserved");
    assert.equal(
      updated.split("<!-- paseo-factory injected role contract -->").length - 1,
      1,
      `single injected contract marker for legacy intro: ${legacyIntro}`,
    );
    assert.equal(
      updated.split(FOOTER_MARK).length - 1,
      1,
      `single footer mark (no duplicate contract) for legacy intro: ${legacyIntro}`,
    );
    assert.ok(!updated.includes("old prose.") && !updated.includes("older prose."), "prior contract stripped cleanly");
  }

  // Also verify roles.ts source retains all legacy Peer markers explicitly.
  const rolesSource = readFileSync(join(process.cwd(), "plugin/server/roles.ts"), "utf8");
  assert.ok(rolesSource.includes('"You are a Peer of the paseo-factory"'));
  assert.ok(rolesSource.includes('"You are a working Agent of the paseo-factory"'));
  assert.ok(rolesSource.includes('"You are an independent engineer"'));
});

test("CONTEXT.md aligns Agent/Peer, Contract, Claim, Re-poke, Handoff, and Supervisor with ADR 0069", () => {
  const contextMd = readFileSync(join(process.cwd(), "CONTEXT.md"), "utf8");
  for (const term of [
    "agent_ask",
    "lead_reply_peer",
    "reopenConditions",
    "peer_asked",
    "Andon Checkpoint",
    "Loop Health",
    "Reopen if:",
  ]) {
    assert.ok(contextMd.includes(term), `CONTEXT.md mentions ${term}`);
  }
});
