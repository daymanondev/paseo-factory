import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import {
  applySetupProposalSteps,
  executeFactorySetup,
  inspectFactoryForProject,
} from "../plugin/server/factory-setup-runner.ts";
import type { FactorySetupRunnerDeps } from "../plugin/server/factory-setup-runner.ts";
import { handleSpoolRequest } from "../plugin/server/spool.ts";
import { createFactoryRegistry } from "../plugin/server/projects.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import {
  classifySetupActionTier,
  computeSetupActionsHash,
  formatSetupActionLabel,
  readSetupAudit,
  readSetupProposal,
  recoverInterruptedSetupProposal,
  writeSetupProposal,
} from "../plugin/server/core/factory-setup.ts";
import type { SetupProposalRecord } from "../plugin/server/core/factory-setup.ts";
import { withProjectIngressLock } from "../plugin/server/core/project-ingress-lock.ts";
import { ensureProjectRegistered, resolveProject } from "../plugin/server/core/project.ts";
import { readProjectSettings } from "../plugin/server/core/project-settings.ts";
import { clearGhAuthCache, saveVaultConfig, sealVaultBuffer } from "../plugin/server/core/vault.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

function tarHeader(name: string, size: number, typeflag: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "latin1");
  header.write(typeflag, 156, 1, "latin1");
  header.write("ustar", 257, 5, "latin1");
  header.write("00", 263, 2, "latin1");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

