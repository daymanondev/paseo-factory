import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionPiAgentHome, ROLE_PROMPTS } from "../src/pi-home.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The Pi harness home provisioner (v0.0.16, ADR 0011; v0.0.20, ADR 0013):
 * every factory role — `supervisor`, `lead`, working `agent`, and the
 * tool-less `headless` pass — gets an isolated `PI_CODING_AGENT_DIR` under
 * `<stateDir>/pi-agent/<role>`: a generated clean-room `settings.json`, a
 * sanitized `mcp.json`, and symlinks back to the operator's Pi home for
 * shared state. Never linked or copied for any role: `SYSTEM.md`,
 * `extensions/`. Since v0.0.20 the three interactive roles carry a MANAGED
 * `APPEND_SYSTEM.md` (their immutable SLP contract + `factory` CLI
 * vocabulary, `ROLE_PROMPTS[role]`), and `supervisor` alone symlinks the
 * operator's `prompts/` and `skills/` back in. Tests drive the public entry
 * point only, against a fake source Pi home in a temp directory — the real
 * `~/.pi/agent` is never read (spec §Testing Decisions).
 */

/** Seeds a fake operator Pi home at `piAgent` — the messy global one isolation protects roles from. */
function seedPiAgent(piAgent: string): string {
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

/** Seeds the fake operator Pi home at the conventional `<dir>/pi-home/.pi/agent` path. */
function makeFakePiAgent(dir: string): string {
  return seedPiAgent(join(dir, "pi-home", ".pi", "agent"));
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
  // The operator's prompt contamination never lands in the harness home:
  // SYSTEM.md and extensions stay swept; APPEND_SYSTEM.md is the MANAGED
  // role contract (v0.0.20, ADR 0013), never the operator's; prompts/ and
  // skills/ symlink back so the Owner keeps 100% of personal slash commands
  // and skills on Supervisor.
  for (const forbidden of ["SYSTEM.md", "extensions"]) {
    assert.ok(!existsSync(join(roleHome, forbidden)), `${forbidden} never lands in the harness home`);
  }
  const appendSystem = readFileSync(join(roleHome, "APPEND_SYSTEM.md"), "utf8");
  assert.equal(appendSystem, ROLE_PROMPTS.supervisor, "supervisor carries its managed SLP role contract");
  assert.ok(!appendSystem.includes("Auto-Delegation"), "the operator's APPEND_SYSTEM.md content never leaks in");
  for (const name of ["prompts", "skills"]) {
    const link = join(roleHome, name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name} is a symlink back to the source home`);
    assert.equal(realpathSync(link), realpathSync(join(source, name)));
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

test("interactive roles carry managed APPEND_SYSTEM.md; headless never does; only supervisor links operator prompts/skills (v0.0.20, ADR 0013)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  // Every interactive role gets its own managed role contract — the file Pi
  // reloads into _baseSystemPrompt on every turn, every /compact, and every
  // session resume — never the operator's auto-delegation rules.
  const seen = new Set<string>();
  for (const role of ["supervisor", "lead", "agent"] as const) {
    const home = provisionPiAgentHome({ stateDir, role, sourceAgentDir: source });
    const content = readFileSync(join(home, "APPEND_SYSTEM.md"), "utf8");
    assert.equal(content, ROLE_PROMPTS[role], `${role} carries its canonical ROLE_PROMPTS entry`);
    assert.ok(!content.includes("Auto-Delegation"), `the operator's APPEND_SYSTEM.md never reaches ${role}`);
    assert.ok(!seen.has(content), "each role's contract is distinct");
    seen.add(content);
  }

  // The canonical table itself: each entry carries the role's immutable SLP
  // contract plus its exact factory CLI command vocabulary — Supervisor gets
  // lead dispatch / status / accept --by supervisor (never contract or run)
  // plus the Fire-and-End-Turn law; Lead gets contract / run / status / lanes
  // get / accept --by lead / supervisor report plus the Seat write fence;
  // the working agent gets its single factory-claim command.
  assert.ok(ROLE_PROMPTS.supervisor.includes("You are"), "the supervisor contract opens with its SLP law");
  for (const cmd of ["factory --home", "lead dispatch", "status", "lanes get", "accept <task> --attempt <n> --by supervisor"]) {
    assert.ok(ROLE_PROMPTS.supervisor.includes(cmd), `ROLE_PROMPTS.supervisor names \`${cmd}\``);
  }
  assert.ok(
    ROLE_PROMPTS.supervisor.includes(
      "Immediately after running `lead dispatch`, end your turn and wait for Lead to wake you via `factory supervisor report` or `needs_human`.",
    ),
    "ROLE_PROMPTS.supervisor states the Fire-and-End-Turn law",
  );
  for (const forbidden of ["contract --task", "factory contract", "factory run", "run <task>"]) {
    assert.ok(!ROLE_PROMPTS.supervisor.includes(forbidden), `ROLE_PROMPTS.supervisor never lists \`${forbidden}\``);
  }
  for (const cmd of [
    "factory --home",
    "contract --task",
    "run <task>",
    "status",
    "lanes get",
    "accept <task> --attempt <n> --by lead",
    "supervisor report --workspace",
    "Seat write fence",
  ]) {
    assert.ok(ROLE_PROMPTS.lead.includes(cmd), `ROLE_PROMPTS.lead names \`${cmd}\``);
  }
  assert.ok(ROLE_PROMPTS.agent.includes("factory-claim"), "the working agent's vocabulary is factory-claim");
  assert.ok(!ROLE_PROMPTS.agent.includes("factory --home"), "orchestration commands are withheld from the working agent");

  // lead, agent, and headless stay strictly stripped of the operator's
  // prompts and skills — only Supervisor keeps 100% command parity.
  for (const role of ["lead", "agent", "headless"] as const) {
    const home = provisionPiAgentHome({ stateDir, role, sourceAgentDir: source });
    for (const name of ["prompts", "skills"]) {
      assert.ok(!existsSync(join(home, name)), `${name} stays stripped from ${role}`);
    }
  }

  // The tool-less headless pass never carries an APPEND_SYSTEM.md — not the
  // role default, not even an explicitly provided one.
  const headlessHome = provisionPiAgentHome({ stateDir, role: "headless", sourceAgentDir: source });
  assert.ok(!existsSync(join(headlessHome, "APPEND_SYSTEM.md")), "headless never carries APPEND_SYSTEM.md");
  const explicitHeadless = provisionPiAgentHome({
    stateDir: join(dir, "state-explicit"),
    role: "headless",
    sourceAgentDir: source,
    appendSystemPrompt: "# should not land\n",
  });
  assert.ok(!existsSync(join(explicitHeadless, "APPEND_SYSTEM.md")), "an explicit appendSystemPrompt never lands for headless either");
});

