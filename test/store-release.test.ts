import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createFactoryRegistry } from "../plugin/server/projects.ts";
import { ensureProjectRegistered } from "../plugin/server/core/project.ts";
import {
  readStoreReleaseRequest,
  setProjectReleaseSettings,
  setProjectStoreReleaseSettings,
  setStoreReleaseRequest,
} from "../plugin/server/core/project-settings.ts";
import { saveVaultConfig } from "../plugin/server/core/vault-config.ts";
import { releaseProject } from "../plugin/server/release.ts";
import { handleSpoolRequest } from "../plugin/server/spool.ts";
import {
  builtinStoreReleaseRunner,
  DEFAULT_RUNNER_GRACE_MS,
  DEFAULT_RUNNER_TIMEOUT_MS,
  hasActiveStoreReleases,
  recordStoreNote,
  storeReleaseProject,
} from "../plugin/server/store-release.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

function makeMobileRepo(dir: string, platforms: ("android" | "ios")[] = ["android", "ios"]): string {
  const repoDir = join(dir, "mobile-app");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# Mobile App\n");
  if (platforms.includes("android")) {
    mkdirSync(join(repoDir, "android", "app"), { recursive: true });
    writeFileSync(join(repoDir, "android", "app", "build.gradle"), "android {}\n");
  }
  if (platforms.includes("ios")) {
    mkdirSync(join(repoDir, "ios", "Demo.xcodeproj"), { recursive: true });
    writeFileSync(join(repoDir, "ios", "Podfile"), "platform :ios, '15.0'\n");
  }
  gitCommitAll(repoDir);
  return realpathSync(repoDir);
}

function installFakeRunnerPlugin(paseoHome: string): string {
  const pluginRoot = join(paseoHome, "plugins", "factory-release-lab", "ver-001");
  mkdirSync(join(pluginRoot, "bin"), { recursive: true });
  mkdirSync(join(pluginRoot, "plugin"), { recursive: true });
  const binPath = join(pluginRoot, "bin", "release-lab.mjs");
  writeFileSync(binPath, "#!/usr/bin/env node\n");
  return binPath;
}

function writeVaultStoreEnv(paseoHome: string, env: Record<string, string>): void {
  const runtimeDir = join(paseoHome, "vault-runtime");
  const sharedDir = join(runtimeDir, "secrets", "shared");
  mkdirSync(sharedDir, { recursive: true });
  if (env.ASC_KEY_PATH) {
    writeFileSync(join(sharedDir, "asc-api-key.p8"), "SYNTH_P8\n");
  }
  if (env.ASC_KEY_ID || env.ASC_ISSUER || env.APPLE_TEAM_ID) {
    writeFileSync(
      join(sharedDir, "asc-credentials.json"),
      JSON.stringify({
        ...(env.ASC_KEY_ID ? { keyId: env.ASC_KEY_ID } : {}),
        ...(env.ASC_ISSUER ? { issuerId: env.ASC_ISSUER } : {}),
        ...(env.APPLE_TEAM_ID ? { teamId: env.APPLE_TEAM_ID } : {}),
      }),
    );
  }
  if (env.GPLAY_KEY_PATH) {
    writeFileSync(join(sharedDir, "gplay-service-account.json"), JSON.stringify({ type: "service_account" }));
  }
  writeFileSync(join(runtimeDir, "env.json"), JSON.stringify(env, null, 2));
}

test("storeReleaseProject checks preconditions in strict order before spawning runner", async (t) => {
  const dir = makeTempDir("store-release-pre-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android", "ios"]);
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  let runnerCalls = 0;
  const fakeRunner = async () => {
    runnerCalls += 1;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  // 1a. Mode off -> store-release-not-granted (even before runner/vault/repo checks)
  const offRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "probe",
    runner: fakeRunner,
    listPlugins: async () => ({ ok: true, plugins: [] }),
  });
  assert.equal(offRes.ok, false);
  if (!offRes.ok) assert.equal(offRes.code, "store-release-not-granted");
  assert.equal(runnerCalls, 0);

  // 1b. Mode on-request without pending request -> no-store-release-intent
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "on-request" });
  const noIntentRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    runner: fakeRunner,
    listPlugins: async () => ({ ok: true, plugins: [] }),
  });
  assert.equal(noIntentRes.ok, false);
  if (!noIntentRes.ok) assert.equal(noIntentRes.code, "no-store-release-intent");

  // 1c. Mode on-request with staging intent + action submit -> production-approval-required
  setStoreReleaseRequest(stateDir, project.slug, { target: "staging" });
  const prodDenied = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "submit",
    runner: fakeRunner,
    listPlugins: async () => ({ ok: true, plugins: [] }),
  });
  assert.equal(prodDenied.ok, false);
  if (!prodDenied.ok) assert.equal(prodDenied.code, "production-approval-required");

  // Mode auto-staging + action submit without production intent -> production-approval-required
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "auto-staging" });
  const autoProdDenied = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "submit",
    runner: fakeRunner,
    listPlugins: async () => ({ ok: true, plugins: [] }),
  });
  assert.equal(autoProdDenied.ok, false);
  if (!autoProdDenied.ok) assert.equal(autoProdDenied.code, "production-approval-required");

  // 2a. Runner missing -> runner-not-installed
  const noRunnerRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    runner: fakeRunner,
    listPlugins: async () => ({ ok: true, plugins: [] }),
  });
  assert.equal(noRunnerRes.ok, false);
  if (!noRunnerRes.ok) assert.equal(noRunnerRes.code, "runner-not-installed");

  // 2b. Runner installed, Vault credentials missing -> vault-credentials-missing naming variable names only (never values)
  const binPath = installFakeRunnerPlugin(paseoHome);
  const pluginDir = join(paseoHome, "plugins", "factory-release-lab", "ver-001", "plugin");
  const listPlugins = async () => ({
    ok: true as const,
    plugins: [{ id: "factory-release-lab", path: pluginDir, enabled: true, status: "running" as const }],
  });
  const secretTeam = "SUPER_SECRET_TEAM_VALUE";
  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/secret-asc.p8",
    ASC_KEY_ID: "KEY123",
    ASC_ISSUER: "ISSUER456",
    // Missing APPLE_TEAM_ID and GPLAY_KEY_PATH
  });
  const missingCredsRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    runner: fakeRunner,
    listPlugins,
  });
  assert.equal(missingCredsRes.ok, false);
  if (!missingCredsRes.ok) {
    assert.equal(missingCredsRes.code, "vault-credentials-missing");
    assert.match(missingCredsRes.message, /APPLE_TEAM_ID/);
    assert.match(missingCredsRes.message, /GPLAY_KEY_PATH/);
    assert.equal(missingCredsRes.message.includes("/tmp/secret-asc.p8"), false, "never leak existing path");
    assert.equal(missingCredsRes.message.includes("KEY123"), false, "never leak existing value");
  }

  // Provide all credentials including secretTeam sentinel and verify it never leaks in subsequent error messages
  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/secret-asc.p8",
    ASC_KEY_ID: "KEY123",
    ASC_ISSUER: "ISSUER456",
    APPLE_TEAM_ID: secretTeam,
    GPLAY_KEY_PATH: "/tmp/secret-gplay.json",
  });

  // 3a. Repo dirty -> root-dirty for stage, relaxed for probe
  writeFileSync(join(repoDir, "dirty.txt"), "untracked\n");
  const dirtyStage = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    runner: fakeRunner,
    listPlugins,
  });
  assert.equal(dirtyStage.ok, false);
  if (!dirtyStage.ok) assert.equal(dirtyStage.code, "root-dirty");

  // Probe ignores dirty tree and runs!
  const dirtyProbe = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "probe",
    runner: async (call) => {
      runnerCalls += 1;
      assert.equal(call.binPath, binPath);
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, platforms: ["android", "ios"] }), stderr: "" };
    },
    listPlugins,
  });
  assert.equal(dirtyProbe.ok, true);
  assert.equal(runnerCalls, 1);

  // Clean up dirty file
  execFileSync("git", ["clean", "-fd"], { cwd: repoDir });

  // 3b. No accepted landing -> head-not-accepted
  const unacceptedStage = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    runner: fakeRunner,
    listPlugins,
  });
  assert.equal(unacceptedStage.ok, false);
  if (!unacceptedStage.ok) assert.equal(unacceptedStage.code, "head-not-accepted");

  // 3c. Running gate -> gate-running
  factory.setContract({ task: "T-1", workspace: repoDir, gate: "true", artifact: "README.md" });
  factory.ledger.append({ event: "claim_reported", task: "T-1", attempt: 1, sha: headSha });
  factory.ledger.append({ event: "gate_started", task: "T-1", attempt: 1, cmd: "true" });
  const gateRunningStage = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    runner: fakeRunner,
    listPlugins,
  });
  assert.equal(gateRunningStage.ok, false);
  if (!gateRunningStage.ok) assert.equal(gateRunningStage.code, "gate-running");

  // Finish gate & accept T-1
  factory.ledger.append({ event: "gate_finished", task: "T-1", attempt: 1, exit: 0, verdict: "green", note: "ok", sha: headSha });
  factory.ledger.append({ event: "report_written", task: "T-1", attempt: 1, path: "report-T-1-1.md" });
  await factory.accept({ task: "T-1", attempt: 1, accepted_by: "lead" });

  // 3d. Detached HEAD -> root-detached
  execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: repoDir, stdio: "pipe" });
  const detachedStage = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    runner: fakeRunner,
    listPlugins,
  });
  assert.equal(detachedStage.ok, false);
  if (!detachedStage.ok) assert.equal(detachedStage.code, "root-detached");
  assert.equal(runnerCalls, 1, "no runner spawn happened during any refused stage call");
});

