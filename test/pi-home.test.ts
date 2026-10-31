import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    defaultTools: ["read", "bash", "grep", "find", "ls"],
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
  // The sanitized mcp.json strips legacy "auth": "oauth" strings, keeps everything else, and injects paseo_factory.
  const mcp = JSON.parse(readFileSync(join(roleHome, "mcp.json"), "utf8"));
  assert.deepEqual(mcp, {
    mcpServers: {
      paseo_factory: {
        command: process.execPath,
        args: [join(stateDir, "bin", "bridge.mjs"), "--role", "supervisor", "--state-dir", stateDir],
        exposure: "direct",
        timeout: 600,
      },
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

test("each role gets its skills policy: lead and agent filtered to role skills, supervisor unfiltered, headless fully denied (v0.0.16, ADR 0011)", (t) => {
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
    `+${join(catalogRoot, "*")}`,
    `-${join(catalogRoot, "factory")}`,
  ]);
  assert.deepEqual(agentSettings.extensions, ["-builtin:llama.cpp"]);
  assert.ok(existsSync(join(agentHome, "mcp.json")), "the agent still gets the sanitized mcp.json");
  assert.ok(lstatSync(join(agentHome, "auth.json")).isSymbolicLink(), "the agent still shares auth");

  // Lead sees only its three core role skills (`codebase-design`, `domain-modeling`, `tdd`).
  const leadHome = provisionPiAgentHome({
    stateDir,
    role: "lead",
    sourceAgentDir: source,
    agentsSkillsDir: catalogRoot,
  });
  const leadSettings = JSON.parse(readFileSync(join(leadHome, "settings.json"), "utf8"));
  assert.deepEqual(leadSettings.skills, [
    "!*",
    `+${join(catalogRoot, "codebase-design")}`,
    `+${join(catalogRoot, "domain-modeling")}`,
    `+${join(catalogRoot, "tdd")}`,
  ]);
  assert.deepEqual(leadSettings.extensions, ["-builtin:llama.cpp"]);

  // Supervisor alone leaves "skills" out entirely so pi auto-discovers all of ~/.agents/skills.
  const supHome = provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  const supSettings = JSON.parse(readFileSync(join(supHome, "settings.json"), "utf8"));
  assert.ok(!("skills" in supSettings), "supervisor keeps skills unfiltered for ~/.agents/skills auto-discovery");
  assert.deepEqual(supSettings.extensions, ["-builtin:llama.cpp"]);

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
      paseo_factory: {
        command: process.execPath,
        args: [join(stateDir, "bin", "bridge.mjs"), "--role", "supervisor", "--state-dir", stateDir],
        exposure: "direct",
        timeout: 600,
      },
    },
  });

  // Operator deletes the global mcp.json — the stale operator entries retire while paseo_factory stays wired.
  rmSync(join(source, "mcp.json"));
  provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  assert.deepEqual(JSON.parse(readFileSync(join(second, "mcp.json"), "utf8")), {
    mcpServers: {
      paseo_factory: {
        command: process.execPath,
        args: [join(stateDir, "bin", "bridge.mjs"), "--role", "supervisor", "--state-dir", stateDir],
        exposure: "direct",
        timeout: 600,
      },
    },
  });
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
    defaultTools: ["read", "bash", "grep", "find", "ls"],
    skills: [
      "!*",
      "+~/.agents/skills/codebase-design",
      "+~/.agents/skills/domain-modeling",
      "+~/.agents/skills/tdd",
    ],
  });
  for (const absent of ["auth.json", "models.json", "models-store.json", "mcp-oauth", "mcp-oauth.json", "oauth", "credentials"]) {
    assert.ok(!existsSync(join(home, absent)), `${absent} is not invented when the source has none`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")), {
    mcpServers: {
      paseo_factory: {
        command: process.execPath,
        args: [join(stateDir, "bin", "bridge.mjs"), "--role", "lead", "--state-dir", stateDir],
        exposure: "direct",
        timeout: 600,
      },
    },
  });
  // sessions/ was absent in a writable source — it is ensured there and linked here.
  assert.ok(existsSync(join(source, "sessions")), "the source sessions dir is ensured");
  assert.ok(lstatSync(join(home, "sessions")).isSymbolicLink(), "and the role home links to it");
  assert.equal(realpathSync(join(home, "sessions")), realpathSync(join(source, "sessions")));

  // An invalid (or mcpServers-less) source mcp.json still yields only the managed paseo_factory server.
  writeFileSync(join(source, "mcp.json"), "{ not json");
  provisionPiAgentHome({ stateDir, role: "lead", sourceAgentDir: source });
  assert.deepEqual(JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")), {
    mcpServers: {
      paseo_factory: {
        command: process.execPath,
        args: [join(stateDir, "bin", "bridge.mjs"), "--role", "lead", "--state-dir", stateDir],
        exposure: "direct",
        timeout: 600,
      },
    },
  });
  writeFileSync(join(source, "mcp.json"), JSON.stringify({ somethingElse: true }));
  provisionPiAgentHome({ stateDir, role: "lead", sourceAgentDir: source });
  assert.deepEqual(JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")), {
    mcpServers: {
      paseo_factory: {
        command: process.execPath,
        args: [join(stateDir, "bin", "bridge.mjs"), "--role", "lead", "--state-dir", stateDir],
        exposure: "direct",
        timeout: 600,
      },
    },
  });
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
      "+~/.agents/skills/*",
      "-~/.agents/skills/factory",
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

