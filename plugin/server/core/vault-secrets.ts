import { FactoryError } from "./errors.ts";
import { LedgerAdmission } from "./history-admission.ts";
import { vaultStateDir, loadVaultConfig, SHARED_SECRET_FILES, STORE_DEFAULTS_FILE } from "./vault-config.ts";
import { sealVaultBuffer, resolveVaultPassphrase, unsealVaultBuffer } from "./vault-envelope.ts";
import { writeRuntimeFile, readJsonFile, collectCandidateProjectRoots, inspectProjectRootFacts, assertSafeVaultAppKey, readVaultManifestAt, applyVaultHydration, parseStoreDefaults, matchManifestAppKey, ensureLocalGitExcludeAndWorktreeInclude, jsonStringField, APP_FILE_TARGETS } from "./vault-materialization.ts";
import { probeGhAuth } from "./vault-transport.ts";
import { pullVault, pushVault, syncVault } from "./vault.ts";
import type { ImportVaultSecretsInput, ImportVaultSecretsResult, SyncVaultResult, WriteBackAndroidKeystoreInput, WriteBackAndroidKeystoreResult } from "./vault.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export { assertSafeVaultAppKey };

export function expandImportPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function readImportFile(rawPath: string, label: string): Buffer {
  const path = expandImportPath(rawPath);
  if (!existsSync(path)) {
    throw new FactoryError("vault-import-file-not-found", `${label} file not found at "${path}"`);
  }
  return readFileSync(path);
}

/**
 * 1-Click Key Import (spec §Implementation Decisions 3):
 * Imports `.p8`, ASC credentials, Google Play service account `.json`, `eye.json`,
 * and per-app Android/Firebase signing files from disk (or `process.env` when no
 * explicit inputs are given) into `<paseoHome>/vault-runtime/secrets/`, updates
 * `env.json` and local project checkouts via `applyVaultHydration`, and optionally
 * runs `syncVault` so imported keys are sealed and pushed to the remote vault.
 */