function acceptCommitOnRepo(factory: ReturnType<typeof createFactory>, repoDir: string, task: string): string {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  factory.setContract({ task, workspace: repoDir, gate: "true", artifact: "README.md" });
  factory.ledger.append({ event: "claim_reported", task, attempt: 1, sha });
  factory.ledger.append({ event: "gate_started", task, attempt: 1, cmd: "true" });
  factory.ledger.append({ event: "gate_finished", task, attempt: 1, exit: 0, verdict: "green", note: "ok", sha });
  factory.ledger.append({ event: "report_written", task, attempt: 1, path: `report-${task}-1.md` });
  return sha;
}

test("storeReleaseProject resolves newest versioned release-lab plugin, injects PASEO_HOME & Finder PATH, and runs probe without consuming on-request", async (t) => {
  const dir = makeTempDir("store-release-probe-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  // Install v1 (older) and v2 (newer) under <paseoHome>/plugins/factory-release-lab/
  const v1Plugin = join(paseoHome, "plugins", "factory-release-lab", "uuid-v1", "plugin");
  const v2Root = join(paseoHome, "plugins", "factory-release-lab", "uuid-v2");
  const v2Plugin = join(v2Root, "plugin");
  mkdirSync(join(paseoHome, "plugins", "factory-release-lab", "uuid-v1", "bin"), { recursive: true });
  mkdirSync(v1Plugin, { recursive: true });
  mkdirSync(join(v2Root, "bin"), { recursive: true });
  mkdirSync(v2Plugin, { recursive: true });
  const v1Bin = join(paseoHome, "plugins", "factory-release-lab", "uuid-v1", "bin", "release-lab.mjs");
  const v2Bin = join(v2Root, "bin", "release-lab.mjs");
  writeFileSync(v1Bin, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ version: 1 }));\n");
  // Real executable script for v2 to test builtinStoreReleaseRunner end-to-end too
  writeFileSync(
    v2Bin,
    `#!/usr/bin/env node
console.log(JSON.stringify({
  ok: true,
  version: 2,
  paseoHome: process.env.PASEO_HOME,
  hasHomebrewPath: (process.env.PATH || "").includes("/opt/homebrew/bin"),
  argv: process.argv.slice(2),
}));
`,
  );
  chmodSync(v2Bin, 0o755);
  const tOld = new Date(Date.now() - 10_000);
  const tNew = new Date(Date.now());
  utimesSync(join(paseoHome, "plugins", "factory-release-lab", "uuid-v1"), tOld, tOld);
  utimesSync(v1Bin, tOld, tOld);
  utimesSync(v2Root, tNew, tNew);
  utimesSync(v2Bin, tNew, tNew);

  writeVaultStoreEnv(paseoHome, { GPLAY_KEY_PATH: "/tmp/synth-gplay.json" });
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "on-request" });
  setStoreReleaseRequest(stateDir, project.slug, { target: "staging", platforms: ["android"] });

  const probeRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "probe",
    listPlugins: async () => ({
      ok: true,
      plugins: [{ id: "factory-release-lab", path: v1Plugin, enabled: true, status: "running" }],
    }),
  });

  assert.equal(probeRes.ok, true, JSON.stringify(probeRes));
  if (probeRes.ok && probeRes.action === "probe") {
    assert.equal(probeRes.runner.binPath, v2Bin);
    assert.deepEqual(probeRes.detectedPlatforms, ["android"]);
    assert.deepEqual(probeRes.vault, { ascKey: false, appleTeamId: false, gplayJson: true });
    const p = probeRes.probe as Record<string, unknown>;
    assert.equal(p.version, 2);
    assert.equal(p.paseoHome, paseoHome);
    assert.equal(p.hasHomebrewPath, true);
    assert.deepEqual(p.argv, ["probe", "--project", repoDir]);
  }
  assert.ok(readStoreReleaseRequest(stateDir, project.slug) !== undefined, "probe must NOT consume on-request pending request");
});

