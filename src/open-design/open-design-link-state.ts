/** Dependency-light validation shared by prompts, catalog sync, and RPC readers. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeId } from '../safe-id.ts';

export interface OpenDesignProjectLink {
  projectId: string; projectName: string; designSystemId?: string | null; directionId?: string | null;
  sourceUpdatedAt: number; syncedAt: string; digest: string; screenCount: number; files: string[];
}
/**
 * Is the staged design bundle usable? The one readiness law: a bundle needs
 * `design/index.html` or `design/screens.html` — `syncOpenDesignLink` refuses
 * anything else and catalog discovery hides it, so no valid design has another
 * layout. The panel's broken-link verdict and the dispatch auto-sync both read
 * this, so a second opinion can never drift in (ADR 0056 review P6).
 */
export function openDesignBundleReady(root: string): boolean {
  return existsSync(join(root, 'design/index.html')) || existsSync(join(root, 'design/screens.html'));
}
/** The link record's shape check — one validator for the staged file and the legacy settings migration. */
export function parseOpenDesignLink(value: unknown): OpenDesignProjectLink | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const link = value as Record<string, unknown>;
  if (typeof link.projectId !== 'string' || !safeId(link.projectId) || typeof link.projectName !== 'string' ||
      !['designSystemId', 'directionId'].every(key => link[key] == null || typeof link[key] === 'string') ||
      typeof link.sourceUpdatedAt !== 'number' || !Number.isFinite(link.sourceUpdatedAt) ||
      typeof link.syncedAt !== 'string' || !link.syncedAt.trim() || typeof link.digest !== 'string' || !link.digest.trim() ||
      typeof link.screenCount !== 'number' || !Number.isFinite(link.screenCount) ||
      !Array.isArray(link.files) || !link.files.every(file => typeof file === 'string')) return undefined;
  return value as OpenDesignProjectLink;
}
export function readOpenDesignLink(root: string): OpenDesignProjectLink | undefined {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(root, 'design/open-design-link.json'), 'utf8')); }
  catch (e) { if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  return parseOpenDesignLink(value);
}
