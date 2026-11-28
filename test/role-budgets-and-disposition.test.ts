import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRoleKickoffPrompt,
  FOOTER_MARK,
  LEAD_STORE_RELEASE_LAW,
  LEAD_WAVE_LAWS,
  renderRoleAppendSystem,
  renderRoleContract,
  renderSeatBootstrapPrompt,
  SUPERVISOR_FACTORY_OPERATOR_BOUNDARY,
  SUPERVISOR_OUTCOME_BOUNDARY,
  SUPERVISOR_STORE_RELEASE_BOUNDARY,
  SUPERVISOR_STORE_RELEASE_OFF_HINT,
} from "../src/roles-contract.ts";
import {
  PEER_DISPOSITION_CONTRACTS,
  peerHandoffContinuationFooter,
  renderPeerDispositionGuidance,
} from "../src/disposition-prompt.ts";
import { ROLE_PROMPTS } from "../src/pi-home.ts";
import { resolveProject } from "../src/project.ts";
import type { PeerDisposition } from "../src/events.ts";
import { renderBrief } from "../plugin/bin/driver.mjs";
import { injectRoleOnCreate, injectSessionEnv } from "../plugin/server/roles.ts";
import type { AgentCreateRequest } from "../plugin/server/roles.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const ORDERED_SECTIONS = [
  "## 1. Role & Core Goal",
  "## 2. Front-Loaded Rules & Negative Constraints",
  "## 3. Step-by-Step Workflow & Checkpoints",
  "## 4. Anti-Hallucination & Uncertainty Protocol",
  "## 5. Output Schema",
] as const;

const DISPOSITIONS: readonly PeerDisposition[] = ["engineer", "scout", "architect", "reviewer"];

const FORBIDDEN_TOPOLOGY_TERMS = [
  /\bOwner\b/,
  /\bSupervisor\b/,
  /\bDriver\b/,
  /Factory CLI/i,
  /factory --help/i,
  /GateQueue/i,
  /Gate queue/i,
  /paseo-factory verification loop/i,
  /agent_escalate_blocker/,
];

function assertOrderedSections(contract: string, label: string): void {
  let prev = -1;
  for (const heading of ORDERED_SECTIONS) {
    const idx = contract.indexOf(heading);
    assert.ok(idx >= 0, `${label} must include section \`${heading}\``);
    assert.ok(idx > prev, `${label} section \`${heading}\` must appear in exact order`);
    prev = idx;
  }
  assert.ok(contract.includes(FOOTER_MARK), `${label} must preserve role skills footer`);
}

function assertTopologyBlind(text: string, label: string): void {
  for (const pattern of FORBIDDEN_TOPOLOGY_TERMS) {
    assert.doesNotMatch(text, pattern, `${label} must stay topology-blind (matched ${pattern})`);
  }
}

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

