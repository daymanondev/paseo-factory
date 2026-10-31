import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, disposeDir } from "./helpers.ts";
import { buildSeatKickoffPacket } from "../src/preflight.ts";
import { renderScrumPrompt } from "../src/scrum/prompts.ts";

test("kickoff and Scrum prompts report present and absent project memory", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const input = { role: "lead" as const, projectSlug: "empty", projectRoot: root, ledgerEvents: [] };
  assert.match(buildSeatKickoffPacket(input), /Project memory: none present on disk/);
  writeFileSync(join(root, "AGENTS.md"), "rules");
  const packet = buildSeatKickoffPacket(input);
  assert.match(packet, /read before acting: AGENTS.md/);
  assert.match(packet, /CLAUDE.md \(absent — do not call read_file\)/);
  assert.match(packet, /CONTEXT.md \(absent — do not call read_file\)/);
  for (const role of ["supervisor", "lead", "pm", "ux", "architect", "dev", "qa"] as const) {
    const prompt = renderScrumPrompt(role, { project: "empty", workspace: root });
    assert.match(prompt, /read before acting: AGENTS.md/);
    assert.doesNotMatch(prompt, /Use factory scrum|factory contract/);
    if (role === "lead") assert.match(prompt, /lead_scrum_operation/);
    if (role === "supervisor") assert.match(prompt, /supervisor_scrum_decision/);
  }
});

test("Lead kickoff describes Peer helpers and warns before dispatch with missing credentials", async (t) => {
  const { buildRoleKickoffPrompt } = await import("../src/roles-contract.ts");
  const dir = makeTempDir(); disposeDir(t, dir);
  const helperMcps = [{ name: "supabase", transport: "http" as const, status: "auth_expired" as const, enabled: true }];
  const packet = buildSeatKickoffPacket({ role: "lead", projectSlug: "repo", projectRoot: dir, ledgerEvents: [], helperMcps });
  assert.match(packet, /Available Peer Helper MCPs/);
  assert.match(packet, /supabase \[http · auth_expired\]/);
  assert.match(packet, /WARNING/);
  for (const role of ["lead", "agent"] as const) assert.match(buildRoleKickoffPrompt(role, { helperMcps }), /supabase \[http · auth_expired\]/);
});