// ---- the v0.0.38 idempotent symlink provisioning (ADR 0026 §1) -------------------------------

test("v0.0.38 (ADR 0026 §1): an already-correct symlink is left untouched (ino/mtime stable); a wrong one is fixed", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  // First provision makes the links: the shared-state links (auth.json) and,
  // for supervisor, the operator-command links (prompts, skills) the
  // forbidden-name sweep would previously churn on EVERY call.
  const first = provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  const watched = ["auth.json", "prompts", "skills"].map((name) => join(first, name));
  const before = watched.map((path) => {
    const stat = lstatSync(path);
    assert.ok(stat.isSymbolicLink(), `${path} starts as a symlink`);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs };
  });

  // A re-provision leaves every already-correct link byte-for-byte the same
  // entry: same inode, same mtime — no remove/recreate race window.
  const second = provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  assert.equal(second, first);
  watched.forEach((path, i) => {
    const stat = lstatSync(path);
    assert.equal(stat.ino, before[i]!.ino, `${path}: the symlink entry is untouched, never re-made`);
    assert.equal(stat.mtimeMs, before[i]!.mtimeMs, `${path}: the symlink's mtime is stable across a re-provision`);
    assert.equal(realpathSync(path), realpathSync(join(source, ["auth.json", "prompts", "skills"][i]!)), `${path} still points at the source home`);
  });

  // A WRONG link is still fixed: retitle prompts at a stray directory and
  // re-provision — the sweep retires it and re-links the expected source.
  const stray = join(dir, "stray-target");
  mkdirSync(stray, { recursive: true });
  rmSync(join(second, "prompts"));
  symlinkSync(stray, join(second, "prompts"));
  // Filesystems may immediately reuse a removed symlink inode. Verify the
  // wrong-target fixture directly rather than depending on allocation policy.
  assert.equal(realpathSync(join(second, "prompts")), realpathSync(stray), "the tampered link points at the stray target");
  provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  assert.equal(realpathSync(join(second, "prompts")), realpathSync(join(source, "prompts")), "a wrong link is re-linked to the expected source");
  assert.ok(lstatSync(join(second, "prompts")).isSymbolicLink(), "repair restores a symlink");

  // Contamination still retires: a regular directory named "skills" (not a
  // link) is swept and re-linked — the sweep keeps its teeth.
  rmSync(join(second, "skills"));
  mkdirSync(join(second, "skills"));
  writeFileSync(join(second, "skills", "evil.txt"), "contamination\n");
  provisionPiAgentHome({ stateDir, role: "supervisor", sourceAgentDir: source });
  assert.ok(lstatSync(join(second, "skills")).isSymbolicLink(), "a non-link skills directory is replaced by the expected symlink");
  assert.equal(realpathSync(join(second, "skills")), realpathSync(join(source, "skills")));
  assert.equal(existsSync(join(second, "skills", "evil.txt")), false, "the swept directory's contents are gone");
});