test("storeReleaseProject runs stage/submit/resume asynchronously, records Ledger events, writes back Day-0 keystore, wakes Lead, and classifies failures", async (t) => {
  const dir = makeTempDir("store-release-async-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android", "ios"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-STORE");
  await factory.accept({ task: "T-STORE", attempt: 1, accepted_by: "lead" });

  installFakeRunnerPlugin(paseoHome);
  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/synth-asc.p8",
    ASC_KEY_ID: "SYNTHKEY",
    ASC_ISSUER: "00000000-0000-0000-0000-000000000001",
    APPLE_TEAM_ID: "SYNTHTEAM",
    GPLAY_KEY_PATH: "/tmp/synth-gplay.json",
  });

  // Configure bare remote Vault for Day-0 keystore write-back
  const bareVault = join(dir, "vault.git");
  execFileSync("git", ["init", "--bare", bareVault], { stdio: "pipe" });
  const seedClone = join(dir, "seed-vault");
  execFileSync("git", ["clone", bareVault, seedClone], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "checkout", "-b", "main"], { stdio: "pipe" });
  writeFileSync(join(seedClone, "README.md"), "# Vault\n");
  execFileSync("git", ["-C", seedClone, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "-c", "user.name=Test", "-c", "user.email=t@test.invalid", "commit", "-m", "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "push", "-u", "origin", "main"], { stdio: "pipe" });
  saveVaultConfig(paseoHome, { repo: bareVault, branch: "main", nodeId: "test-node" });

  const createdKeystorePath = join(paseoHome, "release-lab", "keystores", project.slug, "release.keystore");
  mkdirSync(join(paseoHome, "release-lab", "keystores", project.slug), { recursive: true });
  writeFileSync(createdKeystorePath, "FAKE_KEYSTORE_BYTES");
  writeFileSync(
    join(paseoHome, "release-lab", "keystores", project.slug, "keystore.properties"),
    "storePassword=synthpass\nkeyPassword=synthpass\nkeyAlias=upload\n",
  );

  const notifications: Array<{ slug: string; text: string }> = [];
  const listPlugins = async () => ({ ok: false as const, reason: "daemon offline" });

  // 1. auto-staging eligibility + completed + Day-0 keystore write-back
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "auto-staging" });
  const calls: string[][] = [];
  const stageRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async (call) => {
      calls.push([...call.args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          id: "run-stage-1",
          playbook: "stage-release",
          projectSlug: project.slug,
          projectRoot: repoDir,
          platforms: ["android", "ios"],
          status: "completed",
          phases: [
            {
              id: "phase-2-day0-and-signing",
              state: "green",
              output: {
                mode: "day0",
                keystoreCreated: true,
                keystore: { path: createdKeystorePath, alias: "upload", sha1: "AA", sha256: "BB", created: true },
              },
            },
          ],
        }),
        stderr: "",
      };
    },
  });
  assert.equal(stageRes.ok, true);
  if (stageRes.ok && "settled" in stageRes) {
    assert.equal(stageRes.started, true);
    await stageRes.settled;
  }
  assert.deepEqual(calls[0], ["run", "--playbook", "stage-release", "--project", repoDir, "--slug", project.slug]);
  assert.ok(factory.ledger.events.some((e) => e.event === "store_release_started" && e.action === "stage"));
  assert.ok(factory.ledger.events.some((e) => e.event === "store_release_completed" && e.runId === "run-stage-1"));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.text, /Store release completed/);
  assert.ok(existsSync(join(paseoHome, "vault-runtime", "secrets", "apps", "mobile-app", "release.keystore")), notifications[0]!.text);

  // 2. Hole pause + resume refusal without production approval + resume with production approval (on-request consumed)
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "on-request" });
  setStoreReleaseRequest(stateDir, project.slug, { target: "staging" });
  const pausedRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "run-hole-1",
        playbook: "stage-release",
        status: "paused-hole",
        phases: [{ id: "phase-7-final-gate", state: "paused-hole", hole: "final-release-approval" }],
        pausedAtHole: {
          phase: "phase-7-final-gate",
          kind: "final-release-approval",
          payload: { version: "1.0.0" },
          resolutionSpec: { kind: "final-release-approval", type: "object" },
        },
      }),
      stderr: "",
    }),
  });
  assert.equal(pausedRes.ok, true, JSON.stringify(pausedRes));
  if (pausedRes.ok && "settled" in pausedRes) await pausedRes.settled;
  assert.ok(factory.ledger.events.some((e) => e.event === "store_release_paused" && e.runId === "run-hole-1" && e.holeKind === "final-release-approval"));
  assert.match(notifications[1]!.text, /paused at Hole.*final-release-approval/);

  // Persist run record on disk so resume sees holeKind = final-release-approval
  mkdirSync(join(paseoHome, "release-lab", "runs"), { recursive: true });
  writeFileSync(
    join(paseoHome, "release-lab", "runs", "run-hole-1.json"),
    JSON.stringify({
      id: "run-hole-1",
      playbook: "stage-release",
      projectSlug: project.slug,
      projectRoot: repoDir,
      platforms: ["android", "ios"],
      status: "paused-hole",
      phases: [{ id: "phase-7-final-gate", state: "paused-hole", hole: { kind: "final-release-approval", pausedAt: 1000 } }],
    }),
  );

  const deniedResume = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "resume",
    runId: "run-hole-1",
    resolution: { approved: true },
    listPlugins,
  });
  assert.equal(deniedResume.ok, false);
  if (!deniedResume.ok) assert.equal(deniedResume.code, "production-approval-required");

  // Grant production approval via StoreReleaseRequest and resume
  setStoreReleaseRequest(stateDir, project.slug, {
    target: "production",
    resumeRunId: "run-hole-1",
    resolution: { approved: true },
  });
  const okResume = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "resume",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async (call) => {
      calls.push([...call.args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ id: "run-hole-1", status: "completed", platforms: ["android", "ios"], phases: [] }),
        stderr: "",
      };
    },
  });
  assert.equal(okResume.ok, true);
  if (okResume.ok && "settled" in okResume) await okResume.settled;
  assert.deepEqual(calls[1], ["resume", "--run", "run-hole-1", "--resolution", JSON.stringify({ approved: true })]);
  assert.equal(readStoreReleaseRequest(stateDir, project.slug), undefined, "completed resume in on-request mode consumes pending request");

  // 3. Failure classifications: app-repo keeps request for retry; tool-bug records upstreamIssuePath and halts
  setStoreReleaseRequest(stateDir, project.slug, { target: "staging" });
  const appRepoFail = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "run-fail-app",
        status: "failed",
        error: "Gradle compile failed",
        failure: {
          failureClass: "app-repo",
          platform: "android",
          phase: "phase-4-build",
          code: "gradle-compile-error",
          message: "Missing dependency in build.gradle",
          logTail: "FAILURE: Build failed with an exception.",
        },
        phases: [],
      }),
      stderr: "",
    }),
  });
  assert.equal(appRepoFail.ok, true);
  if (appRepoFail.ok && "settled" in appRepoFail) await appRepoFail.settled;
  assert.ok(readStoreReleaseRequest(stateDir, project.slug) !== undefined, "app-repo failure preserves on-request for bounded repair retry");
  assert.ok(factory.ledger.events.some((e) => e.event === "store_release_failed" && e.failureClass === "app-repo" && e.code === "gradle-compile-error"));
  assert.match(notifications[3]!.text, /failureClass=app-repo/);
  assert.match(notifications[3]!.text, /max 2 repair attempts/);

  const toolBugFail = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: JSON.stringify({
        ok: false,
        error: "ASC schema changed",
        failure: {
          failureClass: "tool-bug",
          platform: "ios",
          phase: "phase-5-upload",
          code: "asc-schema-drift",
          message: "Unexpected ASC API response",
          upstreamIssuePath: "/tmp/upstream-issues/01-asc-schema.md",
        },
      }),
    }),
  });
  assert.equal(toolBugFail.ok, true);
  if (toolBugFail.ok && "settled" in toolBugFail) await toolBugFail.settled;
  assert.ok(factory.ledger.events.some((e) => e.event === "store_release_failed" && e.failureClass === "tool-bug" && e.upstreamIssuePath === "/tmp/upstream-issues/01-asc-schema.md"));
  assert.match(notifications[4]!.text, /failureClass=tool-bug/);
  assert.match(notifications[4]!.text, /Upstream issue: \/tmp\/upstream-issues\/01-asc-schema\.md/);
  assert.match(notifications[4]!.text, /halt immediately/i);

  // 4. submit maps to submit-production --project <dir> --slug <slug> [--run <id>] --approve
  setStoreReleaseRequest(stateDir, project.slug, { target: "production" });
  const submitRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "submit",
    runId: "run-stage-1",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async (call) => {
      calls.push([...call.args]);
      return { exitCode: 0, stdout: JSON.stringify({ id: "run-stage-1", status: "completed", platforms: ["android", "ios"], phases: [] }), stderr: "" };
    },
  });
  assert.equal(submitRes.ok, true);
  if (submitRes.ok && "settled" in submitRes) await submitRes.settled;
  assert.deepEqual(calls[2], ["submit-production", "--project", repoDir, "--slug", project.slug, "--run", "run-stage-1", "--approve"]);
});

