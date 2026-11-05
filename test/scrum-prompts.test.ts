import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, disposeDir } from "./helpers.ts";
import { SCRUM_PROMPT_MARK, renderScrumPrompt } from "../src/scrum/prompts.ts";

// Seam 4 (spec v0.2.0 Testing Decisions §4, ADR 0049 §4): renderScrumPrompt
// must encode the SLP operational laws per Scrum role. Assertions target
// stable law phrases over a minimal hermetic identity fixture.

test("Scrum prompts keep the mark header and pre-existing role rules survive hardening", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const identity = { project: "fixture", workspace: root };
  for (const role of ["supervisor", "lead", "pm", "ux", "architect", "dev", "qa"] as const) {
    const prompt = renderScrumPrompt(role, identity);
    assert.ok(prompt.startsWith(SCRUM_PROMPT_MARK), `${role} prompt must start with SCRUM_PROMPT_MARK`);
  }
  assert.match(renderScrumPrompt("supervisor", identity), /You are the Owner's sole conversational contact/);
  assert.match(renderScrumPrompt("lead", identity), /GREEN structural lint does not prove semantic readiness/);
  assert.match(renderScrumPrompt("dev", identity), /Never skip or xfail required tests/);
  assert.match(renderScrumPrompt("qa", identity), /Zero findings is valid/);
});

test("supervisor prompt encodes the First-Action, Diagnostics, Boundary, and Ratification laws", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const prompt = renderScrumPrompt("supervisor", { project: "fixture", workspace: root });
  // First-Action Tool Call Law (ADR 0029): Lead cannot read Supervisor chat.
  assert.match(prompt, /Scrum Lead is a separate process/);
  assert.match(prompt, /cannot read Supervisor chat/);
  assert.match(prompt, /first action/);
  // Diagnostics & Run-Verification Law: read-only inspection before repair dispatch.
  assert.match(prompt, /read-only/);
  assert.match(prompt, /git status/);
  // Outcome/Architecture Boundary: challenge consolidation anti-patterns first.
  assert.match(prompt, /single-file consolidation/);
  // 4-bullet Run Completion Summary + 4-Line Owner Ratification Card.
  assert.match(prompt, /Built\/Fixed/);
  assert.match(prompt, /Verification & Cold-Start Proof/);
  assert.match(prompt, /How to Run/);
  assert.match(prompt, /Residual Risks/);
  assert.match(prompt, /4-Line Owner Ratification/);
  // Owner-Ratification write boundary on project memory.
  assert.match(prompt, /Never edit <project-root>\/AGENTS\.md or CONTEXT\.md without explicit Owner Ratification/);
});

test("lead prompt encodes skills, briefs, diff-review, handoff, and wave-hardening laws", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const prompt = renderScrumPrompt("lead", { project: "fixture", workspace: root });
  // Peer-Owned Domain Skills Law (ADR 0047).
  assert.match(prompt, /Peer-Owned Domain Skills/);
  assert.match(prompt, /SKILL\.md/);
  // Concise <= 2,500-char 4-Part Briefs.
  assert.match(prompt, /2,500/);
  assert.match(prompt, /Bounded Outcome/);
  assert.match(prompt, /Contract Boundary & Regression Invariants/);
  assert.match(prompt, /Excluded \/ Deferred Scope/);
  assert.match(prompt, /Verification Gate/);
  // Bounded per-file diff review + Proof Falsification + out-of-band script ban.
  assert.match(prompt, /6,000/);
  assert.match(prompt, /git show --stat "<sha>"/);
  assert.match(prompt, /git diff "<sha>\^" "<sha>" -- <file>/);
  assert.match(prompt, /JSON\.stringify/);
  assert.match(prompt, /node -e/);
  assert.match(prompt, /python3 -c/);
  assert.match(prompt, /Proof Falsification/);
  assert.match(prompt, /If the claimed behavior disappeared, would the specialist's test fail\?/);
  assert.match(prompt, /lead_accept_task/);
  // 160k Context-Ceiling Recovery via peer-handoff files.
  assert.match(prompt, /context-ceiling/);
  assert.match(prompt, /160k/);
  assert.match(prompt, /peer-handoff-<task>\.md/);
  assert.match(prompt, /narrower follow-up story/);
  // Wave Hardening / Recurrence Guard in the project notebook.
  assert.match(prompt, /observed → recurred → hardened → verified/);
  assert.match(prompt, /notebook\.md/);
  assert.match(prompt, /<= 80 lines/);
  assert.match(prompt, /fix_cycle/);
  assert.match(prompt, /root-cause pattern/);
  assert.match(prompt, /sibling sweep/);
  assert.match(prompt, /regression test/);
});

test("dev prompt encodes slice tests, anti-whack-a-mole, and sibling-sweep laws", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const prompt = renderScrumPrompt("dev", { project: "fixture", workspace: root });
  // Tier-1 slice self-check + modular per-slice test files with timeouts.
  assert.match(prompt, /Tier-1/);
  assert.match(prompt, /tests\/<slice>\.\*/);
  assert.match(prompt, /15s/);
  assert.match(prompt, /30s/);
  // Anti-Whack-a-Mole Law: stop after a 3rd same-symptom failure and escalate.
  assert.match(prompt, /Anti-Whack-a-Mole/);
  assert.match(prompt, /3rd/);
  assert.match(prompt, /REOPEN_REQUEST/);
  assert.match(prompt, /DEPENDENCY_REQUEST/);
  assert.match(prompt, /BLOCKED/);
  // Recurrence Guard sibling sweep on fix-* tasks.
  assert.match(prompt, /fix-\*/);
  assert.match(prompt, /sibling/);
  assert.match(prompt, /regression test/);
});

test("qa prompt encodes mandatory Tier-2 and Tier-3 verification prerequisites", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const prompt = renderScrumPrompt("qa", { project: "fixture", workspace: root });
  // Tier-2 Cross-Module Integration: real caller → callee, no seam mocking.
  assert.match(prompt, /Tier-2 Cross-Module Integration/);
  assert.match(prompt, /caller → callee/);
  assert.match(prompt, /without mocking the seam under test/);
  // Tier-3 Cold-Start Entrypoint Smoke: cold boot, zero uncaught errors.
  assert.match(prompt, /Tier-3 Cold-Start Entrypoint Smoke/);
  assert.match(prompt, /zero uncaught/);
  // Recorded in qa-report.md / regression bundle before qa.audit passes.
  assert.match(prompt, /qa-report\.md/);
  assert.match(prompt, /regression bundle/);
  assert.match(prompt, /qa\.audit/);
  assert.match(prompt, /passed/);
});