test("syncMcpJson injects zai-vision from auth.json zai.key (overriding stale keys) and exa from web-search.json with exposure: direct", (t) => {
  const dir = makeTempDir("pi-home-test-");
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  const stateDir = join(dir, "factory-state");

  writeFileSync(
    join(source, "auth.json"),
    JSON.stringify({ zai: { type: "api_key", key: "zai-fresh-key-999" } }),
  );
  writeFileSync(
    join(dir, "pi-home", ".pi", "web-search.json"),
    JSON.stringify({ exaApiKey: "exa-key-123" }),
  );
  writeFileSync(
    join(source, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
        "zai-vision": {
          command: "npx",
          args: ["-y", "@z_ai/mcp-server"],
          env: { Z_AI_API_KEY: "stale-old-key", Z_AI_MODE: "ZAI" },
        },
      },
    }),
  );

  const agentHome = provisionPiAgentHome({ stateDir, role: "agent", sourceAgentDir: source });
  const mcp = JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers["zai-vision"], {
    command: "npx",
    args: ["-y", "@z_ai/mcp-server"],
    env: { Z_AI_API_KEY: "zai-fresh-key-999", Z_AI_MODE: "ZAI" },
    exposure: "direct",
    lifecycle: "lazy",
    timeout: 300,
  });
  assert.deepEqual(mcp.mcpServers.exa, {
    url: "https://mcp.exa.ai/mcp?exaApiKey=exa-key-123",
    exposure: "direct",
    lifecycle: "lazy",
  });
});

test("headless settings override operator high thinking without changing interactive defaults", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  writeFileSync(join(source, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
  const stateDir = join(dir, "state");
  for (const role of ["headless", "lead", "supervisor", "agent"] as const) {
    const home = provisionPiAgentHome({ stateDir, role, sourceAgentDir: source });
    assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).defaultThinkingLevel, role === "headless" ? "off" : "high");
  }
});

test("coordination homes isolate MCP servers and every role sets the bridge timeout", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const source = makeFakePiAgent(dir);
  writeFileSync(join(source, "auth.json"), JSON.stringify({ zai: { key: "test-key" } }));
  writeFileSync(join(source, "mcp.json"), JSON.stringify({ mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } } }));
  for (const role of ["supervisor", "lead", "agent"] as const) {
    const home = provisionPiAgentHome({ stateDir: join(dir, "state"), role, sourceAgentDir: source });
    const { mcpServers } = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
    assert.equal(mcpServers.paseo_factory.timeout, 600);
    if (role === "agent") {
      assert.equal(mcpServers["zai-vision"].timeout, 300);
      assert.ok(mcpServers.context7);
    } else {
      assert.deepEqual(Object.keys(mcpServers), ["paseo_factory"]);
    }
  }
});