test("recordStoreNote enforces <= 120-line lessons.md cap, writes 0o400 to vault-runtime/store-memory, syncs to bare Vault, and leaves project-root clean", async (t) => {
  const dir = makeTempDir("store-note-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const repoDir = makeMobileRepo(dir, ["android"]);

  const bareVault = join(dir, "vault.git");
  execFileSync("git", ["init", "--bare", bareVault], { stdio: "pipe" });
  const seedClone = join(dir, "seed-vault");
  execFileSync("git", ["clone", bareVault, seedClone], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "checkout", "-b", "main"], { stdio: "pipe" });
  writeFileSync(join(seedClone, "README.md"), "# Vault\n");
  execFileSync("git", ["-C", seedClone, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "-c", "user.name=Test", "-c", "user.email=t@test.invalid", "commit", "-m", "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "push", "-u", "origin", "main"], { stdio: "pipe" });
  saveVaultConfig(paseoHome, { repo: bareVault, branch: "main", nodeId: "test-node" });

  // Over-limit lessons.md (>120 lines) is refused cleanly
  const over121 = Array.from({ length: 121 }, (_, i) => `line ${i + 1}`).join("\n");
  const refused = await recordStoreNote({
    paseoHome,
    target: "lessons",
    content: over121,
    projectRoot: repoDir,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "store-notebook-limit-exceeded");

  // Valid lessons.md writes 0o400 and syncs to Vault
  const lessonsContent = "# Store Lessons\n\n| ID | Platform | Cause | Prevention |\n| --- | --- | --- | --- |\n| L-1 | ios | Missing privacy manifest | Add PrivacyInfo.xcprivacy |\n";
  const lessonsOk = await recordStoreNote({
    paseoHome,
    target: "lessons",
    content: lessonsContent,
    projectRoot: repoDir,
  });
  assert.equal(lessonsOk.ok, true);
  if (lessonsOk.ok) {
    assert.equal(lessonsOk.synced, true);
    assert.equal(lessonsOk.pushed, true);
    assert.equal(readFileSync(lessonsOk.path, "utf8"), lessonsContent);
    assert.equal(statSync(lessonsOk.path).mode & 0o222, 0);
  }

  // Per-app card writes 0o400 and syncs to Vault without dirtying repoDir
  const appContent = "# Synth App\n\n- Rejected 1.0.1 for demo login missing\n";
  const appOk = await recordStoreNote({
    paseoHome,
    target: "app",
    appKey: "synth-app",
    content: appContent,
    projectRoot: repoDir,
  });
  assert.equal(appOk.ok, true);
  if (appOk.ok) {
    assert.equal(appOk.synced, true);
    assert.equal(appOk.pushed, true);
    assert.equal(readFileSync(appOk.path, "utf8"), appContent);
    assert.equal(statSync(appOk.path).mode & 0o222, 0);
  }

  // Verify repoDir has zero untracked/modified files
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }).trim(), "");
});

test("releaseProject and Spool release reply signal storeReleaseAutoStaging when Store release mode is auto-staging on a mobile project", async (t) => {
  const dir = makeTempDir("store-auto-staging-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");

  const mobileRepo = makeMobileRepo(dir, ["android"]);
  const nonMobileRepo = join(dir, "plain-lib");
  mkdirSync(nonMobileRepo, { recursive: true });
  writeFileSync(join(nonMobileRepo, "README.md"), "# Plain\n");
  gitCommitAll(nonMobileRepo);

  const setupRepo = async (repoRoot: string, bareName: string, version: string) => {
    const bare = join(dir, bareName);
    execFileSync("git", ["branch", "-M", "main"], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, stdio: "pipe" });
    const proj = ensureProjectRegistered(stateDir, repoRoot);
    assert.ok(proj.ok);
    const factory = createFactory({ stateDir: join(stateDir, "projects", proj.slug) });
    t.after(() => factory.history.stop());
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    factory.setContract({ task: "T-1", workspace: repoRoot, gate: "true", artifact: "README.md" });
    factory.ledger.append({ event: "claim_reported", task: "T-1", attempt: 1, sha });
    factory.ledger.append({ event: "gate_started", task: "T-1", attempt: 1, cmd: "true" });
    factory.ledger.append({ event: "gate_finished", task: "T-1", attempt: 1, exit: 0, verdict: "green", note: "ok", sha });
    factory.ledger.append({ event: "report_written", task: "T-1", attempt: 1, path: "report-T-1-1.md" });
    await factory.accept({ task: "T-1", attempt: 1, accepted_by: "lead" });
    setProjectReleaseSettings(stateDir, proj.slug, { mode: "auto", branch: "main" });
    const fakeVaultRunner = async (call: { command: string; args: readonly string[]; cwd?: string }) => {
      if (call.command === "gh" && call.args[0] === "release" && call.args[1] === "view") {
        throw new Error("release not found");
      }
      if (call.command === "gh" && call.args[0] === "release" && call.args[1] === "create") {
        return Buffer.from(`https://github.com/owner/app/releases/tag/v${version}\n`);
      }
      return execFileSync(call.command, [...call.args], { cwd: call.cwd, stdio: ["ignore", "pipe", "pipe"] });
    };
    return { slug: proj.slug, factory, fakeVaultRunner };
  };

  const mob = await setupRepo(mobileRepo, "mob-origin.git", "1.0.0");
  setProjectStoreReleaseSettings(stateDir, mob.slug, { mode: "auto-staging" });

  const mobRes = await releaseProject({
    factory: mob.factory,
    stateDir,
    projectSlug: mob.slug,
    projectRoot: mobileRepo,
    version: "1.0.0",
    runner: mob.fakeVaultRunner,
  });
  assert.equal(mobRes.ok, true);
  if (mobRes.ok) {
    assert.equal(mobRes.storeReleaseAutoStaging, true);
  }

  // Spool reply also carries the auto-staging follow-up hint after a new landed wave
  writeFileSync(join(mobileRepo, "feature.txt"), "v1.0.1\n");
  const nextSha = gitCommitAll(mobileRepo, "feat: v1.0.1");
  mob.factory.setContract({ task: "T-2", workspace: mobileRepo, gate: "true", artifact: "README.md" });
  mob.factory.ledger.append({ event: "claim_reported", task: "T-2", attempt: 1, sha: nextSha });
  mob.factory.ledger.append({ event: "gate_started", task: "T-2", attempt: 1, cmd: "true" });
  mob.factory.ledger.append({ event: "gate_finished", task: "T-2", attempt: 1, exit: 0, verdict: "green", note: "ok", sha: nextSha });
  mob.factory.ledger.append({ event: "report_written", task: "T-2", attempt: 1, path: "report-T-2-1.md" });
  await mob.factory.accept({ task: "T-2", attempt: 1, accepted_by: "lead" });
  const registry = createFactoryRegistry({ stateDir });
  t.after(() => registry.stop());
  const spoolMob = await handleSpoolRequest(
    registry.root,
    { id: "rel-mob-2", kind: "release", version: "1.0.1", workspace: mobileRepo, projectSlug: mob.slug, seat: "lead" },
    { home: paseoHome, vaultRunner: mob.fakeVaultRunner },
    registry,
  );
  assert.equal(spoolMob.ok, true);
  if (spoolMob.ok) {
    assert.equal((spoolMob as { storeReleaseAutoStaging?: boolean }).storeReleaseAutoStaging, true);
    assert.match(spoolMob.summary ?? "", /auto-staging.*lead_store_release/i);
  }

  // Non-mobile project even with auto-staging stays clean (no storeReleaseAutoStaging)
  const plain = await setupRepo(nonMobileRepo, "plain-origin.git", "1.0.0");
  setProjectStoreReleaseSettings(stateDir, plain.slug, { mode: "auto-staging" });
  const plainRes = await releaseProject({
    factory: plain.factory,
    stateDir,
    projectSlug: plain.slug,
    projectRoot: nonMobileRepo,
    version: "1.0.0",
    runner: plain.fakeVaultRunner,
  });
  assert.equal(plainRes.ok, true);
  if (plainRes.ok) {
    assert.equal(plainRes.storeReleaseAutoStaging, undefined);
  }
});

test("C1: on-request target=production preserves pending request across stage until submit completes", async (t) => {
  const dir = makeTempDir("store-release-c1-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android", "ios"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-C1");
  await factory.accept({ task: "T-C1", attempt: 1, accepted_by: "lead" });
  installFakeRunnerPlugin(paseoHome);
  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/synth-asc.p8",
    ASC_KEY_ID: "SYNTHKEY",
    ASC_ISSUER: "00000000-0000-0000-0000-000000000001",
    APPLE_TEAM_ID: "SYNTHTEAM",
    GPLAY_KEY_PATH: "/tmp/synth-gplay.json",
  });

  const listPlugins = async () => ({ ok: false as const, reason: "offline" });
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "on-request" });
  setStoreReleaseRequest(stateDir, project.slug, { target: "production" });

  // Stage completes but MUST keep pending target=production request for follow-up submit
  const stageRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ id: "run-prod-stage", status: "completed", platforms: ["android", "ios"], phases: [] }),
      stderr: "",
    }),
  });
  assert.equal(stageRes.ok, true);
  if (stageRes.ok && "settled" in stageRes) await stageRes.settled;
  assert.equal(
    readStoreReleaseRequest(stateDir, project.slug)?.target,
    "production",
    "stage completion in on-request mode must preserve target=production for follow-up submit",
  );

  // Follow-up submit passes on-request + production gates and clears request on completion
  const submitRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "submit",
    runId: "run-prod-stage",
    listPlugins,
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ id: "run-prod-stage", status: "completed", platforms: ["android", "ios"], phases: [] }),
      stderr: "",
    }),
  });
  assert.equal(submitRes.ok, true, JSON.stringify(submitRes));
  if (submitRes.ok && "settled" in submitRes) await submitRes.settled;
  assert.equal(readStoreReleaseRequest(stateDir, project.slug), undefined, "submit completion consumes pending production request");

  // Staging request still clears on stage completion
  setStoreReleaseRequest(stateDir, project.slug, { target: "staging" });
  const stagingRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ id: "run-staging-only", status: "completed", platforms: ["android"], phases: [] }),
      stderr: "",
    }),
  });
  assert.equal(stagingRes.ok, true);
  if (stagingRes.ok && "settled" in stagingRes) await stagingRes.settled;
  assert.equal(readStoreReleaseRequest(stateDir, project.slug), undefined, "stage completion consumes staging request");
});