test("appendSystemPrompt overrides the role default; an empty override writes nothing (v0.0.20, ADR 0013)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  const home = provisionPiAgentHome({
    stateDir,
    role: "lead",
    sourceAgentDir: source,
    appendSystemPrompt: "# Custom lead brief\n",
  });
  assert.equal(readFileSync(join(home, "APPEND_SYSTEM.md"), "utf8"), "# Custom lead brief\n", "the override lands verbatim");

  const empty = provisionPiAgentHome({
    stateDir: join(dir, "state-empty"),
    role: "agent",
    sourceAgentDir: source,
    appendSystemPrompt: "",
  });
  assert.ok(!existsSync(join(empty, "APPEND_SYSTEM.md")), "an empty appendSystemPrompt writes no file");
});

test("each role gets its skills policy: agent filtered, supervisor/lead unfiltered, headless fully denied (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  // The working agent sees only its three core skills, pinned under the
  // passed catalog root — the default deployment's `~` form resolves to the
  // same place at session time.
  const catalogRoot = join(dir, "catalog", "skills");
  const agentHome = provisionPiAgentHome({
    stateDir,
    role: "agent",
    sourceAgentDir: source,
    agentsSkillsDir: catalogRoot,
  });
  const agentSettings = JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8"));
  assert.deepEqual(agentSettings.skills, [
    "!*",
    `+${join(catalogRoot, "tdd")}`,
    `+${join(catalogRoot, "diagnosing-bugs")}`,
    `+${join(catalogRoot, "codebase-design")}`,
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
    "APPEND_SYSTEM.md",
    "auth.json",
    "mcp-oauth",
    "mcp.json",
    "models-store.json",
    "models.json",
    "prompts",
    "sessions",
    "settings.json",
    "skills",
  ], "the harness home holds exactly the generated files and shared-state links — no strays");
  const authLink = join(first, "auth.json");
  const linkInoBefore = lstatSync(authLink).ino;
  const settingsBefore = readFileSync(join(first, "settings.json"), "utf8");
  const appendBefore = readFileSync(join(first, "APPEND_SYSTEM.md"), "utf8");

  const second = provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });

  assert.equal(second, first, "a second call finds the same home");
  assert.ok(lstatSync(authLink).isSymbolicLink(), "the symlink survives a re-provision");
  assert.equal(realpathSync(authLink), realpathSync(join(source, "auth.json")));
  assert.equal(lstatSync(authLink).ino, linkInoBefore, "an already-correct symlink is left untouched, never re-made or duplicated");
  assert.equal(readFileSync(join(second, "settings.json"), "utf8"), settingsBefore, "settings.json is byte-stable across calls");
  assert.equal(readFileSync(join(second, "APPEND_SYSTEM.md"), "utf8"), appendBefore, "APPEND_SYSTEM.md is rewritten to the same bytes");
  // The sweep retires the command links and they re-link to the same
  // targets — one prompts, one skills, never duplicated (the readdir
  // deepEqual above proves the exact entry set on every call).
  for (const name of ["prompts", "skills"]) {
    const link = join(second, name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name} is re-linked as a symlink`);
    assert.equal(realpathSync(link), realpathSync(join(source, name)), `${name} re-links to the same source target`);
  }

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

test("optional sources stay optional: absent stores are not linked, sessions are ensured, junk defaults dropped (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = join(dir, "pi-home", ".pi", "agent");
  mkdirSync(source, { recursive: true });
  // Only a settings.json — no auth, no models, no OAuth stores, no mcp.json, no sessions/.
  writeFileSync(
    join(source, "settings.json"),
    JSON.stringify({
      defaultProvider: 42, // non-string — dropped
      defaultModel: "glm-5.3",
      defaultThinkingLevel: null, // non-string — dropped
      packages: ["npm:context-mode"],
    }),
  );
  const stateDir = join(dir, "factory-state");

  const home = provisionPiAgentHome({ stateDir, role: "lead", sourceAgentDir: source });

  const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  assert.deepEqual(settings, {
    defaultModel: "glm-5.3",
    packages: [],
    extensions: ["-builtin:llama.cpp"],
    quietStartup: true,
    defaultProjectTrust: "always",
  });
  for (const absent of ["auth.json", "models.json", "models-store.json", "mcp-oauth", "mcp-oauth.json", "oauth", "credentials", "mcp.json"]) {
    assert.ok(!existsSync(join(home, absent)), `${absent} is not invented when the source has none`);
  }
  // sessions/ was absent in a writable source — it is ensured there and linked here.
  assert.ok(existsSync(join(source, "sessions")), "the source sessions dir is ensured");
  assert.ok(lstatSync(join(home, "sessions")).isSymbolicLink(), "and the role home links to it");
  assert.equal(realpathSync(join(home, "sessions")), realpathSync(join(source, "sessions")));

  // An invalid (or mcpServers-less) source mcp.json still yields no harness copy.
  writeFileSync(join(source, "mcp.json"), "{ not json");
  provisionPiAgentHome({ stateDir, role: "lead", sourceAgentDir: source });
  assert.ok(!existsSync(join(home, "mcp.json")), "invalid JSON yields no harness mcp.json");
  writeFileSync(join(source, "mcp.json"), JSON.stringify({ somethingElse: true }));
  provisionPiAgentHome({ stateDir, role: "lead", sourceAgentDir: source });
  assert.ok(!existsSync(join(home, "mcp.json")), "valid JSON without an mcpServers object yields no harness mcp.json");
});

test("defaults resolve against the runtime home: <home>/.pi/agent and <home>/.agents/skills (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const fakeHome = join(dir, "fake-home");
  seedPiAgent(join(fakeHome, ".pi", "agent"));
  mkdirSync(join(fakeHome, ".agents", "skills"), { recursive: true });
  const stateDir = join(dir, "factory-state");

  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const roleHome = provisionPiAgentHome({ stateDir, role: "agent" });
    assert.equal(roleHome, join(stateDir, "pi-agent", "agent"));
    assert.ok(lstatSync(join(roleHome, "auth.json")).isSymbolicLink(), "auth links from <home>/.pi/agent");
    assert.equal(realpathSync(join(roleHome, "auth.json")), realpathSync(join(fakeHome, ".pi", "agent", "auth.json")));
    const settings = JSON.parse(readFileSync(join(roleHome, "settings.json"), "utf8"));
    assert.deepEqual(settings.skills, [
      "!*",
      "+~/.agents/skills/tdd",
      "+~/.agents/skills/diagnosing-bugs",
      "+~/.agents/skills/codebase-design",
    ]);
  } finally {
    process.env.HOME = previousHome;
  }
});

test("an unwritable source home skips the sessions link instead of failing the seat (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = join(dir, "pi-home", ".pi", "agent");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "settings.json"), JSON.stringify({ defaultModel: "glm-5.3" }));
  const stateDir = join(dir, "factory-state");

  chmodSync(source, 0o555);
  try {
    const roleHome = provisionPiAgentHome({ stateDir, role: "agent", sourceAgentDir: source });
    assert.ok(existsSync(join(roleHome, "settings.json")), "provisioning still completes");
    assert.ok(!existsSync(join(roleHome, "sessions")), "the sessions link is skipped when it cannot be ensured");
  } finally {
    chmodSync(source, 0o755);
  }
});

test("provisioning retires pre-isolation contamination left in the harness home (v0.0.16, ADR 0011)", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");
  const roleHome = join(stateDir, "pi-agent", "agent");
  mkdirSync(join(roleHome, "skills"), { recursive: true });
  writeFileSync(join(roleHome, "skills", "personal.md"), "# personal\n");
  writeFileSync(join(roleHome, "APPEND_SYSTEM.md"), "# Auto-Delegation Rules\n");

  const home = provisionPiAgentHome({ stateDir, role: "agent", sourceAgentDir: source });

  assert.equal(home, roleHome);
  assert.ok(!existsSync(join(roleHome, "skills")), "a leftover skills/ dir is retired");
  assert.equal(
    readFileSync(join(roleHome, "APPEND_SYSTEM.md"), "utf8"),
    ROLE_PROMPTS.agent,
    "a leftover operator APPEND_SYSTEM.md is replaced by the managed role contract (v0.0.20, ADR 0013)",
  );
});
