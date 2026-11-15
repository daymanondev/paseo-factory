/** Owner-authored machine pack registry; tombstones survive Private vault synchronization. */
import { join } from 'node:path';
import { atomicJson, readOptionalJson, stateMutation } from './json-store.ts';
import { FactoryError } from './errors.ts';
import { safeId } from './safe-id.ts';

export interface SkillPack { id: string; name: string; description?: string; skills: string[]; updatedAt: string; deleted?: boolean }
export interface SkillPackStore { packs: Record<string, SkillPack> }
export const skillPacksPath = (stateDir: string) => join(stateDir, 'skill-packs.json');
export function readSkillPackStore(stateDir: string): SkillPackStore {
  const value = readOptionalJson(skillPacksPath(stateDir), 'skill-packs-invalid') as SkillPackStore | undefined;
  if (value === undefined) return { packs: {} };
  if (!value || typeof value.packs !== 'object' || value.packs === null || Array.isArray(value.packs) || Object.entries(value.packs).some(([id, p]) => !safeId(id) || !p || p.id !== id || typeof p.name !== 'string' || !Array.isArray(p.skills) || !p.skills.every(safeId) || !Number.isFinite(Date.parse(p.updatedAt)) || (p.deleted !== undefined && typeof p.deleted !== 'boolean'))) throw new FactoryError('skill-packs-invalid', skillPacksPath(stateDir));
  return value;
}
export function listSkillPacks(stateDir: string): SkillPack[] { return Object.values(readSkillPackStore(stateDir).packs).filter(p => !p.deleted).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)); }
export function saveSkillPack(stateDir: string, input: { id?: string; name: string; description?: string; skills: string[]; updatedAt?: string }): SkillPack {
  return stateMutation(stateDir, () => {
    let id = input.id?.trim() ?? input.name?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if ((input.description !== undefined && typeof input.description !== 'string') || (input.updatedAt !== undefined && !Number.isFinite(Date.parse(input.updatedAt)))) throw new FactoryError('invalid-skill-pack', 'Invalid description or timestamp');
    if (!safeId(id) || ['core','expo','firebase','zcode-3d','science'].includes(id) || id.startsWith('source-') || !input.name?.trim() || !Array.isArray(input.skills) || !input.skills.every(s => typeof s === 'string' && safeId(s.trim()))) throw new FactoryError('invalid-skill-pack', 'A custom pack needs a unique safe id, name and skill names');
    const store = readSkillPackStore(stateDir);
    if (input.id === undefined && store.packs[id]) {
      const base = id; let suffix = 2;
      while (store.packs[id]) id = `${base}-${suffix++}`;
    }
    const pack: SkillPack = { id, name: input.name.trim(), ...(input.description?.trim() ? {description: input.description.trim()} : {}), skills: [...new Set(input.skills.map(s => s.trim()))], updatedAt: input.updatedAt ?? new Date().toISOString() };
    store.packs[id] = pack; atomicJson(skillPacksPath(stateDir), store); return pack;
  });
}
export function deleteSkillPack(stateDir: string, id: string): void {
  stateMutation(stateDir, () => {
    const store = readSkillPackStore(stateDir), pack = store.packs[id];
    if (!safeId(id) || !pack) throw new FactoryError('skill-pack-not-found', id);
    store.packs[id] = { ...pack, deleted: true, updatedAt: new Date().toISOString() }; atomicJson(skillPacksPath(stateDir), store);
  });
}
export function mergeSkillPackStores(local: SkillPackStore, remote: SkillPackStore, preferRemote = false): SkillPackStore {
  const packs = { ...local.packs };
  for (const [id, incoming] of Object.entries(remote.packs)) {
    const old = packs[id], delta = old ? Date.parse(incoming.updatedAt) - Date.parse(old.updatedAt) : 1;
    if (!old || delta > 0 || (delta === 0 && (incoming.deleted || (!old.deleted && preferRemote)))) packs[id] = incoming;
  }
  return { packs };
}