test("UTF-8 byte budgets and 5-section front-loaded order hold across minimal, Open-Design-linked, and long multi-byte UTF-8 Supervisor, Lead, and Peer variants (ADR 0074)", (t) => {
  const dir = makeTempDir("role-budgets-");
  disposeDir(t, dir);

  const openDesignRoot = join(dir, "Users", "developer", "Documents", "code", "self-project", "mobile-app-production");
  mkdirSync(join(openDesignRoot, "design"), { recursive: true });
  writeFileSync(
    join(openDesignRoot, "design", "open-design-link.json"),
    JSON.stringify({
      projectId: "od-mobile-app",
      projectName: "Redesign Paseo Factory Mobile",
      sourceUpdatedAt: 1,
      syncedAt: "2026-11-27T00:00:00Z",
      screenCount: 12,
      files: [],
      digest: "deadbeef",
    }),
  );

  const utf8LongRoot = join(
    dir,
    "dự-án-ứng-dụng-di-động-2026",
    "mobile-app-production-workspace-tính-năng-dài",
  );
  mkdirSync(join(utf8LongRoot, "design"), { recursive: true });
  writeFileSync(
    join(utf8LongRoot, "design", "open-design-link.json"),
    JSON.stringify({
      projectId: "od-utf8-app",
      projectName: "Ứng dụng Quản lý Thiết bị Di động 2026",
      sourceUpdatedAt: 1,
      syncedAt: "2026-11-27T00:00:00Z",
      screenCount: 16,
      files: [],
      digest: "cafebabe",
    }),
  );

  const scenarios = [
    {
      name: "minimal",
      project: { root: "/w/repo", slug: "repo-123" },
      task: "T-01",
    },
    {
      name: "realistic-open-design",
      project: { root: openDesignRoot, slug: "mobile-app-production-a1b2c3" },
      task: "T-42",
    },
    {
      name: "utf8-long-open-design",
      project: { root: utf8LongRoot, slug: "mobile-app-production-workspace-2026-deadbe" },
      task: "T-999-utf8-tính-năng-long-task",
    },
  ] as const;

  const neutralAppend = renderRoleAppendSystem("agent");
  assertOrderedSections(neutralAppend, "peer:append-system");
  assert.equal(neutralAppend, ROLE_PROMPTS.agent);
  assert.ok(utf8Bytes(neutralAppend) <= 4608, `peer:append-system is ${utf8Bytes(neutralAppend)} B (limit 4608 B)`);

  for (const scenario of scenarios) {
    const { name, project, task } = scenario;

    for (const supervisorTier of ["hidden", "off-hint", "full"] as const) {
      const leadEnabled = supervisorTier === "full";
      const contract = renderRoleContract("supervisor", {
        project,
        storeRelease: { leadEnabled, supervisorTier },
      });
      assertOrderedSections(contract, `${name}:supervisor:${supervisorTier}`);
      const bytes = utf8Bytes(contract);
      assert.ok(bytes <= 6144, `${name}:supervisor:${supervisorTier} is ${bytes} B (limit 6144 B)`);
    }

    const supAppendFull = renderRoleAppendSystem("supervisor", {
      project,
      storeRelease: { leadEnabled: true, supervisorTier: "full" },
    });
    assertOrderedSections(supAppendFull, `${name}:supervisor:append-system:full`);
    const supAppendBytes = utf8Bytes(supAppendFull);
    assert.ok(supAppendBytes <= 6144, `${name}:supervisor:append-system:full is ${supAppendBytes} B (limit 6144 B)`);

    for (const [label, gate] of [
      ["lead:off", { leadEnabled: false, supervisorTier: "off-hint" as const }],
      ["lead:enabled", { leadEnabled: true, supervisorTier: "full" as const }],
    ] as const) {
      const contract = renderRoleContract("lead", { project, storeRelease: gate });
      assertOrderedSections(contract, `${name}:${label}`);
      const bytes = utf8Bytes(contract);
      assert.ok(bytes <= 12288, `${name}:${label} is ${bytes} B (limit 12288 B)`);
      if (name !== "minimal") {
        assert.ok(contract.includes("Open Design Linked Specification"), `${name}:${label} embeds linked design`);
      }
    }

    for (const disposition of DISPOSITIONS) {
      const scoped = renderRoleContract("agent", { project, task, disposition });
      assertOrderedSections(scoped, `${name}:peer:${disposition}`);
      const bytes = utf8Bytes(scoped);
      assert.ok(bytes <= 4608, `${name}:peer:${disposition} is ${bytes} B (limit 4608 B)`);
    }
  }
});

