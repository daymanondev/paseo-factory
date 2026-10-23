import { FactoryError } from "./errors.ts";
import { LedgerAdmission } from "./history-admission.ts";
import { vaultStateDir, loadVaultConfig, SHARED_SECRET_FILES } from "./vault-config.ts";
import { sealVaultBuffer, resolveVaultPassphrase, unsealVaultBuffer } from "./vault-envelope.ts";
import { writeRuntimeFile, readJsonFile, collectCandidateProjectRoots, inspectProjectRootFacts, assertSafeVaultPath, readVaultManifestAt, applyVaultHydration } from "./vault-materialization.ts";
import { probeGhAuth } from "./vault-transport.ts";
import { syncVault } from "./vault.ts";
import type { ImportVaultSecretsInput, ImportVaultSecretsResult, SyncVaultResult } from "./vault.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
    input.gplayKeyPath,
    input.eyeConfigPath,
    input.keystorePath,
    input.storePass,
    input.keyAlias,
    input.firebaseProjectId,
    input.googleServicesJsonPath,
    input.googleServiceInfoPlistPath,
  ];
  const hasExplicit = explicitFields.some((val) => val !== undefined && val.trim() !== "");

  const ascKeyPath = hasExplicit
    ? input.ascKeyPath?.trim() || undefined
    : process.env.ASC_KEY_PATH?.trim() && existsSync(expandImportPath(process.env.ASC_KEY_PATH))
      ? process.env.ASC_KEY_PATH.trim()
      : undefined;
  const ascKeyId = hasExplicit ? input.ascKeyId?.trim() || undefined : process.env.ASC_KEY_ID?.trim() || undefined;
  const ascIssuer = hasExplicit ? input.ascIssuer?.trim() || undefined : process.env.ASC_ISSUER?.trim() || undefined;
  const gplayKeyPath = hasExplicit
    ? input.gplayKeyPath?.trim() || undefined
    : process.env.GPLAY_KEY_PATH?.trim() && existsSync(expandImportPath(process.env.GPLAY_KEY_PATH))
      ? process.env.GPLAY_KEY_PATH.trim()
      : undefined;
  const eyeConfigPath = input.eyeConfigPath?.trim() || undefined;

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

    if (ascKeyId !== undefined || ascIssuer !== undefined) {
      const rel = `secrets/shared/${SHARED_SECRET_FILES.ascCredentials}`;
      const prior = readJsonFile(join(runtimeRoot, rel)) ?? {};
      const merged = {
        ...prior,
        ...(ascKeyId !== undefined ? { keyId: ascKeyId } : {}),
        ...(ascIssuer !== undefined ? { issuerId: ascIssuer } : {}),
      };
      writeRuntimeFile(paseoHome, rel, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8"));
      importedFiles.add(rel);
    }

    importFile(gplayKeyPath, "Google Play service account JSON", `secrets/shared/${SHARED_SECRET_FILES.gplayServiceAccount}`);
    importFile(eyeConfigPath, "Eye config JSON", `secrets/shared/${SHARED_SECRET_FILES.eyeConfig}`);

    const keystorePath = input.keystorePath?.trim() || undefined;
    const storePass = input.storePass?.trim() || undefined;
    const keyAlias = input.keyAlias?.trim() || undefined;
    const firebaseProjectId = input.firebaseProjectId?.trim() || undefined;
    const googleServicesJsonPath = input.googleServicesJsonPath?.trim() || undefined;
    const googleServiceInfoPlistPath = input.googleServiceInfoPlistPath?.trim() || undefined;

    const hasAppInputs =
      keystorePath !== undefined ||
      storePass !== undefined ||
      keyAlias !== undefined ||
      firebaseProjectId !== undefined ||
      googleServicesJsonPath !== undefined ||
      googleServiceInfoPlistPath !== undefined;

    if (hasAppInputs) {
      let appKey = input.appKey?.trim() ?? "";
      if (appKey === "") {
        const roots = collectCandidateProjectRoots(paseoHome);
        const firstFacts = roots.map(inspectProjectRootFacts).find((f) => f !== null) ?? null;
        appKey = firstFacts?.basename ?? "default";
      }
      assertSafeVaultPath(`secrets/apps/${appKey}`);

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

      const manifest = existsSync(join(runtimeRoot, "vault.manifest.json"))
        ? readVaultManifestAt(runtimeRoot)
        : readVaultManifestAt(join(paseoHome, "vault"));
      if (manifest[appKey] === undefined) {
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
