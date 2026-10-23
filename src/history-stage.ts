/** Durable transport staging. This module never opens or replaces a Ledger. */
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { planHistoryImport } from "./history-import.ts";
import type { HistoryImportSource, ImportConflict } from "./history-import.ts";
import { FactoryError } from "./errors.ts";

export interface ImportStatus {
  id: string;
  target: string;
  status: "staged" | "pending" | "applied" | "conflicted";
  added?: number;
  duplicates?: number;
  conflicts?: ImportConflict[];
  diagnostics: string[];
}
interface StoredSource extends Omit<HistoryImportSource, "bytes" | "artifacts"> {
  bytes: string;
  artifacts: { path: string; bytes: string }[];
}
export interface ImportManifest extends ImportStatus {
  version: 1;
  sources: StoredSource[];
  createdAt: string;
  beforeHash?: string;
  afterHash?: string;
  sequenceMaps?: unknown;
}

/** A Project destination is isolated state, never a filesystem alias to another Ledger. */
export function projectHistoryTarget(stateDir: string, slug: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)) throw new FactoryError("unknown-project", "history target must name a local Project");
  const path = join(stateDir, "projects", slug, "ledger.jsonl");
  const expected = join(historyTargetPath(stateDir), "projects", slug, "ledger.jsonl");
  if (historyTargetPath(path) !== expected) throw new FactoryError("history-target-alias", "Project history target aliases another state directory; restore an isolated Project state directory before import");
  return path;
}

/** One physical target identity, including paths whose final directories do not exist yet. */
export function historyTargetPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

const listeners = new Map<string, () => void>();
export function observeStagedImports(target: string, notify: () => void): () => void {
  const key = historyTargetPath(target);
  listeners.set(key, notify);
  return () => { if (listeners.get(key) === notify) listeners.delete(key); };
}
export function importDirectory(target: string, id?: string): string {
  return id === undefined ? join(dirname(historyTargetPath(target)), "history-imports") : join(dirname(historyTargetPath(target)), "history-imports", id);
}
export function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function makeDurableDirectory(path: string): void {
  const created = mkdirSync(path, { recursive: true });
  if (created === undefined) return;
  let directory = resolve(path);
  const first = resolve(created);
  while (true) {
    fsyncDirectory(directory);
    fsyncDirectory(dirname(directory));
    if (directory === first) break;
    directory = dirname(directory);
  }
}
export function writeDurableFile(path: string, bytes: string | Uint8Array, options: { mode?: number; afterRename?: () => void } = {}): void {
  path = historyTargetPath(path);
  makeDurableDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, bytes, { mode: options.mode ?? 0o600 });
  const fd = openSync(temp, "r");
  try { if (options.mode !== undefined) fchmodSync(fd, options.mode); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  options.afterRename?.();
  fsyncDirectory(dirname(path));
}
export function saveImportManifest(manifest: ImportManifest): void {
  writeDurableFile(join(importDirectory(manifest.target, manifest.id), "manifest.json"), `${JSON.stringify(manifest)}\n`);
}
export function loadImportManifest(target: string, id: string): ImportManifest {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new FactoryError("invalid-import", "invalid staged import identity");
  const manifest = JSON.parse(readFileSync(join(importDirectory(target, id), "manifest.json"), "utf8")) as ImportManifest;
  if (manifest.version !== 1 || manifest.id !== id || historyTargetPath(manifest.target) !== historyTargetPath(target) || !Array.isArray(manifest.sources) || !["staged", "pending", "applied", "conflicted"].includes(manifest.status)) {
    throw new FactoryError("invalid-import", `damaged import manifest ${id}`);
  }
  return manifest;
}
export function importSources(manifest: ImportManifest): HistoryImportSource[] {
  return manifest.sources.map((source) => ({ ...source, bytes: Buffer.from(source.bytes, "base64"), artifacts: source.artifacts.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes, "base64") })) }));
}
export function publicImportStatus(manifest: ImportManifest): ImportStatus {
  const { id, target, status, added, duplicates, conflicts, diagnostics } = manifest;
  return { id, target, status, ...(added === undefined ? {} : { added }), ...(duplicates === undefined ? {} : { duplicates }), ...(conflicts === undefined ? {} : { conflicts }), diagnostics };
}
export function readLedgerImports(target: string): ImportStatus[] {
  let entries: string[];
  try { entries = readdirSync(importDirectory(target)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return entries.filter((id) => /^[a-f0-9]{64}$/.test(id) && existsSync(join(importDirectory(target, id), "manifest.json"))).sort().map((id) => publicImportStatus(loadImportManifest(target, id)));
}

export function stageLedgerImport(targetPath: string, sources: readonly HistoryImportSource[]): ImportStatus {
  const target = historyTargetPath(targetPath);
  const id = planHistoryImport({ existingLines: "", sources }).id;
  const destination = importDirectory(target, id);
  if (!existsSync(join(destination, "manifest.json"))) {
    const dir = `${destination}.${process.pid}.${randomUUID()}.staging`;
    makeDurableDirectory(dir);
    const stored = sources.map((source, index) => {
      const bytes = Buffer.from(source.bytes ?? Buffer.from(source.lines));
      writeDurableFile(join(dir, `source-${index}.bin`), bytes);
      const artifacts = (source.artifacts ?? []).map((file, fileIndex) => {
        writeDurableFile(join(dir, `artifact-${index}-${fileIndex}.bin`), file.bytes);
        return { path: file.path, bytes: Buffer.from(file.bytes).toString("base64") };
      });
      return { ...source, bytes: bytes.toString("base64"), artifacts };
    });
    const manifest: ImportManifest = { version: 1, id, target, status: "pending", sources: stored, createdAt: new Date().toISOString(), diagnostics: ["snapshot fetched and staged; Ledger owner admission pending"] };
    writeDurableFile(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    try { renameSync(dir, destination); fsyncDirectory(dirname(destination)); }
    catch (error) {
      if (!existsSync(join(destination, "manifest.json"))) throw error;
      // A concurrent downloader published the same immutable batch first.
      rmSync(dir, { recursive: true, force: true });
    }
  }
  listeners.get(target)?.();
  return publicImportStatus(loadImportManifest(target, id));
}