test("Supervisor and Lead contracts use the 1-line CLI fallback pointer while bootstrap retains Day-1 CLI tables and drops lead_create_worktree", () => {
  const project = { root: "/w/repo", slug: "repo-123" };
  const sup = renderRoleContract("supervisor", { project });
  const lead = renderRoleContract("lead", { project });
  const expectedPointer = "If paseo_factory MCP is absent, use the factory CLI fallback via factory --help.";

  for (const [label, text] of [
    ["supervisor", sup],
    ["lead", lead],
  ] as const) {
    assert.ok(text.includes(expectedPointer), `${label} contract carries the exact 1-line CLI fallback pointer`);
    for (const removed of [
      "Day-one Supervisor commands",
      "Day-one Lead commands",
      "lead dispatch --workspace",
      "contract --task",
      "accept <task> --attempt",
      "lead_create_worktree",
    ]) {
      assert.ok(!text.includes(removed), `${label} contract omits \`${removed}\``);
    }
  }

  const supBoot = renderSeatBootstrapPrompt({
    seat: "supervisor",
    home: "/trial",
    stateDir: "/trial/state",
    nodePath: process.execPath,
    path: "/usr/bin",
    lane: "codex",
    project,
  });
  const leadBoot = renderSeatBootstrapPrompt({
    seat: "lead",
    home: "/trial",
    stateDir: "/trial/state",
    nodePath: process.execPath,
    path: "/usr/bin",
    lane: "codex",
    project,
  });
  assert.match(supBoot, /lead dispatch --workspace/);
  assert.match(supBoot, /accept <task> --attempt <n> --by supervisor/);
  assert.match(leadBoot, /contract --task <id>/);
  assert.match(leadBoot, /run <task>/);
  assert.ok(!leadBoot.includes("lead_create_worktree"), "bootstrap drops retired lead_create_worktree");

  assert.doesNotMatch(renderRoleContract("agent"), /factory --help|Factory CLI/i);
  assert.doesNotMatch(ROLE_PROMPTS.agent, /factory --help|Factory CLI/i);
});

test("Supervisor 4-Line Ratification Card uses English labels + active conversation language rule, and law constants stay single-line", () => {
  const sup = renderRoleContract("supervisor");
  for (const label of ["1. Recurrence", "2. Root Cause", "3. Proposed Diff", "4. Expected Effect", "matching Owner's active conversation language"]) {
    assert.ok(SUPERVISOR_OUTCOME_BOUNDARY.includes(label), `SUPERVISOR_OUTCOME_BOUNDARY includes \`${label}\``);
    assert.ok(sup.includes(label), `renderRoleContract('supervisor') includes \`${label}\``);
  }
  for (const viet of ["Chuyện gì đã lặp lại", "Nguyên nhân gốc", "Nếu duyệt sẽ sửa gì", "Tác dụng"]) {
    assert.ok(!SUPERVISOR_OUTCOME_BOUNDARY.includes(viet), `SUPERVISOR_OUTCOME_BOUNDARY omits hardcoded Vietnamese label \`${viet}\``);
    assert.ok(!sup.includes(viet), `renderRoleContract('supervisor') omits hardcoded Vietnamese label \`${viet}\``);
  }

  for (const line of [
    ...LEAD_WAVE_LAWS,
    LEAD_STORE_RELEASE_LAW,
    SUPERVISOR_FACTORY_OPERATOR_BOUNDARY,
    SUPERVISOR_OUTCOME_BOUNDARY,
    SUPERVISOR_STORE_RELEASE_BOUNDARY,
    SUPERVISOR_STORE_RELEASE_OFF_HINT,
  ]) {
    assert.ok(!line.includes("\n"), `law constant line must not contain internal newlines: ${line.slice(0, 60)}`);
  }
});