test("C2: day0-store-init paused-hole extracts keystore from pausedAtHole.payload and writes it back to Vault", async (t) => {
  const dir = makeTempDir("store-release-c2-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-C2");
  await factory.accept({ task: "T-C2", attempt: 1, accepted_by: "lead" });
  installFakeRunnerPlugin(paseoHome);
  writeVaultStoreEnv(paseoHome, { GPLAY_KEY_PATH: "/tmp/synth-gplay.json" });

  const bareVault = join(dir, "vault.git");
  execFileSync("git", ["init", "--bare", bareVault], { stdio: "pipe" });
  const seedClone = join(dir, "seed-vault");
  execFileSync("git", ["clone", bareVault, seedClone], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "checkout", "-b", "main"], { stdio: "pipe" });
  writeFileSync(join(seedClone, "README.md"), "# Vault\n");
  execFileSync("git", ["-C", seedClone, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "-c", "user.name=Test", "-c", "user.email=t@test.invalid", "commit", "-m", "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", seedClone, "push", "-u", "origin", "main"], { stdio: "pipe" });
  saveVaultConfig(paseoHome, { repo: bareVault, branch: "main", nodeId: "test-node" });

  const createdKeystorePath = join(paseoHome, "release-lab", "keystores", project.slug, "release.keystore");
  mkdirSync(join(paseoHome, "release-lab", "keystores", project.slug), { recursive: true });
  writeFileSync(createdKeystorePath, "DAY0_PAUSED_KEYSTORE_BYTES");
  writeFileSync(
    join(paseoHome, "release-lab", "keystores", project.slug, "keystore.properties"),
    "storePassword=synthpass\nkeyPassword=synthpass\nkeyAlias=upload\n",
  );

  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "auto-staging" });
  const notifications: Array<{ slug: string; text: string }> = [];
  const res = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins: async () => ({ ok: false, reason: "offline" }),
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "run-day0-hole",
        playbook: "stage-release",
        status: "paused-hole",
        phases: [{ id: "phase-2-day0-and-signing", state: "paused-hole", hole: "day0-store-init" }],
        pausedAtHole: {
          phase: "phase-2-day0-and-signing",
          kind: "day0-store-init",
          payload: {
            keystoreCreated: true,
            keystore: { path: createdKeystorePath, alias: "upload", created: true },
          },
        },
      }),
      stderr: "",
    }),
  });
  assert.equal(res.ok, true);
  if (res.ok && "settled" in res) await res.settled;
  assert.ok(existsSync(join(paseoHome, "vault-runtime", "secrets", "apps", "mobile-app", "release.keystore")));
  assert.match(notifications[0]?.text ?? "", /Vault write-back:/);
});

test("A1: buildCliArgs forwards explicit --platforms filter for probe, stage, and submit", async (t) => {
  const dir = makeTempDir("store-release-a1-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android", "ios"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-A1");
  await factory.accept({ task: "T-A1", attempt: 1, accepted_by: "lead" });
  installFakeRunnerPlugin(paseoHome);
  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/synth-asc.p8",
    ASC_KEY_ID: "SYNTHKEY",
    ASC_ISSUER: "00000000-0000-0000-0000-000000000001",
    APPLE_TEAM_ID: "SYNTHTEAM",
    GPLAY_KEY_PATH: "/tmp/synth-gplay.json",
  });
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "on-request" });
  setStoreReleaseRequest(stateDir, project.slug, { target: "production", platforms: ["android", "ios"] });

  const recordedArgs: string[][] = [];
  const listPlugins = async () => ({ ok: false as const, reason: "offline" });
  const runner = async (call: { args: readonly string[] }) => {
    recordedArgs.push([...call.args]);
    return { exitCode: 0, stdout: JSON.stringify({ id: "run-a1", status: "completed", platforms: ["android"], phases: [] }), stderr: "" };
  };

  await storeReleaseProject({ factory, stateDir, paseoHome, projectSlug: project.slug, projectRoot: repoDir, action: "probe", platforms: ["android"], listPlugins, runner });
  const stageRes = await storeReleaseProject({ factory, stateDir, paseoHome, projectSlug: project.slug, projectRoot: repoDir, action: "stage", platforms: ["android", "ios"], listPlugins, runner });
  if (stageRes.ok && "settled" in stageRes) await stageRes.settled;
  const submitRes = await storeReleaseProject({ factory, stateDir, paseoHome, projectSlug: project.slug, projectRoot: repoDir, action: "submit", platforms: ["android"], runId: "run-a1", listPlugins, runner });
  if (submitRes.ok && "settled" in submitRes) await submitRes.settled;

  assert.deepEqual(recordedArgs[0], ["probe", "--project", repoDir, "--platforms", "android"]);
  assert.deepEqual(recordedArgs[1], ["run", "--playbook", "stage-release", "--project", repoDir, "--slug", project.slug, "--platforms", "android,ios"]);
  assert.deepEqual(recordedArgs[2], ["submit-production", "--project", repoDir, "--slug", project.slug, "--run", "run-a1", "--platforms", "android", "--approve"]);
});

