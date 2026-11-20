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
import { recordStoreNote, storeReleaseProject } from "../plugin/server/store-release.ts";
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
