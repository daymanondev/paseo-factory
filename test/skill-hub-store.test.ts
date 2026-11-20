import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";
import {
  buildRoleSkillMatrix,
  discoverHostEcosystems,
  ensureCompanionPluginSkills,
  importHostSkillOrPack,
  inspectSkillHub,
  resolveRoleSkillsForProject,
} from "../src/skill-hub.ts";
import { provisionPiAgentHome } from "../src/pi-home.ts";
import { ensureProjectRegistered } from "../src/project.ts";

function installSyntheticReleaseLabSkill(pluginDir: string, content: string): string {
  const skillDir = join(pluginDir, "skill", "mobile-store-release");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content);
  return skillDir;
}

test("Skill hub discovers mobile-store-release from installed factory-release-lab plugin and host roots without phantom entries", (t) => {
  const dir = makeTempDir("skill-hub-store-");
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const paseoHome = join(dir, "paseo-home");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(paseoHome, { recursive: true });

  // 1. Absent factory-release-lab adds no extra host ecosystem
  const emptyCatalog = discoverHostEcosystems(userHome, paseoHome);
  assert.equal(emptyCatalog.some((e) => e.id === "paseo:factory-release-lab"), false);
  assert.equal(emptyCatalog.length, 1);

  // 2. Versioned install picks newest version dir and surfaces mobile-store-release
  const oldVer = join(paseoHome, "plugins", "factory-release-lab", "v1");
  const newVer = join(paseoHome, "plugins", "factory-release-lab", "v2");
  installSyntheticReleaseLabSkill(oldVer, "---\nname: mobile-store-release\n---\n# Old\n");
  installSyntheticReleaseLabSkill(newVer, "---\nname: mobile-store-release\n---\n# New v2\n");
  const tOld = new Date("2026-01-01T00:00:00Z");
  const tNew = new Date("2026-06-01T00:00:00Z");
  utimesSync(oldVer, tOld, tOld);
  utimesSync(newVer, tNew, tNew);

  const catalog = discoverHostEcosystems(userHome, paseoHome);
  const labEntry = catalog.find((e) => e.id === "paseo:factory-release-lab");
  assert.ok(labEntry, "factory-release-lab appears in Skill Hub host catalog");
  assert.deepEqual(labEntry.skills, ["mobile-store-release"]);
  assert.equal(labEntry.status, "available");
  assert.equal(labEntry.ecosystem, "paseo");

  // 3. Importing via Skill Hub installs mobile-store-release into ~/.agents/skills and links providers
  const imported = importHostSkillOrPack({ id: "paseo:factory-release-lab", userHome, paseoHome });
  assert.equal(imported.ok, true);
  assert.equal(
    readFileSync(join(userHome, ".agents", "skills", "mobile-store-release", "SKILL.md"), "utf8"),
    "---\nname: mobile-store-release\n---\n# New v2\n",
  );
  assert.equal(
    existsSync(join(userHome, ".pi", "agent", "skills", "mobile-store-release", "SKILL.md")),
    true,
  );

  const hubAfter = inspectSkillHub({ userHome, paseoHome });
  assert.equal(hubAfter.hostCatalog.find((e) => e.id === "paseo:factory-release-lab")?.status, "linked");
  assert.equal(hubAfter.installedSkills.some((s) => s.name === "mobile-store-release"), true);
});

test("Skill hub discovers factory-release-lab skill directory via config.json subpath install and host skill roots", (t) => {
  const dir = makeTempDir("skill-hub-config-");
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const paseoHome = join(dir, "paseo-home");
  const localCheckout = join(dir, "local-lab");
  mkdirSync(join(localCheckout, "plugin"), { recursive: true });
  installSyntheticReleaseLabSkill(localCheckout, "---\nname: mobile-store-release\n---\n# Local\n");
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(
    join(paseoHome, "config.json"),
    JSON.stringify({ plugins: { "factory-release-lab": { path: join(localCheckout, "plugin"), enabled: true } } }),
  );
  mkdirSync(join(userHome, ".claude", "skills", "mobile-store-release"), { recursive: true });
  writeFileSync(join(userHome, ".claude", "skills", "mobile-store-release", "SKILL.md"), "# Host\n");

  const catalog = discoverHostEcosystems(userHome, paseoHome);
  assert.ok(catalog.some((e) => e.id === "paseo:factory-release-lab" && e.skills.includes("mobile-store-release")));
  assert.ok(catalog.some((e) => e.id === "claude:mobile-store-release" && e.skills.includes("mobile-store-release")));
});