test("paused-hole with consoleGuide formats lossless guide into Lead wakeup and keeps ledger compact while preserving legacy fallback", async (t) => {
  const dir = makeTempDir("store-release-console-guide-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android", "ios"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-GUIDE");
  await factory.accept({ task: "T-GUIDE", attempt: 1, accepted_by: "lead" });
  installFakeRunnerPlugin(paseoHome);
  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/synth-asc.p8",
    ASC_KEY_ID: "SYNTHKEY",
    ASC_ISSUER: "00000000-0000-0000-0000-000000000001",
    APPLE_TEAM_ID: "SYNTHTEAM",
    GPLAY_KEY_PATH: "/tmp/synth-gplay.json",
  });
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "on-request" });
  setStoreReleaseRequest(stateDir, project.slug, { target: "staging", platforms: ["android", "ios"] });

  const guidePath = join(repoDir, ".store-release", "day0-kit", "CONSOLE_GUIDE.md");
  const day0KitPath = join(repoDir, ".store-release", "day0-kit", "listing-copy.json");
  const listPlugins = async () => ({ ok: false as const, reason: "offline" });
  const notifications: Array<{ slug: string; text: string }> = [];

  const guidedRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "run-guide-1",
        playbook: "stage-release",
        status: "paused-hole",
        phases: [{ id: "phase-2-day0-and-signing", state: "paused-hole", hole: "day0-store-init" }],
        pausedAtHole: {
          phase: "phase-2-day0-and-signing",
          kind: "day0-store-init",
          resolutionSpec: { kind: "day0-store-init", type: "object", properties: { completed: "boolean" } },
          payload: {
            platforms: ["android", "ios"],
            bundleId: "com.example.demoapp",
            packageName: "com.example.demoapp",
            consoleGuidePath: guidePath,
            day0KitPath,
            consoleGuide: {
              version: "2026-11",
              consoleGuideVersion: "2026-11",
              generatedAt: "2026-11-22T00:00:00.000Z",
              appName: "Demo App",
              slug: "demo-app",
              platforms: ["android", "ios"],
              completedByApi: [
                {
                  id: "ios-bundle-id",
                  platform: "ios",
                  label: "Apple Bundle ID registered",
                  detail: "com.example.demoapp created with push capability",
                },
              ],
              antiRejectionWarnings: [
                {
                  id: "warn-data-safety",
                  platform: "android",
                  title: "Data Safety must match SDKs",
                  lesson: "Declare crash telemetry if Crashlytics is bundled.",
                  matchedTraits: ["crashlytics"],
                },
              ],
              sections: [
                {
                  id: "android-play",
                  platform: "android",
                  title: "Google Play Console Setup",
                  steps: [
                    {
                      id: "gplay-create",
                      order: 1,
                      title: "Create Android app",
                      menuPath: "All apps -> Create app",
                      url: "https://console.example.invalid/play/create",
                      instructions: ["Enter exact app name and select Free."],
                      copyFields: [{ id: "pkg", label: "Package name", value: "com.example.demoapp" }],
                      answers: [
                        {
                          question: "Does your app contain ads?",
                          answer: "No",
                          reason: "No ad SDK detected",
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "shared-legal",
                  platform: "shared",
                  title: "Legal Pages",
                  steps: [
                    {
                      id: "legal-host",
                      order: 1,
                      title: "Host privacy policy",
                      menuPath: "Store Listing -> Privacy Policy URL",
                      instructions: ["Publish generated HTML to HTTPS URL."],
                      copyFields: [{ id: "pp", label: "Privacy Policy URL", value: "https://example.invalid/privacy" }],
                    },
                  ],
                },
              ],
            },
          },
        },
      }),
      stderr: "",
    }),
  });

  assert.equal(guidedRes.ok, true);
  assert.ok("settled" in guidedRes);
  const guidedOutcome = await guidedRes.settled;
  assert.deepEqual(guidedOutcome, {
    status: "paused-hole",
    runId: "run-guide-1",
    holeKind: "day0-store-init",
    phase: "phase-2-day0-and-signing",
    hasConsoleGuide: true,
    guidePath,
  });

  const wakeupText = notifications[0]?.text ?? "";
  assert.match(wakeupText, /Console handoff guide/i);
  assert.match(wakeupText, /2026-11/);
  assert.match(wakeupText, /Data Safety must match SDKs/);
  assert.match(wakeupText, /Declare crash telemetry if Crashlytics is bundled\./);
  assert.match(wakeupText, /crashlytics/);
  assert.match(wakeupText, /Apple Bundle ID registered/);
  assert.match(wakeupText, /com\.example\.demoapp created with push capability/);
  assert.match(wakeupText, /Google Play Console Setup/);
  assert.match(wakeupText, /1\. Create Android app/);
  assert.match(wakeupText, /All apps -> Create app/);
  assert.match(wakeupText, /https:\/\/console\.example\.invalid\/play\/create/);
  assert.match(wakeupText, /Package name.*com\.example\.demoapp/);
  assert.match(wakeupText, /Does your app contain ads\?/);
  assert.match(wakeupText, /No ad SDK detected/);
  assert.match(wakeupText, /1\. Host privacy policy/);
  assert.match(wakeupText, /https:\/\/example\.invalid\/privacy/);
  assert.ok(wakeupText.includes(guidePath), "wakeup includes CONSOLE_GUIDE.md path");
  assert.ok(wakeupText.includes(day0KitPath), "wakeup includes day0KitPath");
  assert.doesNotMatch(wakeupText, /^Payload: \{"platforms"/m, "does not dump raw JSON payload when consoleGuide is formatted");

  const pausedEvent = factory.ledger.events.find(
    (e) => e.event === "store_release_paused" && e.runId === "run-guide-1",
  );
  assert.ok(pausedEvent !== undefined && pausedEvent.event === "store_release_paused");
  assert.equal(pausedEvent.holeKind, "day0-store-init");
  assert.equal(pausedEvent.phase, "phase-2-day0-and-signing");
  assert.equal(pausedEvent.hasConsoleGuide, true);
  assert.equal(pausedEvent.guidePath, guidePath);
  const serializedPaused = JSON.stringify(pausedEvent);
  assert.ok(serializedPaused.length < 512, `store_release_paused must remain compact, got ${serializedPaused.length} chars`);
  assert.doesNotMatch(serializedPaused, /Data Safety must match SDKs/);
  assert.doesNotMatch(serializedPaused, /console\.example\.invalid/);

  // Legacy run without consoleGuide preserves minimal summary + omitted guide metadata
  const legacyRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "run-legacy-1",
        playbook: "stage-release",
        status: "paused-hole",
        phases: [{ id: "phase-4-pricing", state: "paused-hole", hole: "price-conflict" }],
        pausedAtHole: {
          phase: "phase-4-pricing",
          kind: "price-conflict",
          payload: { packageName: "com.example.demoapp", conflicts: ["tier-mismatch"] },
        },
      }),
      stderr: "",
    }),
  });
  assert.equal(legacyRes.ok, true);
  assert.ok("settled" in legacyRes);
  const legacyOutcome = await legacyRes.settled;
  assert.deepEqual(legacyOutcome, {
    status: "paused-hole",
    runId: "run-legacy-1",
    holeKind: "price-conflict",
    phase: "phase-4-pricing",
    hasConsoleGuide: false,
  });
  assert.match(notifications[1]?.text ?? "", /Payload: \{"packageName":"com\.example\.demoapp"/);
  const legacyEvent = factory.ledger.events.find((e) => e.event === "store_release_paused" && e.runId === "run-legacy-1");
  assert.ok(legacyEvent !== undefined && legacyEvent.event === "store_release_paused");
  assert.equal(legacyEvent.hasConsoleGuide, undefined);
  assert.equal(legacyEvent.guidePath, undefined);
});

test("paused-hole with consoleGuide preserves sibling payload context while omitting consoleGuide and consoleChecklist", async (t) => {
  const dir = makeTempDir("store-release-sibling-payload-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android", "ios"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-SIBLING");
  await factory.accept({ task: "T-SIBLING", attempt: 1, accepted_by: "lead" });
  installFakeRunnerPlugin(paseoHome);
  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/synth-asc.p8",
    ASC_KEY_ID: "SYNTHKEY",
    ASC_ISSUER: "00000000-0000-0000-0000-000000000001",
    APPLE_TEAM_ID: "SYNTHTEAM",
    GPLAY_KEY_PATH: "/tmp/synth-gplay.json",
  });
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "auto-staging" });

  const listPlugins = async () => ({ ok: false as const, reason: "offline" });
  const notifications: Array<{ slug: string; text: string }> = [];

  const withSiblingsRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "run-final-approval",
        playbook: "stage-release",
        status: "paused-hole",
        phases: [{ id: "phase-7-final-gate", state: "paused-hole", hole: "final-release-approval" }],
        pausedAtHole: {
          phase: "phase-7-final-gate",
          kind: "final-release-approval",
          payload: {
            readiness: { android: "internal-uploaded", ios: "testflight-valid" },
            missingInputs: ["privacyPolicyUrl"],
            legalPages: { mode: "day0-kit", manualHostingRequired: true },
            consoleChecklist: ["redundant legacy checklist item"],
            consoleGuide: {
              consoleGuideVersion: "2026-11",
              appName: "Demo App",
              platforms: ["android", "ios"],
              completedByApi: [],
              antiRejectionWarnings: [],
              sections: [
                {
                  id: "final",
                  platform: "shared",
                  title: "Final Approval",
                  steps: [
                    {
                      id: "approve-prod",
                      order: 1,
                      title: "Approve production release",
                      menuPath: "App Review -> Submit",
                      instructions: ["Confirm readiness and reply to submit."],
                      copyFields: [],
                    },
                  ],
                },
              ],
            },
          },
        },
      }),
      stderr: "",
    }),
  });
  assert.equal(withSiblingsRes.ok, true);
  if (withSiblingsRes.ok && "settled" in withSiblingsRes) await withSiblingsRes.settled;

  const withSiblingsText = notifications[0]?.text ?? "";
  assert.match(withSiblingsText, /^Payload context: /m);
  const contextLine = withSiblingsText.split("\n").find((l) => l.startsWith("Payload context: ")) ?? "";
  const parsedContext = JSON.parse(contextLine.slice("Payload context: ".length)) as Record<string, unknown>;
  assert.deepEqual(parsedContext, {
    readiness: { android: "internal-uploaded", ios: "testflight-valid" },
    missingInputs: ["privacyPolicyUrl"],
    legalPages: { mode: "day0-kit", manualHostingRequired: true },
  });

  // When payload only has consoleGuide + consoleChecklist, Payload context line is omitted
  const onlyGuideRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins,
    notifyLead: (n) => { notifications.push(n); },
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        id: "run-guide-only",
        playbook: "stage-release",
        status: "paused-hole",
        phases: [{ id: "phase-2-day0-and-signing", state: "paused-hole", hole: "day0-store-init" }],
        pausedAtHole: {
          phase: "phase-2-day0-and-signing",
          kind: "day0-store-init",
          payload: {
            consoleChecklist: ["legacy checklist"],
            consoleGuide: {
              consoleGuideVersion: "2026-11",
              sections: [],
            },
          },
        },
      }),
      stderr: "",
    }),
  });
  assert.equal(onlyGuideRes.ok, true);
  if (onlyGuideRes.ok && "settled" in onlyGuideRes) await onlyGuideRes.settled;
  assert.doesNotMatch(notifications[1]?.text ?? "", /^Payload context:/m);
});

