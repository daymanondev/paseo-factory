import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("each role gets its skills policy: agent filtered, supervisor/lead unfiltered, headless fully denied (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  // The working agent sees only its three core skills, in Pi's `~` form (which
  // resolves to agentsSkillsDir at session time) — even when a catalog root is
  // passed explicitly.
  const agentHome = provisionPiAgentHome({
    stateDir,
    role: "agent",
    sourceAgentDir: source,
    agentsSkillsDir: join(dir, "catalog", "skills"),
  });
  const agentSettings = JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8"));
  assert.deepEqual(agentSettings.skills, [
    "!*",
    "+~/.agents/skills/tdd",
    "+~/.agents/skills/diagnosing-bugs",
    "+~/.agents/skills/codebase-design",
  ]);
  assert.deepEqual(agentSettings.extensions, ["-builtin:llama.cpp"]);
  assert.ok(existsSync(join(agentHome, "mcp.json")), "the agent still gets the sanitized mcp.json");
  assert.ok(lstatSync(join(agentHome, "auth.json")).isSymbolicLink(), "the agent still shares auth");

  // The seats leave "skills" out entirely so pi auto-discovers all of ~/.agents/skills.
  for (const seat of ["supervisor", "lead"] as const) {
    const seatHome = provisionPiAgentHome({ stateDir, role: seat, sourceAgentDir: source });
    const seatSettings = JSON.parse(readFileSync(join(seatHome, "settings.json"), "utf8"));
    assert.ok(!("skills" in seatSettings), `${seat} keeps skills unfiltered for ~/.agents/skills auto-discovery`);
    assert.deepEqual(seatSettings.extensions, ["-builtin:llama.cpp"]);
  }

  // The tool-less headless pass denies every skill and every interactive
  // builtin extension, and never sees an mcp.json — but still shares sessions.
  const headlessHome = provisionPiAgentHome({ stateDir, role: "headless", sourceAgentDir: source });
  const headlessSettings = JSON.parse(readFileSync(join(headlessHome, "settings.json"), "utf8"));
  assert.deepEqual(headlessSettings.skills, ["!*"]);
  assert.deepEqual(headlessSettings.extensions, [
    "-builtin:llama.cpp",
    "-builtin:mcp",
    "-builtin:codemode",
    "-builtin:tool-search",
  ]);
  assert.ok(!existsSync(join(headlessHome, "mcp.json")), "the tool-less headless pass never sees an mcp.json");
  assert.ok(lstatSync(join(headlessHome, "sessions")).isSymbolicLink(), "headless still shares sessions");
});

test("provisioning is idempotent and re-synchronizes mcp.json on every call (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  const first = provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  assert.deepEqual(readdirSync(first).sort(), [
    "auth.json",
    "mcp-oauth",
    "mcp.json",
    "models-store.json",
    "models.json",
    "sessions",
    "settings.json",
  ], "the harness home holds exactly the generated files and shared-state links — no strays");
  const authLink = join(first, "auth.json");
  const linkInoBefore = lstatSync(authLink).ino;
  const settingsBefore = readFileSync(join(first, "settings.json"), "utf8");

  const second = provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });

  assert.equal(second, first, "a second call finds the same home");
  assert.ok(lstatSync(authLink).isSymbolicLink(), "the symlink survives a re-provision");
  assert.equal(realpathSync(authLink), realpathSync(join(source, "auth.json")));
  assert.equal(lstatSync(authLink).ino, linkInoBefore, "an already-correct symlink is left untouched, never re-made or duplicated");
  assert.equal(readFileSync(join(second, "settings.json"), "utf8"), settingsBefore, "settings.json is byte-stable across calls");

  // Operator edits the global mcp.json — the next provision call propagates them.
  writeFileSync(
    join(source, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "legacy-http": { url: "https://x", auth: "oauth" }, // still stripped
          added: { command: "node", args: ["server.js"] }, // newly added
        },
      },
      null,
      2,
    ),
  );
  provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  assert.deepEqual(JSON.parse(readFileSync(join(second, "mcp.json"), "utf8")), {
    mcpServers: {
      "legacy-http": { url: "https://x" },
      added: { command: "node", args: ["server.js"] },
    },
  });

  // Operator deletes the global mcp.json — the stale sanitized copy retires with it.
  rmSync(join(source, "mcp.json"));
  provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  assert.ok(!existsSync(join(second, "mcp.json")), "a removed source mcp.json retires the harness copy");
});