test("APPEND_SYSTEM.md stays disposition-neutral while each scoped Peer surface injects strictly one active disposition", () => {
  const neutral = renderRoleAppendSystem("agent");
  assert.equal(neutral, ROLE_PROMPTS.agent);
  assert.match(neutral, /You are an independent Peer working a provisional brief/);
  for (const dispOnly of [
    "read-only-disposition-fence",
    "--runInBand",
    "Commit completed work",
    "alternatives considered",
    "strongest evidence-backed weakness",
    "confidence (low | medium | high)",
  ]) {
    assert.ok(!neutral.includes(dispOnly), `disposition-neutral APPEND_SYSTEM.md omits \`${dispOnly}\``);
  }

  for (const disposition of DISPOSITIONS) {
    const scoped = renderRoleContract("agent", {
      task: "T-01",
      project: { root: "/w/repo", slug: "repo-123" },
      disposition,
    });
    const kickoff = buildRoleKickoffPrompt("agent", {
      task: "T-01",
      project: { root: "/w/repo", slug: "repo-123" },
      disposition,
    });
    const own = PEER_DISPOSITION_CONTRACTS[disposition];
    assert.ok(scoped.includes(`You are an ${own.roleTitle}`), `${disposition} opens with its own roleTitle`);
    assert.ok(kickoff.includes(`You are an ${own.roleTitle}`), `${disposition} kickoff opens with its own roleTitle`);
    assertTopologyBlind(kickoff, `kickoff:${disposition}`);
    assert.ok(scoped.includes(own.constraints), `${disposition} includes its own constraints`);
    assert.ok(scoped.includes(own.workflow), `${disposition} includes its own workflow`);
    assert.ok(scoped.includes(own.outputRule), `${disposition} includes its own outputRule`);

    for (const other of DISPOSITIONS) {
      if (other === disposition) continue;
      const otherTitle = PEER_DISPOSITION_CONTRACTS[other].roleTitle;
      assert.ok(!scoped.includes(otherTitle), `${disposition} must not leak ${other}'s roleTitle`);
    }
    if (disposition === "engineer") {
      assert.ok(!scoped.includes("read-only-disposition-fence"), "engineer omits read-only fence");
    } else {
      assert.ok(!scoped.includes("--runInBand"), `${disposition} omits engineer serial-runner clause`);
      assert.ok(!scoped.includes("Commit completed work"), `${disposition} omits engineer commit instruction`);
      assert.ok(!scoped.includes("--sha") && !scoped.includes("for the committed HEAD"), `${disposition} omits --sha`);
    }
  }
});

test("Peer disposition guidance, driver renderBrief, and peerHandoffContinuationFooter stay topology-blind and omit --sha on read-only dispositions", () => {
  assert.equal(
    renderBrief("T-74", "/custom/bin", "Build slice", ["tdd"], "factory/T-74", "engineer"),
    renderBrief("T-74", "/custom/bin", "Build slice", ["tdd"], "factory/T-74", undefined),
    "driver renderBrief treats omitted disposition identically to explicit engineer",
  );

  for (const disposition of DISPOSITIONS) {
    const guidance = renderPeerDispositionGuidance(disposition);
    const brief = renderBrief("T-74", "/custom/bin", "Slice brief", undefined, "factory/T-74", disposition);
    const footer = peerHandoffContinuationFooter(disposition);
    const contract = renderRoleContract("agent", { task: "T-74", project: { root: "/w/repo", slug: "repo-123" }, disposition });

    for (const [label, surface] of [
      [`guidance:${disposition}`, guidance],
      [`brief:${disposition}`, brief],
      [`footer:${disposition}`, footer],
      [`contract:${disposition}`, contract],
    ] as const) {
      assertTopologyBlind(surface, label);
      if (disposition !== "engineer") {
        assert.ok(!surface.includes("--sha"), `${label} must omit --sha`);
        assert.ok(!surface.includes("for the committed HEAD"), `${label} must omit committed-HEAD claim phrasing`);
      }
    }
    assert.ok(brief.includes(guidance), `driver renderBrief embeds guidance for ${disposition}`);
    assert.ok(guidance.startsWith(`Disposition guidance (${disposition}):`));
  }
});