test("paused-hole with oversized consoleGuide bounds digest cleanly on a line boundary and points to full guide", async (t) => {
  const dir = makeTempDir("store-release-guide-bound-");
  disposeDir(t, dir);
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["android"]);
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-BOUND");
  await factory.accept({ task: "T-BOUND", attempt: 1, accepted_by: "lead" });
  installFakeRunnerPlugin(paseoHome);
  writeVaultStoreEnv(paseoHome, { GPLAY_KEY_PATH: "/tmp/synth-gplay.json" });
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "auto-staging" });

  const guidePath = join(repoDir, ".store-release", "day0-kit", "CONSOLE_GUIDE.md");
  const manySteps = Array.from({ length: 120 }, (_, i) => ({
    id: `step-${i + 1}`,
    order: i + 1,
    title: `Configure Play Console section ${i + 1}`,
    menuPath: `Policy -> Section ${i + 1}`,
    url: `https://console.example.invalid/play/step-${i + 1}`,
    instructions: [
      `Enter deterministic synthetic value-${i + 1} for compliance checklist line item ${i + 1} and save.`,
    ],
    copyFields: [{ id: `f-${i + 1}`, label: `Field ${i + 1}`, value: `synthetic-copy-value-${i + 1}` }],
  }));

  const notifications: Array<{ slug: string; text: string }> = [];
  const makeOversizedRunner = (includeGuidePath: boolean) => async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      id: includeGuidePath ? "run-bound-with-path" : "run-bound-no-path",
      playbook: "stage-release",
      status: "paused-hole",
      phases: [{ id: "phase-2-day0-and-signing", state: "paused-hole", hole: "day0-store-init" }],
      pausedAtHole: {
        phase: "phase-2-day0-and-signing",
        kind: "day0-store-init",
        payload: {
          ...(includeGuidePath ? { consoleGuidePath: guidePath } : {}),
          consoleGuide: {
            consoleGuideVersion: "2026-11",
            appName: "Oversized Demo App",
            platforms: ["android"],
            completedByApi: [],
            antiRejectionWarnings: [],
            sections: [
              {
                id: "android-play",
                platform: "android",
                title: "Google Play Console Setup",
                steps: manySteps,
              },
            ],
          },
        },
      },
    }),
    stderr: "",
  });

  const withPathRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins: async () => ({ ok: false as const, reason: "offline" }),
    notifyLead: (n) => { notifications.push(n); },
    runner: makeOversizedRunner(true),
  });
  assert.equal(withPathRes.ok, true);
  if (withPathRes.ok && "settled" in withPathRes) await withPathRes.settled;

  const textWithPath = notifications[0]?.text ?? "";
  const linesWithPath = textWithPath.split("\n");
  const digestStart = linesWithPath.findIndex((l) => l.startsWith("## Console handoff guide"));
  const digestEnd = linesWithPath.findIndex((l) => l.startsWith("Payload context: ") || l.startsWith("Next: "));
  assert.ok(digestStart >= 0 && digestEnd > digestStart);
  const digestWithPath = linesWithPath.slice(digestStart, digestEnd).join("\n");
  assert.ok(digestWithPath.length <= 16000, `expected digest <= 16000 chars, got ${digestWithPath.length}`);
  assert.match(digestWithPath, /^## Console handoff guide \(version 2026-11\)/);
  assert.ok(digestWithPath.includes(`- CONSOLE_GUIDE.md: ${guidePath}`));
  assert.match(digestWithPath, new RegExp(`truncated.*${guidePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  // Clean line boundary: the line right before the truncation notice must be a complete step/field line, never cut mid-line
  const noticeLineIdx = linesWithPath.findIndex((l) => /truncated/i.test(l));
  assert.ok(noticeLineIdx > digestStart);
  const lineBeforeNotice = linesWithPath[noticeLineIdx - 1] ?? "";
  assert.match(lineBeforeNotice, /(?:[Ss]ection \d+|step-\d+|save\.|Copy values:|synthetic-copy-value-\d+)$/);

  // Without guidePath, truncation notice falls back to "CONSOLE_GUIDE.md"
  const noPathRes = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    listPlugins: async () => ({ ok: false as const, reason: "offline" }),
    notifyLead: (n) => { notifications.push(n); },
    runner: makeOversizedRunner(false),
  });
  assert.equal(noPathRes.ok, true);
  if (noPathRes.ok && "settled" in noPathRes) await noPathRes.settled;

  const textNoPath = notifications[1]?.text ?? "";
  const linesNoPath = textNoPath.split("\n");
  const digestNoPath = linesNoPath
    .slice(
      linesNoPath.findIndex((l) => l.startsWith("## Console handoff guide")),
      linesNoPath.findIndex((l) => l.startsWith("Next: ")),
    )
    .join("\n");
  assert.ok(digestNoPath.length <= 16000, `expected digest <= 16000 chars, got ${digestNoPath.length}`);
  assert.match(digestNoPath, /truncated.*CONSOLE_GUIDE\.md/i);
});

async function assertPidDeadEsrch(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastCode: string | undefined;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      lastCode = code;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.throws(
    () => process.kill(pid, 0),
    (err: NodeJS.ErrnoException) => err.code === "ESRCH",
    `${label} (pid=${pid}, lastCode=${lastCode ?? "alive"}) must be dead (ESRCH)`,
  );
}

test("Store release default outer timeout is 75 minutes and grace window is 5 seconds", () => {
  assert.equal(DEFAULT_RUNNER_TIMEOUT_MS, 75 * 60 * 1000);
  assert.equal(DEFAULT_RUNNER_GRACE_MS, 5_000);
});

test("builtinStoreReleaseRunner kills detached runner and sleeping grandchild via -pgid SIGKILL after SIGTERM grace", { skip: process.platform === "win32" }, async (t) => {
  const dir = makeTempDir("store-release-pgid-kill-");
  const pidsPath = join(dir, "pids.json");
  const sigtermMarkerPath = join(dir, "sigterm.marker");
  t.after(() => {
    if (!existsSync(pidsPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(pidsPath, "utf8")) as { runnerPid?: number; grandchildPid?: number };
      if (typeof parsed.grandchildPid === "number") {
        try { process.kill(parsed.grandchildPid, "SIGKILL"); } catch { /* already dead */ }
      }
      if (typeof parsed.runnerPid === "number") {
        try { process.kill(parsed.runnerPid, "SIGKILL"); } catch { /* already dead */ }
      }
    } catch { /* ignore */ }
  });
  disposeDir(t, dir);

  const scriptPath = join(dir, "stubborn-runner.mjs");
  const grandchildScriptPath = join(dir, "grandchild.mjs");
  writeFileSync(
    grandchildScriptPath,
    `process.on("SIGTERM", () => {});
setInterval(() => {}, 60000);
`,
  );
  writeFileSync(
    scriptPath,
    `import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(sigtermMarkerPath)}, String(Date.now()));
});
const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScriptPath)}], { stdio: "inherit" });
const tmpPath = ${JSON.stringify(`${pidsPath}.tmp`)};
writeFileSync(tmpPath, JSON.stringify({ runnerPid: process.pid, grandchildPid: grandchild.pid }));
renameSync(tmpPath, ${JSON.stringify(pidsPath)});
setInterval(() => {}, 60000);
`,
  );

  const timeoutMs = 450;
  const graceMs = 250;
  const startedAt = Date.now();
  const out = await builtinStoreReleaseRunner({
    binPath: scriptPath,
    args: [],
    cwd: dir,
    env: {},
    timeoutMs,
    graceMs,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(out.timedOut, true);
  assert.ok(existsSync(pidsPath), "runner spawned grandchild and wrote pids");
  assert.ok(existsSync(sigtermMarkerPath), "runner received SIGTERM before SIGKILL escalation");
  assert.ok(elapsedMs >= timeoutMs + graceMs - 50, `expected grace wait before SIGKILL (elapsed=${elapsedMs}ms)`);

  const { runnerPid, grandchildPid } = JSON.parse(readFileSync(pidsPath, "utf8")) as {
    runnerPid: number;
    grandchildPid: number;
  };
  await assertPidDeadEsrch(runnerPid, "runner");
  await assertPidDeadEsrch(grandchildPid, "grandchild");
});

test("builtinStoreReleaseRunner allows clean SIGTERM exit within grace without requiring SIGKILL", { skip: process.platform === "win32" }, async (t) => {
  const dir = makeTempDir("store-release-sigterm-grace-");
  const pidPath = join(dir, "runner.pid");
  t.after(() => {
    if (!existsSync(pidPath)) return;
    try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch { /* already dead */ }
  });
  disposeDir(t, dir);

  const markerPath = join(dir, "clean-exit.marker");
  const scriptPath = join(dir, "graceful-runner.mjs");
  writeFileSync(
    scriptPath,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(markerPath)}, "cleaned-up");
  process.exit(42);
});
setInterval(() => {}, 60000);
`,
  );

  const timeoutMs = 250;
  const graceMs = 4_000;
  const startedAt = Date.now();
  const out = await builtinStoreReleaseRunner({
    binPath: scriptPath,
    args: [],
    cwd: dir,
    env: {},
    timeoutMs,
    graceMs,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(out.timedOut, true);
  assert.equal(out.exitCode, 42, "runner exited cleanly via its SIGTERM handler without SIGKILL");
  assert.equal(readFileSync(markerPath, "utf8"), "cleaned-up");
  assert.ok(elapsedMs < timeoutMs + graceMs - 1_000, `expected clean exit before grace expiry (elapsed=${elapsedMs}ms)`);
});

