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