export async function importVaultSecrets(
  paseoHome: string,
  input: ImportVaultSecretsInput = {},
): Promise<ImportVaultSecretsResult> {
  const explicitFields = [
    input.ascKeyPath,
    input.ascKeyId,
    input.ascIssuer,
    input.teamId,
    input.gplayKeyPath,
    input.eyeConfigPath,
    input.keystorePath,
    input.storePass,
    input.keyAlias,
    input.firebaseProjectId,
    input.googleServicesJsonPath,
    input.googleServiceInfoPlistPath,
    input.envLocalPath,
    input.storeDefaultsPath,
  ];
  const hasExplicit =
    explicitFields.some((val) => val !== undefined && val.trim() !== "") ||
    input.storeDefaults !== undefined;

  const ascKeyPath = hasExplicit
    ? input.ascKeyPath?.trim() || undefined
    : process.env.ASC_KEY_PATH?.trim() && existsSync(expandImportPath(process.env.ASC_KEY_PATH))
      ? process.env.ASC_KEY_PATH.trim()
      : undefined;
  const ascKeyId = hasExplicit ? input.ascKeyId?.trim() || undefined : process.env.ASC_KEY_ID?.trim() || undefined;
  const ascIssuer = hasExplicit ? input.ascIssuer?.trim() || undefined : process.env.ASC_ISSUER?.trim() || undefined;
  const teamId = hasExplicit ? input.teamId?.trim() || undefined : process.env.APPLE_TEAM_ID?.trim() || undefined;
  const gplayKeyPath = hasExplicit
    ? input.gplayKeyPath?.trim() || undefined
    : process.env.GPLAY_KEY_PATH?.trim() && existsSync(expandImportPath(process.env.GPLAY_KEY_PATH))
      ? process.env.GPLAY_KEY_PATH.trim()
      : undefined;
  const eyeConfigPath = input.eyeConfigPath?.trim() || undefined;
  let explicitAppKey: string | undefined;
  if (input.appKey !== undefined) {
    const trimmed = input.appKey.trim();
    assertSafeVaultAppKey(trimmed === "" ? input.appKey : trimmed);
    explicitAppKey = trimmed;
  }

  const config = loadVaultConfig(paseoHome);
  const passphrase = resolveVaultPassphrase(config?.passphrase);
  const sortedImported = await LedgerAdmission.withStateMaintenance(vaultStateDir(paseoHome), () => {
    const importedFiles = new Set<string>();
    const runtimeRoot = join(paseoHome, "vault-runtime");
    const importFile = (rawPath: string | undefined, label: string, rel: string): void => {
      if (rawPath === undefined) return;
      const bytes = unsealVaultBuffer(readImportFile(rawPath, label), passphrase);
      writeRuntimeFile(paseoHome, rel, bytes);
      importedFiles.add(rel);
    };

    importFile(ascKeyPath, "ASC .p8 key", `secrets/shared/${SHARED_SECRET_FILES.ascKey}`);

    if (ascKeyId !== undefined || ascIssuer !== undefined || teamId !== undefined) {
      const rel = `secrets/shared/${SHARED_SECRET_FILES.ascCredentials}`;
      const prior = readJsonFile(join(runtimeRoot, rel)) ?? {};
      const merged = {
        ...prior,
        ...(ascKeyId !== undefined ? { keyId: ascKeyId } : {}),
        ...(ascIssuer !== undefined ? { issuerId: ascIssuer } : {}),
        ...(teamId !== undefined ? { teamId } : {}),
      };
      writeRuntimeFile(paseoHome, rel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
      importedFiles.add(rel);
    }

    importFile(gplayKeyPath, "Google Play service account JSON", `secrets/shared/${SHARED_SECRET_FILES.gplayServiceAccount}`);
    importFile(eyeConfigPath, "Eye config JSON", `secrets/shared/${SHARED_SECRET_FILES.eyeConfig}`);

    const storeDefaultsPath = input.storeDefaultsPath?.trim() || undefined;
    if (storeDefaultsPath !== undefined) {
      const rawDefaults = unsealVaultBuffer(readImportFile(storeDefaultsPath, "Store defaults JSON"), passphrase).toString("utf8");
      const parsedDefaults = parseStoreDefaults(rawDefaults, storeDefaultsPath);
      writeRuntimeFile(paseoHome, STORE_DEFAULTS_FILE, Buffer.from(`${JSON.stringify(parsedDefaults, null, 2)}\n`, "utf8"));
      importedFiles.add(STORE_DEFAULTS_FILE);
    } else if (input.storeDefaults !== undefined) {
      if (typeof input.storeDefaults !== "object" || input.storeDefaults === null || Array.isArray(input.storeDefaults)) {
        throw new FactoryError("corrupted-store-defaults", `${STORE_DEFAULTS_FILE} must be a JSON object`);
      }
      writeRuntimeFile(paseoHome, STORE_DEFAULTS_FILE, Buffer.from(`${JSON.stringify(input.storeDefaults, null, 2)}\n`, "utf8"));
      importedFiles.add(STORE_DEFAULTS_FILE);
    }

    const keystorePath = input.keystorePath?.trim() || undefined;
    const storePass = input.storePass?.trim() || undefined;
    const keyAlias = input.keyAlias?.trim() || undefined;
    const firebaseProjectId = input.firebaseProjectId?.trim() || undefined;
    const googleServicesJsonPath = input.googleServicesJsonPath?.trim() || undefined;
    const googleServiceInfoPlistPath = input.googleServiceInfoPlistPath?.trim() || undefined;
    const envLocalPath = input.envLocalPath?.trim() || undefined;

    const hasAppInputs =
      keystorePath !== undefined ||
      storePass !== undefined ||
      keyAlias !== undefined ||
      firebaseProjectId !== undefined ||
      googleServicesJsonPath !== undefined ||
      googleServiceInfoPlistPath !== undefined ||
      envLocalPath !== undefined;

    if (hasAppInputs) {
      let appKey = explicitAppKey;
      if (appKey === undefined) {
        const roots = collectCandidateProjectRoots(paseoHome);
        const firstFacts = roots.map(inspectProjectRootFacts).find((f) => f !== null) ?? null;
        appKey = firstFacts?.basename ?? "default";
      }
      assertSafeVaultAppKey(appKey);

      importFile(keystorePath, "Android release keystore", `secrets/apps/${appKey}/release.keystore`);

      if (storePass !== undefined || keyAlias !== undefined) {
        const rel = `secrets/apps/${appKey}/signing.json`;
        const prior = readJsonFile(join(runtimeRoot, rel)) ?? {};
        const merged: Record<string, unknown> = {
          ...prior,
          ...(storePass !== undefined
            ? {
                storePassword: storePass,
                ...(typeof prior.keyPassword === "string" && prior.keyPassword !== "" ? {} : { keyPassword: storePass }),
              }
            : {}),
          ...(keyAlias !== undefined ? { keyAlias } : {}),
        };
        writeRuntimeFile(paseoHome, rel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
        importedFiles.add(rel);
      }

      if (googleServicesJsonPath !== undefined) {
        importFile(googleServicesJsonPath, "google-services.json", `secrets/apps/${appKey}/google-services.json`);
      } else if (firebaseProjectId !== undefined) {
        const rel = `secrets/apps/${appKey}/google-services.json`;
        const prior = readJsonFile(join(runtimeRoot, rel)) ?? {};
        const priorInfo =
          typeof prior.project_info === "object" && prior.project_info !== null && !Array.isArray(prior.project_info)
            ? (prior.project_info as Record<string, unknown>)
            : {};
        const merged = {
          ...prior,
          project_info: { ...priorInfo, project_id: firebaseProjectId },
        };
        writeRuntimeFile(paseoHome, rel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
        importedFiles.add(rel);
      }

      importFile(googleServiceInfoPlistPath, "GoogleService-Info.plist", `secrets/apps/${appKey}/GoogleService-Info.plist`);
      importFile(envLocalPath, ".env.local", `secrets/apps/${appKey}/.env.local`);

      const manifest = existsSync(join(runtimeRoot, "vault.manifest.json"))
        ? readVaultManifestAt(runtimeRoot)
        : readVaultManifestAt(join(paseoHome, "vault"));
      if (!Object.hasOwn(manifest, appKey)) {
        manifest[appKey] = { repoBasename: appKey };
        writeRuntimeFile(paseoHome, "vault.manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
      }
    }

    applyVaultHydration(paseoHome);

    return [...importedFiles].sort();
  });
  let synced: SyncVaultResult | null = null;
  if (input.syncAfterImport !== false) {
    const configured = (loadVaultConfig(paseoHome)?.repo?.trim() ?? "") !== "";
    const canSync = configured || (await probeGhAuth(input.runner)).ghAuthenticated;
    if (canSync) {
      synced = await syncVault(paseoHome, { runner: input.runner });
    }
  }

  const syncSuffix =
    synced !== null
      ? ` and synced with ${synced.repo} (${synced.pushed ? `pushed ${synced.pushedFiles.length} file(s)` : "up to date"})`
      : " into local vault-runtime";
  const historyNote = synced?.historyImports?.length ? `; history ${synced.historyImports.map((item) => item.status).join(", ")}` : "";
  const summary =
    sortedImported.length > 0
      ? `Imported ${sortedImported.length} secret file(s) (${sortedImported.join(", ")})${syncSuffix}${historyNote}.`
      : `No new secret files imported${synced !== null ? `; synced with ${synced.repo}` : ""}${historyNote}.`;

  return {
    importedFiles: sortedImported,
    synced,
    summary,
  };
}

/** Stage a sealed file using the same codec and runtime permission policy as imports. */
export function sealVaultFile(paseoHome: string, sourcePath: string, vaultPath: string, passphrase?: string): { vaultPath: string; mode: "obfuscated" | "aes-256-gcm"; source: string; envelopeBytes: number } {
  return LedgerAdmission.stateMutation(vaultStateDir(paseoHome), () => {
    let plain: Buffer;
    try { plain = readFileSync(sourcePath); }
    catch { throw new FactoryError("vault-seal-source-missing", `vault seal: cannot read ${sourcePath}`); }
    const envelope = sealVaultBuffer(plain, passphrase);
    const serialized = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    writeRuntimeFile(paseoHome, vaultPath, serialized);
    return { vaultPath, mode: envelope.mode, source: sourcePath, envelopeBytes: serialized.length };
  });
}

function parseKeystoreProperties(propsPath: string): { storePassword?: string; keyPassword?: string; keyAlias?: string } {
  const out: { storePassword?: string; keyPassword?: string; keyAlias?: string } = {};
  for (const rawLine of readFileSync(propsPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (val === "") continue;
    if (key === "storePassword" || key === "keyPassword" || key === "keyAlias") {
      out[key] = val;
    }
  }
  return out;
}

function repoRelativeIfInside(projectRoot: string, candidatePath: string): string | null {
  try {
    const rootReal = realpathSync(projectRoot);
    const targetReal = realpathSync(candidatePath);
    const rel = relative(rootReal, targetReal);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).join("/");
  } catch {
    return null;
  }
}

/**
 * Day-0 Android upload keystore write-back (ADR 0066 §4):
 * Stages a newly generated `release.keystore` (plus sibling/explicit signing
 * properties) under `secrets/apps/<canonicalAppKey>/`, registers the app in
 * `vault.manifest.json`, materializes into `<projectRoot>` with `.git/info/exclude`
 * and `.worktreeinclude` hygiene registered so `<projectRoot>` stays git-clean,
 * and immediately seals & pushes to the configured Private vault remote.
 */
export async function writeBackAndroidKeystore(
  paseoHome: string,
  input: WriteBackAndroidKeystoreInput,
): Promise<WriteBackAndroidKeystoreResult> {
  const facts = inspectProjectRootFacts(input.projectRoot);
  if (facts === null) {
    throw new FactoryError("vault-project-not-git", `${input.projectRoot} does not resolve to a git checkout`);
  }
  const expandedKeystore = expandImportPath(input.keystorePath);
  const keystoreBytes = readImportFile(expandedKeystore, "Android release keystore");

  const explicitProps = input.keystorePropertiesPath?.trim() ? expandImportPath(input.keystorePropertiesPath) : undefined;
  if (explicitProps !== undefined && !existsSync(explicitProps)) {
    throw new FactoryError("vault-import-file-not-found", `Keystore properties file not found at "${explicitProps}"`);
  }
  const siblingProps = join(dirname(expandedKeystore), "keystore.properties");
  const propsPath = explicitProps ?? (existsSync(siblingProps) ? siblingProps : undefined);
  const propsSigning = propsPath !== undefined ? parseKeystoreProperties(propsPath) : {};

  const storePassword = input.storePass?.trim() || propsSigning.storePassword;
  const keyPassword = input.keyPass?.trim() || propsSigning.keyPassword || storePassword;
  const keyAlias = input.keyAlias?.trim() || propsSigning.keyAlias;
  let explicitAppKey: string | undefined;
  if (input.appKey !== undefined) {
    const trimmed = input.appKey.trim();
    assertSafeVaultAppKey(trimmed === "" ? input.appKey : trimmed);
    explicitAppKey = trimmed;
  }

  const config = loadVaultConfig(paseoHome);
  const passphrase = resolveVaultPassphrase(config?.passphrase);
  const vaultConfigured = (config?.repo?.trim() ?? "") !== "";
  if (input.syncAfterWriteBack !== false && vaultConfigured && existsSync(join(paseoHome, "vault", ".git"))) {
    await pullVault(paseoHome, { runner: input.runner, mergeLedgers: false });
  }

  const runtimeRoot = join(paseoHome, "vault-runtime");
  const manifest = existsSync(join(runtimeRoot, "vault.manifest.json"))
    ? readVaultManifestAt(runtimeRoot)
    : readVaultManifestAt(join(paseoHome, "vault"));

  let canonicalAppKey = explicitAppKey ?? "";
  if (canonicalAppKey === "") {
    canonicalAppKey = matchManifestAppKey(manifest, facts) ?? "";
  }
  if (canonicalAppKey === "") {
    const storeManifest = readJsonFile(join(facts.root, ".store-release", "manifest.json"));
    canonicalAppKey = jsonStringField(storeManifest, "appKey") ?? facts.basename;
  }
  assertSafeVaultAppKey(canonicalAppKey);

  const keystoreRel = `secrets/apps/${canonicalAppKey}/release.keystore`;
  const signingRel = `secrets/apps/${canonicalAppKey}/signing.json`;

  const writtenVaultFiles = await LedgerAdmission.withStateMaintenance(vaultStateDir(paseoHome), () => {
    const written: string[] = [];
    const unsealedKeystore = unsealVaultBuffer(keystoreBytes, passphrase);
    writeRuntimeFile(paseoHome, keystoreRel, unsealedKeystore);
    written.push(keystoreRel);

    if (storePassword !== undefined || keyPassword !== undefined || keyAlias !== undefined) {
      const prior = readJsonFile(join(runtimeRoot, signingRel)) ?? {};
      const merged: Record<string, unknown> = {
        ...prior,
        ...(storePassword !== undefined ? { storePassword } : {}),
        ...(keyPassword !== undefined ? { keyPassword } : {}),
        ...(keyAlias !== undefined ? { keyAlias } : {}),
      };
      writeRuntimeFile(paseoHome, signingRel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
      written.push(signingRel);
    }

    const priorEntry = Object.hasOwn(manifest, canonicalAppKey) ? manifest[canonicalAppKey]! : {};
    manifest[canonicalAppKey] = {
      ...priorEntry,
      repoBasename: facts.basename,
      ...(facts.originUrl !== null && facts.originUrl !== "" ? { gitRemote: facts.originUrl } : {}),
      ...(facts.bundleId !== null ? { bundleId: facts.bundleId } : {}),
      ...(facts.packageName !== null ? { packageName: facts.packageName } : {}),
    };
    writeRuntimeFile(paseoHome, "vault.manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));

    applyVaultHydration(paseoHome);

    // If the caller's source keystore/properties sat inside the repo outside APP_FILE_TARGETS, register hygiene for them too.
    const extraHygiene: string[] = [];
    for (const candidate of [expandedKeystore, ...(propsPath !== undefined ? [propsPath] : [])]) {
      const rel = repoRelativeIfInside(facts.root, candidate);
      if (rel !== null) extraHygiene.push(rel);
    }
    if (extraHygiene.length > 0) {
      ensureLocalGitExcludeAndWorktreeInclude(facts.root, extraHygiene);
    }

    return written.sort();
  });

  const materializedFiles = APP_FILE_TARGETS
    .map((target) => target.projectRel)
    .filter((rel) => existsSync(join(facts.root, rel)));

  let pushed = false;
  let sealedFiles: string[] = [];
  if (input.syncAfterWriteBack !== false && vaultConfigured) {
    const sealSet = new Set(writtenVaultFiles);
    const pushResult = await pushVault(paseoHome, {
      runner: input.runner,
      sealPaths: sealSet,
    });
    pushed = pushResult.pushed;
    sealedFiles = writtenVaultFiles.filter((rel) => pushResult.pushedFiles.includes(rel));
  }

  return {
    canonicalAppKey,
    writtenVaultFiles,
    sealedFiles,
    materializedFiles,
    pushed,
    summary: `Wrote back ${writtenVaultFiles.join(", ")} for ${canonicalAppKey}${pushed ? " and sealed/pushed to Private vault" : " into local vault-runtime"}.`,
  };
}