test("Peer merges harness MCP aliases, honors disabled sources and starts helpers lazily", (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const userHome = join(dir, "user"), stateDir = join(dir, "state"), source = join(userHome, ".pi/agent");
  mkdirSync(source, { recursive: true }); mkdirSync(join(userHome, ".gemini/config"), { recursive: true });
  writeFileSync(join(source, "mcp.json"), JSON.stringify({ mcpServers: {
    "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp"] },
    "zai-vision": { command: "npx", args: ["-y", "@z_ai/mcp-server"], env: { Z_AI_API_KEY: "valid" } },
  } }));
  writeFileSync(join(userHome, ".gemini/config/mcp_config.json"), JSON.stringify({ mcpServers: {
    "chrome-devtools-mcp": { command: "npx", args: ["chrome-devtools-mcp"] },
    "zai-mcp-server": { command: "npx", args: ["@z_ai/mcp-server"], env: { Z_AI_API_KEY: "" } },
    StitchMCP: { serverUrl: "https://example.invalid/mcp", disabled: true },
  } }));
  const home = provisionPiAgentHome({ stateDir, role: "agent", sourceAgentDir: source, helperMcpSources: { userHome } });
  const servers = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ["chrome-devtools-mcp", "paseo_factory", "zai-vision"]);
  assert.equal(servers["zai-vision"].env.Z_AI_API_KEY, "valid");
  assert.equal(servers["zai-vision"].timeout, 300);
  assert.equal(servers["chrome-devtools-mcp"].lifecycle, "lazy");
  assert.equal(servers.paseo_factory.lifecycle, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).skills,
    ["!*", "+~/.agents/skills/*", "-~/.agents/skills/factory"]);
  for (const role of ["supervisor", "lead"] as const) {
    const seatHome = provisionPiAgentHome({ stateDir, role, sourceAgentDir: source, helperMcpSources: { userHome } });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(seatHome, "mcp.json"), "utf8")).mcpServers), ["paseo_factory"]);
  }
});