function buildTarball(
  entries: Array<{ path: string; data: Buffer | string }>,
  topDir = "owner-vault-abc1234",
): Buffer {
  const parts: Buffer[] = [tarHeader(`${topDir}/`, 0, "5")];
  for (const entry of entries) {
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const dir = dirname(entry.path);
    if (dir !== "." && dir !== topDir) parts.push(tarHeader(`${dir}/`, 0, "5"));
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    parts.push(tarHeader(entry.path, data.length, "0"), data, padding);
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function makeRepo(t: TestContext, name: string, setupFiles?: (dir: string) => void): { root: string; slug: string } {
  const root = makeTempDir(`runner-repo-${name}-`);
  disposeDir(t, root);
  if (setupFiles) {
    setupFiles(root);
  } else {
    writeFileSync(join(root, "README.md"), `# ${name}\n`);
  }
  gitCommitAll(root, "init");
  const resolved = resolveProject(root);
  if (!resolved.ok) throw new Error(resolved.reason);
  return { root: resolved.root, slug: resolved.slug };
}

function seedOpenDesignProject(odDataDir: string, projectId: string, html: string, mtimeMs: number): void {
  const dir = join(odDataDir, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, "index.html");
  writeFileSync(indexPath, html);
  const dt = new Date(mtimeMs);
  utimesSync(indexPath, dt, dt);
}

function withOpenDesignDataDir<T>(t: TestContext, odDataDir: string): void {
  const prior = process.env.OPEN_DESIGN_DATA_DIR;
  process.env.OPEN_DESIGN_DATA_DIR = odDataDir;
  t.after(() => {
    if (prior === undefined) delete process.env.OPEN_DESIGN_DATA_DIR;
    else process.env.OPEN_DESIGN_DATA_DIR = prior;
  });
}

test("Tier 0 inspectFactoryForProject is secret-free and respects context-budget caps", async (t) => {
  clearGhAuthCache();
  t.after(() => clearGhAuthCache());

  const rootDir = makeTempDir("runner-inspect-");
  disposeDir(t, rootDir);
  const home = join(rootDir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const userHome = join(rootDir, "user-home");
  const odDataDir = join(rootDir, "open-design-data");
  withOpenDesignDataDir(t, odDataDir);

  const project = makeRepo(t, "mobile-inspect", (dir) => {
    mkdirSync(join(dir, "ios"), { recursive: true });
    writeFileSync(join(dir, "ios", "Podfile"), "platform :ios, '15.0'\n");
    mkdirSync(join(dir, ".store-release"), { recursive: true });
    writeFileSync(join(dir, ".store-release", "manifest.json"), JSON.stringify({ appKey: "myapp" }));
  });
  execFileSync("git", ["remote", "add", "origin", "https://x-access-token:SECRET_ORIGIN_TOKEN@github.com/org/app.git"], {
    cwd: project.root,
  });

  // Seed Vault secrets & passphrase that MUST NEVER appear in snapshot
  const vaultSecretPassphrase = "SUPER_SECRET_VAULT_PASSPHRASE_999";
  const ascPemSecret = "-----BEGIN PRIVATE KEY-----\nSECRET_ASC_KEY_BODY_999\n-----END PRIVATE KEY-----";
  saveVaultConfig(home, { repo: "org/private-vault-secret-name", passphrase: vaultSecretPassphrase });
  mkdirSync(join(home, "vault-runtime", "secrets", "shared"), { recursive: true });
  writeFileSync(join(home, "vault-runtime", "secrets", "shared", "asc-api-key.p8"), ascPemSecret);
  writeFileSync(
    join(home, "vault-runtime", "secrets", "shared", "asc-credentials.json"),
    JSON.stringify({ keyId: "KID1", issuerId: "ISS1", teamId: "SECRET_TEAM_ID_999" }),
  );
  writeFileSync(
    join(home, "vault-runtime", "env.json"),
    JSON.stringify({ ASC_KEY_PATH: join(home, "vault-runtime", "secrets", "shared", "asc-api-key.p8"), APPLE_TEAM_ID: "SECRET_TEAM_ID_999" }),
  );

  // Seed Helper MCPs with stdio env secret & http URL secret that MUST NEVER appear in snapshot
  const stdioEnvSecret = "SECRET_HELPER_ENV_TOKEN_999";
  const httpUrlSecret = "SECRET_HTTP_API_KEY_999";
  const httpHeaderSecret = "Bearer SECRET_HEADER_TOKEN_999";
  mkdirSync(join(userHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(userHome, ".pi", "agent", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "secret-stdio": {
          command: "/usr/local/bin/my-secret-cmd",
          args: ["--secret-arg=SECRET_ARG_999"],
          env: { API_TOKEN: stdioEnvSecret },
        },
        "secret-http": {
          url: `https://mcp.example.com/sse?ApiKey=${httpUrlSecret}`,
          headers: { Authorization: httpHeaderSecret },
        },
      },
    }),
  );

  // Seed custom skill in ~/.agents/skills so skill pack inspection has installed skills that MUST NOT leak as installedSkills array
  mkdirSync(join(userHome, ".agents", "skills", "tdd"), { recursive: true });
  writeFileSync(join(userHome, ".agents", "skills", "tdd", "SKILL.md"), "# tdd\n");

  // Seed 25 Open Design projects with HTML secret marker; expect <= 20 newest without files[] or HTML
  const baseTime = Date.UTC(2026, 10, 1, 0, 0, 0);
  for (let i = 1; i <= 25; i += 1) {
    const id = `od-proj-${String(i).padStart(2, "0")}`;
    seedOpenDesignProject(
      odDataDir,
      id,
      `<html><body><div data-screen="s1">SECRET_HTML_CONTENT_${i}</div></body></html>`,
      baseTime + i * 1000,
    );
  }

  const deps: FactorySetupRunnerDeps = {
    stateDir,
    home,
    userHome,
    listPlugins: async () => ({
      ok: true,
      plugins: [
        {
          id: "factory-release-lab",
          enabled: true,
          status: "running",
          path: join(home, "plugins", "factory-release-lab"),
        } as never,
      ],
    }),
    vaultRunner: async (call) => {
      if (call.command === "gh" && call.args[0] === "auth") {
        return Buffer.from(JSON.stringify({ hosts: { "github.com": [{ login: "builder", active: true, state: "success" }] } }));
      }
      return Buffer.from("");
    },
  };

  const snapshot = await inspectFactoryForProject(deps, project);
  const serialized = JSON.stringify(snapshot);

  // Secret-free assertions
  for (const secret of [
    "SECRET_ORIGIN_TOKEN",
    vaultSecretPassphrase,
    "org/private-vault-secret-name",
    "SECRET_ASC_KEY_BODY_999",
    "SECRET_TEAM_ID_999",
    stdioEnvSecret,
    httpUrlSecret,
    httpHeaderSecret,
    "SECRET_ARG_999",
    "/usr/local/bin/my-secret-cmd",
    "SECRET_HTML_CONTENT",
  ]) {
    assert.equal(serialized.includes(secret), false, `snapshot must not leak "${secret}"`);
  }
  assert.equal("installedSkills" in snapshot.companions["factory-skills-pack"], false);
  assert.equal("installedSkills" in snapshot.skillPacks, false);

  // Readiness assertions
  assert.equal(snapshot.isMobile, true);
  assert.deepEqual(snapshot.detectedPlatforms, ["ios"]);
  assert.equal(snapshot.hasOrigin, true);
  assert.equal(snapshot.hasStoreManifest, true);
  assert.deepEqual(snapshot.vault, {
    configured: true,
    ascKey: true,
    appleTeamId: true,
    gplayJson: false,
  });
  assert.deepEqual(snapshot.ghAuth, { installed: true, authenticated: true, user: "builder" });
  assert.equal(snapshot.openDesign.availableProjects.length, 20, "availableProjects capped at 20");
  assert.equal(snapshot.openDesign.availableProjects[0]?.projectId, "od-proj-25", "newest project first");
  assert.equal(snapshot.openDesign.availableProjects[19]?.projectId, "od-proj-06");
  for (const item of snapshot.openDesign.availableProjects) {
    assert.deepEqual(Object.keys(item).sort(), ["projectId", "projectName", "screenCount"]);
  }
  assert.ok(snapshot.helperMcps.some((h) => h.name === "secret-stdio"));
  assert.ok(snapshot.helperMcps.some((h) => h.name === "secret-http"));
  for (const helper of snapshot.helperMcps) {
    assert.deepEqual(Object.keys(helper).sort(), ["enabled", "machineWide", "name", "status"]);
    assert.equal(helper.machineWide, true);
  }
});

test("Tier 1 vault_hydrate uses strictly runtimeOnly + projectDir and never touches machine configs or sibling checkouts", async (t) => {
  const rootDir = makeTempDir("runner-tier1-vault-");
  disposeDir(t, rootDir);
  const home = join(rootDir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const userHome = join(rootDir, "user-home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  const targetProj = makeRepo(t, "target-app", (dir) => {
    mkdirSync(join(dir, ".store-release"), { recursive: true });
    writeFileSync(join(dir, ".store-release", "manifest.json"), JSON.stringify({ bundleId: "com.example.target" }));
  });
  const siblingProj = makeRepo(t, "sibling-app", (dir) => {
    mkdirSync(join(dir, ".store-release"), { recursive: true });
    writeFileSync(join(dir, ".store-release", "manifest.json"), JSON.stringify({ bundleId: "com.example.sibling" }));
  });
  ensureProjectRegistered(stateDir, targetProj.root);
  ensureProjectRegistered(stateDir, siblingProj.root);

  // Seed existing machine-wide configs that MUST NOT be mutated by Tier 1 vault_hydrate
  const localLanes = JSON.stringify({ supervisor: "local-sup", lead: "local-lead", worker: "local-worker" });
  const localProfiles = JSON.stringify({ profiles: { local: { name: "Local" } } });
  const localHelpers = JSON.stringify({ overrides: { exa: false } });
  writeFileSync(join(stateDir, "lanes.json"), localLanes);
  writeFileSync(join(stateDir, "profiles.json"), localProfiles);
  writeFileSync(join(stateDir, "helper-mcps.json"), localHelpers);

  saveVaultConfig(home, { repo: "owner/vault" });
  const manifest = {
    targetApp: { bundleId: "com.example.target" },
    siblingApp: { bundleId: "com.example.sibling" },
  };
  const tarball = buildTarball([
    { path: "owner-vault-abc1234/vault.manifest.json", data: JSON.stringify(manifest) },
    { path: "owner-vault-abc1234/config/lanes.json", data: JSON.stringify({ supervisor: "vault-sup" }) },
    { path: "owner-vault-abc1234/config/profiles.json", data: JSON.stringify({ profiles: { remote: { name: "Remote" } } }) },
    { path: "owner-vault-abc1234/config/helper-mcps.json", data: JSON.stringify({ overrides: { exa: true } }) },
    { path: "owner-vault-abc1234/secrets/shared/asc-api-key.p8", data: JSON.stringify(sealVaultBuffer(Buffer.from("asc-key"))) },
    { path: "owner-vault-abc1234/secrets/apps/targetApp/.env.local", data: "TARGET_ENV=1\n" },
    { path: "owner-vault-abc1234/secrets/apps/siblingApp/.env.local", data: "SIBLING_ENV=1\n" },
  ]);

  let lockHeldDuringHydrate = false;
  const events: string[] = [];
  const res = await executeFactorySetup(
    {
      stateDir,
      home,
      userHome,
      vaultRunner: async (call) => {
        if (call.command === "gh" && call.args[0] === "api") {
          // Verify withProjectIngressLock is NOT held during slow network vault_hydrate
          const probe = Promise.race([
            withProjectIngressLock(stateDir, targetProj.slug, async () => "acquired"),
            new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
          ]);
          lockHeldDuringHydrate = (await probe) === "blocked";
          return tarball;
        }
        throw new Error(`unexpected command: ${call.command}`);
      },
      onStateChange: (ev) => events.push(ev.handler),
    },
    targetProj,
    { actions: [{ kind: "vault_hydrate" }], reason: "Hydrate runtime vault for target project" },
  );

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.applied, true);
  assert.equal(res.tier, 1);
  assert.equal(lockHeldDuringHydrate, false, "withProjectIngressLock must NOT be held across vault_hydrate");

  // Runtime & target checkout hydrated
  assert.equal(existsSync(join(home, "vault-runtime", "env.json")), true);
  assert.equal(existsSync(join(home, "vault-runtime", "secrets", "shared", "asc-api-key.p8")), true);
  assert.equal(readFileSync(join(targetProj.root, ".env.local"), "utf8"), "TARGET_ENV=1\n");

  // Sibling checkout & machine configs untouched
  assert.equal(existsSync(join(siblingProj.root, ".env.local")), false, "sibling checkout must remain untouched");
  assert.equal(readFileSync(join(stateDir, "lanes.json"), "utf8"), localLanes);
  assert.equal(readFileSync(join(stateDir, "profiles.json"), "utf8"), localProfiles);
  assert.equal(readFileSync(join(stateDir, "helper-mcps.json"), "utf8"), localHelpers);

  // Audit & stateHub
  const audit = readSetupAudit(stateDir, targetProj.slug);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.tier, 1);
  assert.equal(audit[0]?.actor, "supervisor");
  assert.deepEqual(events, ["factory.setup"]);
});