test("storeReleaseProject records runner-timed-out tool-bug with read-only Phase diagnosis and byte-identical Release run file", { skip: process.platform === "win32" }, async (t) => {
  const dir = makeTempDir("store-release-timeout-e2e-");
  const runnerPidPath = join(dir, "runner.pid");
  t.after(() => {
    if (!existsSync(runnerPidPath)) return;
    try { process.kill(Number(readFileSync(runnerPidPath, "utf8")), "SIGKILL"); } catch { /* already dead */ }
  });
  disposeDir(t, dir);

  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");
  const repoDir = makeMobileRepo(dir, ["ios"]);
  const otherRepoDir = join(dir, "other-app");
  mkdirSync(otherRepoDir, { recursive: true });
  const project = ensureProjectRegistered(stateDir, repoDir);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, "projects", project.slug) });
  t.after(() => factory.history.stop());

  acceptCommitOnRepo(factory, repoDir, "T-TIMEOUT");
  await factory.accept({ task: "T-TIMEOUT", attempt: 1, accepted_by: "lead" });

  const binPath = installFakeRunnerPlugin(paseoHome);
  writeFileSync(
    binPath,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(runnerPidPath)}, String(process.pid));
console.error("still waiting on xcrun");
setInterval(() => {}, 60000);
`,
  );
  chmodSync(binPath, 0o755);

  writeVaultStoreEnv(paseoHome, {
    ASC_KEY_PATH: "/tmp/synth-asc.p8",
    ASC_KEY_ID: "SYNTHKEY",
    ASC_ISSUER: "00000000-0000-0000-0000-000000000001",
    APPLE_TEAM_ID: "SYNTHTEAM",
  });
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: "auto-staging" });

  const runsDir = join(paseoHome, "release-lab", "runs");
  mkdirSync(runsDir, { recursive: true });
  const now = Date.now();
  // Stale prior run (must be ignored because it falls outside the start window)
  writeFileSync(
    join(runsDir, "rel-stale.json"),
    JSON.stringify({
      id: "rel-stale",
      playbook: "stage-release",
      projectSlug: project.slug,
      projectRoot: repoDir,
      status: "running",
      createdAt: now - 120_000,
      updatedAt: now - 120_000,
      phases: [{ id: "phase-1-preflight", state: "running" }],
    }),
  );
  // Active run for a different project (must be ignored)
  writeFileSync(
    join(runsDir, "rel-other.json"),
    JSON.stringify({
      id: "rel-other",
      playbook: "stage-release",
      projectSlug: "other-app",
      projectRoot: otherRepoDir,
      status: "running",
      createdAt: now,
      updatedAt: now,
      phases: [{ id: "phase-5-release-build", state: "running" }],
    }),
  );
  // Current matching active run
  const currentRunPath = join(runsDir, "rel-current-timeout.json");
  const currentRunContent = `${JSON.stringify(
    {
      id: "rel-current-timeout",
      playbook: "stage-release",
      projectSlug: project.slug,
      projectRoot: repoDir,
      status: "running",
      createdAt: now,
      updatedAt: now,
      phases: [
        { id: "phase-1-preflight", state: "green" },
        { id: "phase-3-e2e-and-screenshots", state: "running" },
        { id: "phase-5-release-build", state: "pending" },
      ],
    },
    null,
    2,
  )}\n`;
  writeFileSync(currentRunPath, currentRunContent);
  const beforeBytes = readFileSync(currentRunPath);

  const notifications: Array<{ slug: string; text: string }> = [];
  const res = await storeReleaseProject({
    factory,
    stateDir,
    paseoHome,
    projectSlug: project.slug,
    projectRoot: repoDir,
    action: "stage",
    timeoutMs: 300,
    graceMs: 120,
    listPlugins: async () => ({ ok: false as const, reason: "offline" }),
    notifyLead: (n) => { notifications.push(n); },
  });

  assert.equal(res.ok, true);
  assert.equal(hasActiveStoreReleases(), true, "active Store release counter stays > 0 until settlement");
  if (res.ok && "settled" in res) {
    await res.settled;
  }
  assert.equal(hasActiveStoreReleases(), false, "active Store release counter returns to 0 after timeout settles");

  const failedEvent = factory.ledger.events.find((e) => e.event === "store_release_failed");
  assert.ok(failedEvent !== undefined && failedEvent.event === "store_release_failed");
  assert.equal(failedEvent.code, "runner-timed-out");
  assert.equal(failedEvent.failureClass, "tool-bug");
  assert.equal(
    failedEvent.detail,
    "release-lab stage timed out after 300ms (run rel-current-timeout, phase phase-3-e2e-and-screenshots)",
  );

  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.text, /failureClass=tool-bug/);
  assert.match(notifications[0]!.text, /code=runner-timed-out/);
  assert.match(notifications[0]!.text, /rel-current-timeout/);
  assert.match(notifications[0]!.text, /phase-3-e2e-and-screenshots/);

  const afterBytes = readFileSync(currentRunPath);
  assert.equal(Buffer.compare(afterBytes, beforeBytes), 0, "Release lab run file must remain byte-identical");
});
