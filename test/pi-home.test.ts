import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionPiAgentHome } from "../src/pi-home.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The Pi harness home provisioner (v0.0.16, ADR 0011): every factory role —
 * `supervisor`, `lead`, working `agent`, and the tool-less `headless` pass —
 * gets an isolated `PI_CODING_AGENT_DIR` under `<stateDir>/pi-agent/<role>`:
 * a generated clean-room `settings.json`, a sanitized `mcp.json`, and
 * symlinks back to the operator's Pi home for shared state. Never linked or
 * copied: `APPEND_SYSTEM.md`, `SYSTEM.md`, `extensions/`, `prompts/`,
 * `skills/`. Tests drive the public entry point only, against a fake source
 * Pi home in a temp directory — the real `~/.pi/agent` is never read
 * (spec §Testing Decisions).
 */

/** Seeds a fake operator Pi home — the messy global one isolation protects roles from. */
function makeFakePiAgent(dir: string): string {
  const piAgent = join(dir, "pi-home", ".pi", "agent");
  mkdirSync(join(piAgent, "extensions"), { recursive: true });
  writeFileSync(join(piAgent, "extensions", "cmux.ts"), "// tui extension\n");
  writeFileSync(join(piAgent, "APPEND_SYSTEM.md"), "# Auto-Delegation Rules\n");
  writeFileSync(join(piAgent, "SYSTEM.md"), "# global system\n");
  writeFileSync(join(piAgent, "auth.json"), '{"keys":{}}');
  writeFileSync(join(piAgent, "models.json"), "{}");
  writeFileSync(join(piAgent, "models-store.json"), "{}");
  mkdirSync(join(piAgent, "mcp-oauth"), { recursive: true });
  mkdirSync(join(piAgent, "sessions"), { recursive: true });
  mkdirSync(join(piAgent, "prompts"), { recursive: true });
  mkdirSync(join(piAgent, "skills"), { recursive: true });
  writeFileSync(
    join(piAgent, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: "zai",
        defaultModel: "glm-5.3",
        defaultThinkingLevel: "medium",
        packages: ["npm:context-mode", "npm:pi-subagents"],
        quietStartup: false,
        defaultProjectTrust: "never",
        subagents: { oracle: { model: "zai/glm-5.2" } },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(piAgent, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "legacy-http": { url: "https://x", auth: "oauth" },
          "stdio-ok": { command: "npx", args: ["-y", "mcp"] },
          "modern-oauth": { url: "https://y", auth: { provider: "anthropic" } },
        },
      },
      null,
      2,
    ),
  );
  return piAgent;
}

test("provisionPiAgentHome materializes a clean supervisor Pi harness home (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  const roleHome = provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });

  assert.equal(roleHome, join(stateDir, "pi-agent", "supervisor"));
  // The generated settings keep only the operator's model/thinking defaults and enforce the clean room.
  const settings = JSON.parse(readFileSync(join(roleHome, "settings.json"), "utf8"));
  assert.deepEqual(settings, {
    defaultProvider: "zai",
    defaultModel: "glm-5.3",
    defaultThinkingLevel: "medium",
    packages: [],
    extensions: ["-builtin:llama.cpp"],
    quietStartup: true,
    defaultProjectTrust: "always",
  });
  // The operator's prompt contamination never lands in the harness home.
  for (const forbidden of ["APPEND_SYSTEM.md", "SYSTEM.md", "extensions", "prompts", "skills"]) {
    assert.ok(!existsSync(join(roleHome, forbidden)), `${forbidden} never lands in the harness home`);
  }
  // Shared state — auth, models, OAuth credentials, sessions — symlinks back to the source.
  for (const name of ["auth.json", "models.json", "models-store.json", "mcp-oauth", "sessions"]) {
    const link = join(roleHome, name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name} is a symlink`);
    assert.equal(realpathSync(link), realpathSync(join(source, name)));
  }
  // The sanitized mcp.json strips legacy "auth": "oauth" strings and keeps everything else.
  const mcp = JSON.parse(readFileSync(join(roleHome, "mcp.json"), "utf8"));
  assert.deepEqual(mcp, {
    mcpServers: {
      "legacy-http": { url: "https://x" },
      "stdio-ok": { command: "npx", args: ["-y", "mcp"] },
      "modern-oauth": { url: "https://y", auth: { provider: "anthropic" } },
    },
  });
});