test("mobile-store-release is provisioned to Peers on Native Android, Native iOS, Expo, and manifest projects (never Lead or non-mobile)", (t) => {
  const dir = makeTempDir("skill-hub-peer-");
  disposeDir(t, dir);
  const userHome = join(dir, "user-home");
  const paseoHome = join(dir, "paseo-home");
  const stateDir = join(paseoHome, "plugin-state", "paseo-factory");

  const labVer = join(paseoHome, "plugins", "factory-release-lab", "v1");
  installSyntheticReleaseLabSkill(labVer, "---\nname: mobile-store-release\n---\n# Store Skill\n");

  // Companion skill sync provisions mobile-store-release safely without vendoring in repo
  const warnings: string[] = [];
  const synced = ensureCompanionPluginSkills({ userHome, paseoHome }, (msg) => warnings.push(msg));
  assert.equal(warnings.length, 0);
  assert.ok(synced.includes("mobile-store-release"));
  assert.equal(existsSync(join(userHome, ".agents", "skills", "mobile-store-release", "SKILL.md")), true);

  const nonMobileRoot = join(dir, "plain");
  mkdirSync(nonMobileRoot, { recursive: true });
  writeFileSync(join(nonMobileRoot, "README.md"), "# Plain\n");
  assert.equal(
    resolveRoleSkillsForProject({ role: "peer", projectRoot: nonMobileRoot, userHome, stateDir, paseoHome }).includes("mobile-store-release"),
    false,
  );

  const androidRoot = join(dir, "native-android");
  mkdirSync(join(androidRoot, "android", "app"), { recursive: true });
  writeFileSync(join(androidRoot, "android", "app", "build.gradle"), "android {}\n");
  gitCommitAll(androidRoot);

  const iosRoot = join(dir, "native-ios");
  mkdirSync(join(iosRoot, "ios", "Demo.xcodeproj"), { recursive: true });

  const manifestRoot = join(dir, "manifest-only");
  mkdirSync(join(manifestRoot, ".store-release"), { recursive: true });
  writeFileSync(join(manifestRoot, ".store-release", "manifest.json"), JSON.stringify({ appKey: "synth-app" }));

  for (const mobileRoot of [androidRoot, iosRoot, manifestRoot]) {
    const peerSkills = resolveRoleSkillsForProject({ role: "peer", projectRoot: mobileRoot, userHome, stateDir, paseoHome });
    assert.ok(peerSkills.includes("mobile-store-release"), `${mobileRoot} peer skills include mobile-store-release`);

    const matrix = buildRoleSkillMatrix({ projectRoot: mobileRoot, userHome, stateDir, paseoHome });
    assert.ok(matrix.find((r) => r.role === "peer")?.skills.includes("mobile-store-release"));
    assert.equal(matrix.find((r) => r.role === "lead")?.skills.includes("mobile-store-release"), false);
  }

  // Pi harness provisioning includes +~/.agents/skills/mobile-store-release for mobile Peer
  const sourcePi = join(userHome, ".pi", "agent");
  mkdirSync(sourcePi, { recursive: true });
  const proj = ensureProjectRegistered(stateDir, androidRoot);
  assert.ok(proj.ok);
  const peerHome = provisionPiAgentHome({
    stateDir,
    role: "agent",
    project: { root: androidRoot, slug: proj.slug },
    task: "T-01",
    sourceAgentDir: sourcePi,
    helperMcpSources: { userHome },
  });
  const piSettings = JSON.parse(readFileSync(join(peerHome, "settings.json"), "utf8")) as { skills: string[] };
  assert.ok(piSettings.skills.includes("+~/.agents/skills/mobile-store-release"));
});
