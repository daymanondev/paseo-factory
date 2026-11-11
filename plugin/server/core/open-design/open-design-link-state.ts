/** Dependency-light validation shared by prompts, catalog sync, and RPC readers. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeId } from '../safe-id.ts';

export interface OpenDesignProjectLink {
  projectId: string; projectName: string; designSystemId?: string | null; directionId?: string | null;
  sourceUpdatedAt: number; syncedAt: string; digest: string; screenCount: number; files: string[];
}
export function readOpenDesignLink(root: string): OpenDesignProjectLink | undefined {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(root, 'design/open-design-link.json'), 'utf8')); }
  catch (e) { if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
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