test("roles.ts resolves contract.disposition dynamically on injectSessionEnv create/resume, legacy injectRoleOnCreate, and leaves Pi appendSystemPrompt absent", (t) => {
  const dir = makeTempDir("roles-disp-scope-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const userHome = join(dir, "home");
  const repoDir = makeGitRepo(dir);
  const resolved = resolveProject(repoDir);
  assert.ok(resolved.ok);
  const slug = resolved.slug;
  const projectDataDir = join(stateDir, "projects", slug);
  mkdirSync(projectDataDir, { recursive: true });
  const worktreeDir = join(projectDataDir, "worktrees", "T-DISP");
  mkdirSync(worktreeDir, { recursive: true });

  // Seq 1: scout contract
  writeFileSync(
    join(projectDataDir, "ledger.jsonl"),
    JSON.stringify({
      event: "contract_set",
      seq: 1,
      ts: new Date().toISOString(),
      task: "T-DISP",
      workspace: repoDir,
      gate: "",
      disposition: "scout",
      description: "Map boundaries read-only.",
    }) + "\n",
  );

  // Legacy (<0.17.1) create resolves scout disposition
  const legacyCreate = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "antigravity/gemini-4-argon", cwd: worktreeDir, title: "T-DISP" } },
    stateDir,
    userHome,
    { liveRoleContract: false },
  );
  assert.ok(legacyCreate !== undefined);
  assert.match(legacyCreate.config.systemPrompt ?? "", /You are an independent scout \(task T-DISP, project /);
  assert.match(legacyCreate.config.systemPrompt ?? "", /read-only-disposition-fence/);
  assert.doesNotMatch(legacyCreate.config.systemPrompt ?? "", /--runInBand/);

  // Live (>=0.17.1) create + open resolves scout disposition
  const liveCreate = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "antigravity/gemini-4-argon", cwd: worktreeDir, title: "T-DISP" } },
    stateDir,
    userHome,
    { liveRoleContract: true },
  );
  assert.ok(liveCreate !== undefined);
  const openScout = injectSessionEnv(
    {
      agentId: "peer-disp-1",
      cwd: worktreeDir,
      provider: "antigravity/gemini-4-argon",
      reason: "create",
      purpose: "interactive",
      env: { ...(liveCreate.env ?? {}) },
    },
    stateDir,
    userHome,
    { liveRoleContract: true },
  );
  assert.match(openScout?.appendSystemPrompt?.[0] ?? "", /You are an independent scout/);
  assert.doesNotMatch(openScout?.appendSystemPrompt?.[0] ?? "", /Commit completed work/);

  // Update contract disposition to architect and resume -> switches dynamically
  appendFileSync(
    join(projectDataDir, "ledger.jsonl"),
    JSON.stringify({
      event: "contract_set",
      seq: 2,
      ts: new Date().toISOString(),
      task: "T-DISP",
      workspace: repoDir,
      gate: "",
      disposition: "architect",
      description: "Design boundary.",
    }) + "\n",
  );
  const openArchitect = injectSessionEnv(
    {
      agentId: "peer-disp-1",
      cwd: worktreeDir,
      provider: "antigravity/gemini-4-argon",
      reason: "resume",
      purpose: "interactive",
      env: { ...(openScout?.env ?? {}) },
    },
    stateDir,
    userHome,
    { liveRoleContract: true },
  );
  assert.match(openArchitect?.appendSystemPrompt?.[0] ?? "", /You are an independent architect/);
  assert.match(openArchitect?.appendSystemPrompt?.[0] ?? "", /alternatives considered/);
  assert.doesNotMatch(openArchitect?.appendSystemPrompt?.[0] ?? "", /You are an independent scout/);

  // Pi keeps appendSystemPrompt absent even when liveRoleContract is true (uses shared APPEND_SYSTEM.md)
  const piCreate = injectRoleOnCreate<AgentCreateRequest>(
    { config: { provider: "pi/zai/glm-5.3", cwd: worktreeDir, title: "T-DISP" } },
    stateDir,
    userHome,
    { liveRoleContract: true },
  );
  assert.ok(piCreate !== undefined);
  const piOpen = injectSessionEnv(
    {
      agentId: "peer-pi-1",
      cwd: worktreeDir,
      provider: "pi/zai/glm-5.3",
      reason: "create",
      purpose: "interactive",
      env: { ...(piCreate.env ?? {}) },
    },
    stateDir,
    userHome,
    { liveRoleContract: true },
  );
  assert.equal("appendSystemPrompt" in (piOpen ?? {}), false, "Pi keeps appendSystemPrompt absent (shared APPEND_SYSTEM.md)");
});