function makeFakeCompanionToolRunner() {
  const tmpRoot = resolve(tmpdir());
  return (cmd: string, args: string[]) => {
    if (cmd !== "git") {
      throw new Error(`Unexpected companion tool command in test: ${cmd} ${args.join(" ")}`);
    }
    if (args[0] === "rev-parse") {
      return { status: 0, stdout: "abcdef1234567\n", stderr: "" };
    }
    if (args[0] === "ls-remote") {
      return { status: 0, stdout: "abcdef1234567\tHEAD\n", stderr: "" };
    }
    if (args[0] === "clone") {
      const tmpDest = args[args.length - 1];
      assert.ok(
        typeof tmpDest === "string" &&
          tmpDest.length > 0 &&
          tmpDest !== "HEAD" &&
          isAbsolute(tmpDest) &&
          resolve(tmpDest).startsWith(tmpRoot + sep),
        `clone destination must be an absolute path inside tmpdir (${tmpRoot}), got: ${String(tmpDest)}`,
      );
      for (const skillPath of [
        "skills/engineering/tdd",
        "skills/engineering/diagnosing-bugs",
        "skills/engineering/codebase-design",
        "skills/engineering/code-review",
        "skills/engineering/domain-modeling",
        "skills/engineering/grill-with-docs",
        "skills/productivity/grilling",
        "skills/engineering/research",
        "skills/frontend-design",
        "skills/web-design-guidelines",
      ]) {
        mkdirSync(join(tmpDest, skillPath), { recursive: true });
        writeFileSync(join(tmpDest, skillPath, "SKILL.md"), `# ${skillPath}\n`);
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected git subcommand in makeFakeCompanionToolRunner: ${args.join(" ")}`);
  };
}

test("makeFakeCompanionToolRunner handles ls-remote cleanly without writing HEAD/ and rejects unexpected subcommands", () => {
  const runner = makeFakeCompanionToolRunner();
  const lsRes = runner("git", ["ls-remote", "https://example.com/repo.git", "HEAD"]);
  assert.equal(lsRes.status, 0);
  assert.equal(existsSync(resolve("HEAD")), false, "ls-remote must never create HEAD/ in repo root");
  assert.throws(() => runner("git", ["clone", "--depth", "1", "https://example.com/repo.git", "HEAD"]), /clone destination must be an absolute path inside tmpdir/);
  assert.throws(() => runner("git", ["push", "origin", "main"]), /Unexpected git subcommand/);
});

test("Tier 1 executes factory-skills-pack additively, set_skill_pack, and sync_open_design cleanly and fails fast on conflicts", async (t) => {
  const rootDir = makeTempDir("runner-tier1-combo-");
  disposeDir(t, rootDir);
  const home = join(rootDir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const userHome = join(rootDir, "user-home");
  const odDataDir = join(rootDir, "open-design-data");
  withOpenDesignDataDir(t, odDataDir);

  const project = makeRepo(t, "web-app");
  ensureProjectRegistered(stateDir, project.root);

  // Seed a custom user skill that MUST NOT be overwritten
  const customSkillPath = join(userHome, ".agents", "skills", "my-custom-skill", "SKILL.md");
  mkdirSync(dirname(customSkillPath), { recursive: true });
  writeFileSync(customSkillPath, "# my custom skill — keep intact\n");

  // Seed one Open Design project
  seedOpenDesignProject(odDataDir, "od-clean", "<html><body><div data-screen=\"home\">Home</div></body></html>", Date.now());

  const deps: FactorySetupRunnerDeps = {
    stateDir,
    home,
    userHome,
    companionToolRunner: makeFakeCompanionToolRunner(),
  };

  const res = await executeFactorySetup(deps, project, {
    actions: [
      { kind: "sync_open_design", projectId: "od-clean" },
      { kind: "set_skill_pack", pack: "expo", enabled: true },
      { kind: "install_companion", id: "factory-skills-pack" },
    ],
    reason: "Install core skills, enable expo pack, and sync Open Design",
  });
  assert.equal(res.ok, true);
  if (!res.ok || !res.applied) return;
  assert.deepEqual(
    res.steps.map((s) => s.action.kind),
    ["install_companion", "set_skill_pack", "sync_open_design"],
    "canonical execution order applied",
  );
  assert.ok(res.steps.every((s) => s.status === "done"));
  assert.equal(readFileSync(customSkillPath, "utf8"), "# my custom skill — keep intact\n", "custom user skill preserved");
  assert.deepEqual(readProjectSettings(stateDir, project.slug).skillPacks, ["expo"]);
  assert.equal(existsSync(join(project.root, "design", "index.html")), true);

  // Dirty design/ index fails fast BEFORE overwriting design/
  writeFileSync(join(project.root, "design", "index.html"), "<html>dirty</html>");
  const dirtyRes = await executeFactorySetup(deps, project, {
    actions: [{ kind: "sync_open_design", projectId: "od-clean" }],
    reason: "Attempt sync over dirty design/",
  });
  assert.equal(dirtyRes.ok, false);
  if (dirtyRes.ok) return;
  assert.equal(dirtyRes.code, "open-design-dirty-index");
  execFileSync("git", ["checkout", "--", "design/index.html"], { cwd: project.root });

  // Active writable Peer in flight fails fast BEFORE touching design/
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const registry = createFactoryRegistry({ stateDir, root: factory });
  const projFactory = registry.factoryForProject(project.slug);
  projFactory.setContract({
    task: "T-01",
    workspace: project.root,
    gate: "true",
    disposition: "engineer",
    description: "1. Bounded Outcome\nx\n2. Contract Boundary & Regression Invariants\ny\n3. Excluded / Deferred\nnone\n4. Verification\ntrue",
  });
  projFactory.requestSpawn({ task: "T-01", provider: "pi/test/model", arity: 1 });
  const peerConflictDeps: FactorySetupRunnerDeps = {
    ...deps,
    factory,
    registry,
    daemon: {
      agents: {
        list: async () => ({
          entries: [
            {
              agent: {
                id: "peer-1",
                provider: "pi/test/model",
                title: null,
                status: "running",
                model: null,
                labels: { seat: "agent", project: project.slug, task: "T-01" },
                archivedAt: null,
                requiresAttention: false,
                attentionReason: null,
                updatedAt: new Date().toISOString(),
                cwd: project.root,
              },
            },
          ],
          pageInfo: {},
        }),
        create: async () => ({ id: "x" }),
        ref: () => ({
          send: async () => {},
          archive: async () => ({ archivedAt: new Date().toISOString() }),
          timeline: { refetch: async () => ({ entries: [] }) },
        }),
      },
      providers: {
        listAvailable: async () => ({ providers: [] }),
        listModels: async () => ({ models: [] }),
      },
    },
  };
  const peerRes = await executeFactorySetup(peerConflictDeps, project, {
    actions: [{ kind: "sync_open_design", projectId: "od-clean" }],
    reason: "Attempt sync with writable peer in flight",
  });
  assert.equal(peerRes.ok, false);
  if (peerRes.ok) return;
  assert.equal(peerRes.code, "writable-peer-in-flight");
});

test("Tier 2 preflight refuses store-release-not-mobile, helper-mcp-unknown, open-design-project-unavailable, and gh-auth-required without persisting proposal", async (t) => {
  clearGhAuthCache();
  t.after(() => clearGhAuthCache());

  const rootDir = makeTempDir("runner-tier2-preflight-");
  disposeDir(t, rootDir);
  const home = join(rootDir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const userHome = join(rootDir, "user-home");
  const odDataDir = join(rootDir, "open-design-data");
  withOpenDesignDataDir(t, odDataDir);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  const nonMobile = makeRepo(t, "web-only");
  const mobile = makeRepo(t, "mobile-app", (dir) => {
    mkdirSync(join(dir, "android", "app"), { recursive: true });
    writeFileSync(join(dir, "android", "app", "build.gradle"), "android {}\n");
  });

  const baseDeps: FactorySetupRunnerDeps = {
    stateDir,
    home,
    userHome,
    listPlugins: async () => ({ ok: true, plugins: [] }),
    vaultRunner: async (call) => {
      if (call.command === "gh" && call.args[0] === "auth") {
        throw new Error("You are not logged into any GitHub hosts. To log in, run: gh auth login");
      }
      return Buffer.from("");
    },
  };

  // 1. Non-mobile Project rejects set_store_release_mode !== off
  const notMobileRes = await executeFactorySetup(baseDeps, nonMobile, {
    actions: [{ kind: "set_store_release_mode", mode: "on-request" }],
    reason: "Enable store release on web app",
  });
  assert.equal(notMobileRes.ok, false);
  if (!notMobileRes.ok) assert.equal(notMobileRes.code, "store-release-not-mobile");
  assert.equal(readSetupProposal(stateDir, nonMobile.slug), undefined);

  // 2. Unknown Helper MCP
  const unknownMcpRes = await executeFactorySetup(baseDeps, mobile, {
    actions: [{ kind: "set_helper_mcp", name: "nonexistent-mcp", enabled: true }],
    reason: "Enable missing MCP",
  });
  assert.equal(unknownMcpRes.ok, false);
  if (!unknownMcpRes.ok) assert.equal(unknownMcpRes.code, "helper-mcp-unknown");
  assert.equal(readSetupProposal(stateDir, mobile.slug), undefined);

  // 3. Unavailable Open Design project
  const missingOdRes = await executeFactorySetup(baseDeps, mobile, {
    actions: [{ kind: "sync_open_design", projectId: "missing-od-id" }, { kind: "set_release_mode", mode: "on-request" }],
    reason: "Sync missing Open Design",
  });
  assert.equal(missingOdRes.ok, false);
  if (!missingOdRes.ok) assert.equal(missingOdRes.code, "open-design-project-unavailable");
  assert.equal(readSetupProposal(stateDir, mobile.slug), undefined);

  // 4. Unauthenticated gh refuses installing uninstalled private factory-release-lab without persisting proposal
  const ghDeniedRes = await executeFactorySetup(baseDeps, mobile, {
    actions: [
      { kind: "install_companion", id: "factory-release-lab" },
      { kind: "set_store_release_mode", mode: "on-request" },
    ],
    reason: "Enable mobile store staging",
  });
  assert.equal(ghDeniedRes.ok, false);
  if (!ghDeniedRes.ok) assert.equal(ghDeniedRes.code, "gh-auth-required");
  assert.equal(readSetupProposal(stateDir, mobile.slug), undefined, "gh-auth-required must NOT persist setup-proposal.json");
});

test("Tier 2 persists Setup Proposal with missing Vault key warning, enforces setup-proposal-busy, and supports Spool without holding outer ingress lock", async (t) => {
  clearGhAuthCache();
  t.after(() => clearGhAuthCache());

  const rootDir = makeTempDir("runner-tier2-persist-");
  disposeDir(t, rootDir);
  const home = join(rootDir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const userHome = join(rootDir, "user-home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  const mobile = makeRepo(t, "mobile-ios-android", (dir) => {
    mkdirSync(join(dir, "ios"), { recursive: true });
    writeFileSync(join(dir, "ios", "Podfile"), "platform :ios, '15.0'\n");
    mkdirSync(join(dir, "android", "app"), { recursive: true });
    writeFileSync(join(dir, "android", "app", "build.gradle"), "android {}\n");
  });
  ensureProjectRegistered(stateDir, mobile.root);

  const activeProposalRuns = new Map<string, string>();
  const events: string[] = [];
  const deps: FactorySetupRunnerDeps = {
    stateDir,
    home,
    userHome,
    activeProposalRuns,
    onStateChange: (ev) => events.push(ev.handler),
    listPlugins: async () => ({ ok: true, plugins: [] }),
    vaultRunner: async (call) => {
      if (call.command === "gh" && call.args[0] === "auth") {
        return Buffer.from(JSON.stringify({ hosts: { "github.com": [{ login: "octocat", active: true, state: "success" }] } }));
      }
      return Buffer.from("");
    },
  };

  // Seed interrupted applying proposal -> should recover cleanly before accepting new proposal
  const oldActions = [{ kind: "set_release_mode" as const, mode: "on-request" as const }];
  writeSetupProposal(stateDir, mobile.slug, {
    schemaVersion: 1,
    id: "crashed-prop",
    actionsHash: computeSetupActionsHash(oldActions),
    projectSlug: mobile.slug,
    status: "applying",
    reason: "Interrupted run",
    actions: oldActions,
    steps: [{ index: 0, action: oldActions[0]!, tier: 2, status: "pending" }],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
  });

  const created = await executeFactorySetup(deps, mobile, {
    actions: [
      { kind: "set_store_release_mode", mode: "on-request" },
      { kind: "install_companion", id: "factory-release-lab" },
    ],
    reason: "Prepare iOS and Android staging",
  });
  assert.equal(created.ok, true);
  if (!created.ok || created.applied) return;
  assert.equal(created.proposalPending, true);
  assert.equal(created.tier, 2);
  assert.equal(created.warnings.length, 1);
  assert.match(created.warnings[0]!, /Settings -> Private Vault/);
  assert.match(created.warnings[0]!, /ASC_KEY_PATH/);
  assert.match(created.warnings[0]!, /APPLE_TEAM_ID/);
  assert.match(created.warnings[0]!, /GPLAY_KEY_PATH/);
  assert.deepEqual(events, ["factory.setup_proposal.created"]);

  const persisted = readSetupProposal(stateDir, mobile.slug);
  assert.ok(persisted);
  assert.equal(persisted.id, created.proposalId);
  assert.equal(persisted.actionsHash, created.actionsHash);
  assert.equal(persisted.status, "pending");
  assert.deepEqual(
    persisted.actions.map((a) => a.kind),
    ["install_companion", "set_store_release_mode"],
  );

  // While an active proposal is applying, refuse new proposal with setup-proposal-busy
  writeSetupProposal(stateDir, mobile.slug, { ...persisted, status: "applying" });
  activeProposalRuns.set(mobile.slug, persisted.id);
  const busyRes = await executeFactorySetup(deps, mobile, {
    actions: [{ kind: "set_release_mode", mode: "auto" }],
    reason: "Try overwriting active apply",
  });
  assert.equal(busyRes.ok, false);
  if (!busyRes.ok) assert.equal(busyRes.code, "setup-proposal-busy");

  // Also test Spool lock exclusion: factory_setup must NOT hold withProjectIngressLock while executing
  const factory = createFactory({ stateDir, eyeCliProbe: () => false });
  const registry = createFactoryRegistry({ stateDir, root: factory });
  let outerLockBlocked = false;
  const spoolRes = await handleSpoolRequest(
    factory,
    {
      id: "spool-setup-lock-check",
      kind: "factory_setup",
      actions: [{ kind: "install_companion", id: "factory-skills-pack" }],
      reason: "Check outer ingress lock exclusion",
      workspace: mobile.root,
      seat: "supervisor",
    },
    {
      home,
      userHome,
      companionToolRunner: makeFakeCompanionToolRunner(),
    },
    registry,
  );
  assert.equal(spoolRes.ok, true);
  // Confirm lock was never wedged
  await withProjectIngressLock(stateDir, mobile.slug, async () => {
    outerLockBlocked = false;
  });
  assert.equal(outerLockBlocked, false);
  // Check recoverInterruptedSetupProposal leaves active apply untouched when activeProposalRuns holds it
  assert.equal(recoverInterruptedSetupProposal(stateDir, mobile.slug, activeProposalRuns)?.status, "applying");
});

test("applySetupProposalSteps fails fast with scrubbed diagnostics, resumes from first non-done step, and enforces timeouts", async (t) => {
  const rootDir = makeTempDir("runner-apply-steps-");
  disposeDir(t, rootDir);
  const home = join(rootDir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const userHome = join(rootDir, "user-home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  const project = makeRepo(t, "resume-app", (dir) => {
    mkdirSync(join(dir, "ios"), { recursive: true });
    writeFileSync(join(dir, "ios", "Podfile"), "platform :ios, '15.0'\n");
  });

  const actions = [
    { kind: "install_companion" as const, id: "factory-release-lab" as const },
    { kind: "set_release_mode" as const, mode: "on-request" as const },
    { kind: "set_store_release_mode" as const, mode: "on-request" as const },
  ];
  const record: SetupProposalRecord = {
    schemaVersion: 1,
    id: "prop-resume",
    actionsHash: computeSetupActionsHash(actions),
    projectSlug: project.slug,
    status: "applying",
    reason: "Test fail-fast and retry",
    actions,
    steps: actions.map((action, index) => ({
      index,
      action,
      tier: classifySetupActionTier(action),
      status: "pending",
    })),
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
  };

  let companionCalls = 0;
  let releaseModeCalls = 0;
  let storeModeCalls = 0;

  // Attempt 1: step 0 succeeds, step 1 fails with secret in error -> step 2 skipped
  const failResult = await applySetupProposalSteps(
    { stateDir, home, userHome },
    project,
    record,
    {
      installCompanion: async () => {
        companionCalls += 1;
        return "Installed factory-release-lab";
      },
      applyReleaseMode: async () => {
        releaseModeCalls += 1;
        throw new Error("boom TOKEN=super_secret_abc123 https://user:pass123@example.com/repo");
      },
      applyStoreReleaseMode: async () => {
        storeModeCalls += 1;
        return "Set store release mode";
      },
    },
  );
  assert.equal(failResult.ok, false);
  if (failResult.ok) return;
  assert.equal(failResult.failedIndex, 1);
  assert.equal(failResult.steps[0]?.status, "done");
  assert.equal(failResult.steps[1]?.status, "failed");
  assert.equal(failResult.steps[2]?.status, "skipped");
  assert.equal(failResult.error.includes("super_secret_abc123"), false, "secret scrubbed from diagnostic");
  assert.equal(failResult.error.includes("pass123"), false, "URL credentials scrubbed from diagnostic");
  assert.equal(companionCalls, 1);
  assert.equal(releaseModeCalls, 1);
  assert.equal(storeModeCalls, 0);

  // Attempt 2 (Retry): resumes from step 1, skips already-done step 0
  const retryResult = await applySetupProposalSteps(
    { stateDir, home, userHome },
    project,
    { steps: failResult.steps },
    {
      installCompanion: async () => {
        companionCalls += 1;
        throw new Error("step 0 should not re-run");
      },
      applyReleaseMode: async () => {
        releaseModeCalls += 1;
        return "Set Release mode";
      },
      applyStoreReleaseMode: async () => {
        storeModeCalls += 1;
        return "Set Store release mode";
      },
    },
  );
  assert.equal(retryResult.ok, true);
  assert.equal(companionCalls, 1, "already-done step 0 skipped on retry");
  assert.equal(releaseModeCalls, 2);
  assert.equal(storeModeCalls, 1);
  assert.ok(retryResult.steps.every((s) => s.status === "done"));

  // Timeout enforcement for vault_hydrate and install_companion
  const vaultTimeout = await applySetupProposalSteps(
    { stateDir, home, userHome, vaultHydrateTimeoutMs: 25 },
    project,
    { steps: [{ index: 0, action: { kind: "vault_hydrate" }, tier: 1, status: "pending" }] },
    { hydrateVault: () => new Promise(() => {}) },
  );
  assert.equal(vaultTimeout.ok, false);
  if (!vaultTimeout.ok) assert.equal(vaultTimeout.code, "vault-hydrate-timeout");

  const companionTimeout = await applySetupProposalSteps(
    { stateDir, home, userHome, companionInstallTimeoutMs: 25 },
    project,
    { steps: [{ index: 0, action: { kind: "install_companion", id: "factory-release-lab" }, tier: 2, status: "pending" }] },
    { installCompanion: () => new Promise(() => {}) },
  );
  assert.equal(companionTimeout.ok, false);
  if (!companionTimeout.ok) assert.equal(companionTimeout.code, "companion-install-timeout");
});

test("formatSetupActionLabel produces deterministic human labels for every FactorySetupAction kind", async () => {
  const { formatSetupActionLabel: fromIndex } = await import("../src/index.ts");
  assert.equal(typeof fromIndex, "function");
  assert.equal(
    fromIndex({ kind: "install_companion", id: "factory-release-lab" }),
    formatSetupActionLabel({ kind: "install_companion", id: "factory-release-lab" }),
  );
  assert.equal(
    formatSetupActionLabel({ kind: "install_companion", id: "factory-release-lab" }),
    "Install Release Lab (factory-release-lab)",
  );
  assert.equal(
    formatSetupActionLabel({ kind: "install_companion", id: "factory-skills-pack" }),
    "Install Core Skill Pack (factory-skills-pack)",
  );
  assert.equal(
    formatSetupActionLabel({ kind: "set_release_mode", mode: "on-request", branch: "release/v1" }),
    "Set Release mode -> on-request (branch release/v1)",
  );
  assert.equal(
    formatSetupActionLabel({ kind: "set_release_mode", mode: "auto" }),
    "Set Release mode -> auto",
  );
  assert.equal(
    formatSetupActionLabel({ kind: "set_store_release_mode", mode: "auto-staging" }),
    "Set Store release mode -> auto-staging",
  );
  assert.equal(
    formatSetupActionLabel({ kind: "set_skill_pack", pack: "expo", enabled: true }),
    'Enable skill pack "expo"',
  );
  assert.equal(
    formatSetupActionLabel({ kind: "set_skill_pack", pack: "expo", enabled: false }),
    'Disable skill pack "expo"',
  );
  assert.equal(
    formatSetupActionLabel({ kind: "set_helper_mcp", name: "github", enabled: true }),
    'Enable Helper MCP "github"',
  );
  assert.equal(
    formatSetupActionLabel({ kind: "set_helper_mcp", name: "github", enabled: false }),
    'Disable Helper MCP "github"',
  );
  assert.equal(
    formatSetupActionLabel({ kind: "sync_open_design", projectId: "design-123" }),
    "Sync Open Design (design-123)",
  );
  assert.equal(
    formatSetupActionLabel({ kind: "vault_hydrate" }),
    "Hydrate Private Vault (project-scoped)",
  );
});
