import { pendingUpgradeFor } from "./upgrade-state.ts";
import { FactoryError } from "./errors.ts";
import { reconcileHistory } from "./history-import.ts";
import type { HistoryImportSource, HistoryImportInput } from "./history-import.ts";
import { stageLedgerImport, readLedgerImports, projectHistoryTarget } from "./history-stage.ts";
import type { ImportStatus } from "./history-stage.ts";
import { parseLedgerJsonl } from "./ledger-validation.ts";
import { listProjectRegistrations } from "./project.ts";
import { vaultStateDir } from "./vault-config.ts";
import { resolveVaultApps, readVaultManifestAt, parseVaultManifest } from "./vault-materialization.ts";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** A snapshot holder's Ledger bytes, never proof of the original writer. */
export interface VaultLedgerSource extends HistoryImportSource {}

/** Pure validated history plan behind the existing string API. Refusal carries
 * original snapshots and diagnostics; writer admission owns activation. */
export function reconcileVaultLedgers(existingLines: string, sources: readonly VaultLedgerSource[], options: Pick<HistoryImportInput, "bindings" | "files"> = {}): string {
  return reconcileHistory(existingLines, sources, options);
}

/** Stage exact hydrated snapshots for registered local targets. Transport
 * success never asserts Ledger activation; only its writer may admit a batch. */
export function reconcileVaultLedgerState(paseoHome: string): ImportStatus[] {
  const stateDir = vaultStateDir(paseoHome);
  const runtimeRoot = join(paseoHome, "vault-runtime");
  const imports = mergeLedgerFile(join(stateDir, "ledger.jsonl"), nodeLedgerSourcesAt(runtimeRoot, ["global-ledger.jsonl"]));
  for (const app of resolveVaultApps(paseoHome, readVaultManifestAt(runtimeRoot))) {
    if (app.projectSlug === null) continue; // no local Project behind this key — nothing to reconcile into
    imports.push(...mergeLedgerFile(
      projectHistoryTarget(stateDir, app.projectSlug),
      nodeLedgerSourcesAt(runtimeRoot, ["projects", app.canonicalAppKey, "ledger.jsonl"]),
    ));
  }
  return imports;
}

/** Every node's copy of one ledger file under `<vaultTree>/state/nodes/<nodeId>/<...rel>`, node order. */
export function nodeLedgerSourcesAt(vaultTreeRoot: string, rel: readonly string[]): VaultLedgerSource[] {
  const nodesDir = join(vaultTreeRoot, "state", "nodes");
  const out: VaultLedgerSource[] = [];
  for (const nodeId of listDirNames(nodesDir)) {
    const path = join(nodesDir, nodeId, ...rel);
    if (existsSync(path)) { const bytes = readFileSync(path); out.push({ nodeId, lines: bytes.toString("utf8"), bytes }); }
  }
  return out;
}

/** Stage one target without activating it; the current owner decides admission. */
export function mergeLedgerFile(localPath: string, sources: readonly VaultLedgerSource[]): ImportStatus[] {
  return sources.length === 0 ? [] : [stageLedgerImport(localPath, sources)];
}

/** The entry names of a directory, sorted; a missing directory is empty. */
export function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Read persisted admission outcomes across registered destinations, without opening writers. */
export function readVaultHistoryStatus(paseoHome: string): ImportStatus[] {
  const state = vaultStateDir(paseoHome);
  return [join(state, "ledger.jsonl"), ...listProjectRegistrations(state).map((project) => join(state, "projects", project.slug, "ledger.jsonl"))].flatMap(readLedgerImports);
}

/** Re-read the durable owner decision after a maintenance lease has drained. */
export function refreshVaultImports(imports: readonly ImportStatus[]): ImportStatus[] {
  return imports.map((item) => readLedgerImports(item.target).find((current) => current.id === item.id) ?? item);
}

/** Export only acknowledged bytes. Reading/exporting never repairs the active Ledger. */
export function snapshotVaultLedger(source: string, target: string): void {
  const raw = readFileSync(source);
  const prefix = raw.subarray(0, raw.lastIndexOf(0x0a) + 1);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(prefix); }
  catch { throw new FactoryError("vault-ledger-corrupt", `Cannot publish invalid UTF-8 Ledger ${source}; inspect the original bytes`); }
  const parsed = parseLedgerJsonl(text);
  if (parsed.corrupt !== undefined) throw new FactoryError("vault-ledger-corrupt", `Cannot publish Ledger ${source}: ${parsed.corrupt}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, prefix);
}

/** Stage immutable fetched history before associated files can acquire maintenance. */
export function stageFetchedVaultHistory(paseoHome: string, files: ReadonlyMap<string, Buffer>): ImportStatus[] {
  const stateDir = vaultStateDir(paseoHome);
  const upgrade = pendingUpgradeFor(stateDir);
  if (upgrade !== undefined) throw new FactoryError("upgrade-recovery-required", `Upgrade ${upgrade} is incomplete; resume or restore before staging new Vault history`);
  const manifestBytes = files.get("vault.manifest.json");
  const manifest = manifestBytes === undefined ? readVaultManifestAt(join(paseoHome, "vault-runtime")) : parseVaultManifest(manifestBytes.toString("utf8"));
  const snapshots = (relative: string): VaultLedgerSource[] => [...files].flatMap(([path, bytes]) => {
    const match = /^state\/nodes\/([^/]+)\/(.+)$/.exec(path);
    return match?.[2] === relative ? [{ nodeId: match[1]!, lines: bytes.toString("utf8"), bytes }] : [];
  });
  const hold = { status: "pending" as const, diagnostics: ["downloaded history retained; associated Vault files await owner materialization before admission"] };
  const stage = (target: string, sources: VaultLedgerSource[]) => sources.length === 0 ? [] : [stageLedgerImport(target, sources, { materialization: hold })];
  const imports = stage(join(stateDir, "ledger.jsonl"), snapshots("global-ledger.jsonl"));
  for (const app of resolveVaultApps(paseoHome, manifest)) {
    if (app.projectSlug === null) continue;
    imports.push(...stage(projectHistoryTarget(stateDir, app.projectSlug), snapshots(`projects/${app.canonicalAppKey}/ledger.jsonl`)));
  }
  return imports;
}