test("OAuth sync selects the newest harness token, refreshes it and authenticates every Peer provider", async (t) => {
  const { createServer } = await import("node:http");
  const { syncHelperMcps, helperOAuthPath, resolveRoleScopedMcpServers } = await import("../src/helper-mcp-sync.ts");
  const { statSync } = await import("node:fs");
  const dir = makeTempDir(); disposeDir(t, dir);
  let refreshBody = "";
  const server = createServer(async (req, res) => {
    for await (const chunk of req) refreshBody += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "refreshed-token", refresh_token: "rotated-refresh", expires_in: 3600 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`, url = `${origin}/mcp`;
  const userHome = join(dir, "user"), stateDir = join(dir, "state"), pi = join(userHome, ".pi/agent");
  mkdirSync(pi, { recursive: true }); mkdirSync(join(userHome, ".gemini/antigravity"), { recursive: true });
  writeFileSync(join(pi, "mcp.json"), JSON.stringify({ mcpServers: { supabase: { url } } }));
  const agPath = join(userHome, ".gemini/antigravity/mcp_oauth_tokens.json");
  writeFileSync(agPath, JSON.stringify({ [url]: { client_id: "client", token_url: `${origin}/token`, token: { access_token: "ag-token", refresh_token: "ag-refresh", expiry: new Date(Date.now() + 60000).toISOString() } } }));
  const piToken = helperOAuthPath(pi, "supabase"); mkdirSync(join(piToken, ".."), { recursive: true });
  writeFileSync(piToken, JSON.stringify({ serverUrl: url, tokens: { accessToken: "old-pi", expiresAt: 1 } }));
  const options = { stateDir, userHome };
  const result = await syncHelperMcps(options);
  assert.equal(result.servers[0].status, "connected");
  assert.match(refreshBody, /refresh_token=ag-refresh/);
  for (const path of [piToken, helperOAuthPath(join(stateDir, "pi-agent/agent"), "supabase")]) {
    const token = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(token.tokens.accessToken, "refreshed-token");
    assert.equal(token.tokens.refreshToken, "rotated-refresh");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(agPath, "utf8"))[url].token.access_token, "refreshed-token");
  const sourceConfig = JSON.parse(readFileSync(join(pi, "mcp.json"), "utf8"));
  sourceConfig.mcpServers.supabase.headers = { authorization: "Bearer stale" };
  writeFileSync(join(pi, "mcp.json"), JSON.stringify(sourceConfig));
  const config = resolveRoleScopedMcpServers({ ...options, role: "agent" }) as any;
  assert.deepEqual(config.supabase.headers, { Authorization: "Bearer refreshed-token" });
  assert.deepEqual(resolveRoleScopedMcpServers({ ...options, role: "lead" }), {});
  const newer = { serverUrl: url, tokens: { accessToken: "new-pi", expiresAt: Math.floor(Date.now() / 1000) + 7200 } };
  writeFileSync(piToken, JSON.stringify(newer));
  await syncHelperMcps(options);
  assert.equal(JSON.parse(readFileSync(agPath, "utf8"))[url].token.access_token, "new-pi");
});

test("Catalog prefers authenticated endpoints and detects expired OAuth despite a stale header", async (t) => {
  const { discoverHelperMcps } = await import("../src/helper-mcp-sync.ts");
  const dir = makeTempDir(); disposeDir(t, dir);
  const userHome = join(dir, "user"), stateDir = join(dir, "state");
  mkdirSync(join(userHome, ".gemini/config"), { recursive: true }); mkdirSync(join(userHome, ".gemini/antigravity"), { recursive: true });
  mkdirSync(join(userHome, ".pi/agent"), { recursive: true });
  writeFileSync(join(userHome, ".gemini/config/mcp_config.json"), JSON.stringify({ mcpServers: {
    docs: { serverUrl: "https://docs.invalid/authenticated" },
    duplicate: { serverUrl: "https://same.invalid/mcp" },
  } }));
  writeFileSync(join(userHome, ".pi/agent/mcp.json"), JSON.stringify({ mcpServers: {
    docs: { url: "https://docs.invalid/unauthenticated" },
    same: { url: "https://same.invalid/mcp/" },
    expired: { url: "https://expired.invalid/mcp", headers: { Authorization: "Bearer old" } },
    figma: { command: "npx", args: ["framelink-figma", "--figma-api-key", "--stdio"] },
  } }));
  writeFileSync(join(userHome, ".gemini/antigravity/mcp_oauth_tokens.json"), JSON.stringify({
    "https://docs.invalid/authenticated": { token: { access_token: "valid", expiry: new Date(Date.now() + 3600000).toISOString() } },
    "https://expired.invalid/mcp": { token: { access_token: "expired", expiry: "2020-01-01T00:00:00Z" } },
  }));
  const { servers } = discoverHelperMcps({ stateDir, userHome });
  assert.equal(servers.find(s => s.name === "docs")?.url, "https://docs.invalid/authenticated");
  assert.equal(servers.filter(s => s.url?.startsWith("https://same.invalid")).length, 1);
  assert.equal(servers.find(s => s.name === "expired")?.status, "auth_expired");
  assert.equal(servers.find(s => s.name === "figma")?.status, "missing_env");
});

test("OAuth sync retains registered client metadata and refuses to overwrite a damaged store", async (t) => {
  const { syncHelperMcps, helperOAuthPath } = await import("../src/helper-mcp-sync.ts");
  const dir = makeTempDir(); disposeDir(t, dir);
  const userHome = join(dir, "user"), stateDir = join(dir, "state"), pi = join(userHome, ".pi/agent");
  mkdirSync(pi, { recursive: true }); mkdirSync(join(userHome, ".gemini/antigravity"), { recursive: true });
  const url = "https://mcp.supabase.com/mcp";
  writeFileSync(join(pi, "mcp.json"), JSON.stringify({ mcpServers: { supabase: { url } } }));
  const ag = join(userHome, ".gemini/antigravity/mcp_oauth_tokens.json");
  writeFileSync(ag, JSON.stringify({ [url]: { token: { access_token: "newest", expiry: new Date(Date.now() + 7200000).toISOString() } } }));
  const tokenFile = helperOAuthPath(pi, "supabase"); mkdirSync(join(tokenFile, ".."), { recursive: true });
  writeFileSync(tokenFile, JSON.stringify({ serverUrl: url, clientInfo: { clientId: "registered-client", clientSecret: "registered-secret" }, tokens: { accessToken: "older", expiresAt: Math.floor(Date.now() / 1000) + 3600 } }));
  await syncHelperMcps({ stateDir, userHome });
  assert.equal(JSON.parse(readFileSync(tokenFile, "utf8")).clientInfo.clientId, "registered-client");
  assert.equal(JSON.parse(readFileSync(tokenFile, "utf8")).clientInfo.clientSecret, "registered-secret");
  writeFileSync(ag, '{"unrelated":');
  await assert.rejects(syncHelperMcps({ stateDir, userHome }));
  assert.equal(readFileSync(ag, "utf8"), '{"unrelated":');
});

test("Fresh host keys replace cached catalog credentials and prior OAuth without access is expired", async (t) => {
  const { syncHelperMcps, discoverHelperMcps, resolveRoleScopedMcpServers } = await import("../src/helper-mcp-sync.ts");
  const dir = makeTempDir(); disposeDir(t, dir);
  const userHome = join(dir, "user"), stateDir = join(dir, "state"), pi = join(userHome, ".pi/agent");
  mkdirSync(pi, { recursive: true }); mkdirSync(join(userHome, ".gemini/antigravity"), { recursive: true });
  const write = (key: string) => writeFileSync(join(pi, "mcp.json"), JSON.stringify({ mcpServers: { exa: { command: "npx", env: { EXA_API_KEY: key } }, notion: { url: "https://notion.invalid/mcp" } } }));
  write("old-key");
  writeFileSync(join(userHome, ".gemini/antigravity/mcp_oauth_tokens.json"), JSON.stringify({ "https://notion.invalid/mcp": { client_id: "client", token: {} } }));
  await syncHelperMcps({ stateDir, userHome });
  write("new-key");
  assert.equal((resolveRoleScopedMcpServers({ stateDir, userHome, role: "agent" }) as any).exa.env.EXA_API_KEY, "new-key");
  assert.equal(discoverHelperMcps({ stateDir, userHome }).servers.find(s => s.name === "notion")?.status, "auth_expired");
});

test("OAuth metadata never erases a working token or combines different client registrations", async (t) => {
  const { syncHelperMcps, helperOAuthPath } = await import("../src/helper-mcp-sync.ts");
  const { createServer } = await import("node:http");
  const dir = makeTempDir(); disposeDir(t, dir);
  const userHome = join(dir, "user"), stateDir = join(dir, "state"), pi = join(userHome, ".pi/agent");
  mkdirSync(pi, { recursive: true }); mkdirSync(join(userHome, ".gemini/antigravity"), { recursive: true });
  let refreshRequests = 0;
  const server = createServer((_req, res) => { refreshRequests++; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const ag = join(userHome, ".gemini/antigravity/mcp_oauth_tokens.json"), tokenFile = helperOAuthPath(pi, "helper");
  writeFileSync(join(pi, "mcp.json"), JSON.stringify({ mcpServers: { helper: { url } } }));
  mkdirSync(join(tokenFile, ".."), { recursive: true });
  writeFileSync(tokenFile, JSON.stringify({ serverUrl: url, tokens: { accessToken: "working-no-expiry" } }));
  writeFileSync(ag, JSON.stringify({ [url]: { token: {} } }));
  const first = await syncHelperMcps({ stateDir, userHome });
  assert.equal(first.servers[0].status, "connected");
  assert.equal(JSON.parse(readFileSync(tokenFile, "utf8")).tokens.accessToken, "working-no-expiry");
  // Separate state avoids retaining the non-expiring token in the aggregate.
  const otherState = join(dir, "other-state");
  writeFileSync(tokenFile, JSON.stringify({ serverUrl: url, clientInfo: { clientId: "client-B", clientSecret: "secret-B" }, tokenUrl: `http://127.0.0.1:${address.port}/token`, tokens: { accessToken: "old-B", refreshToken: "refresh-B", expiresAt: 1 } }));
  writeFileSync(ag, JSON.stringify({ [url]: { client_id: "client-A", token: { access_token: "newer-A", expiry: "2020-01-01T00:00:00Z" } } }));
  const result = await syncHelperMcps({ stateDir: otherState, userHome });
  assert.equal(result.servers[0].status, "auth_expired");
  assert.equal(refreshRequests, 0);
  const saved = JSON.parse(readFileSync(tokenFile, "utf8"));
  assert.equal(saved.clientInfo.clientId, "client-A");
  assert.equal(saved.clientInfo.clientSecret, undefined);
  assert.equal(saved.tokens.refreshToken, undefined);
});
