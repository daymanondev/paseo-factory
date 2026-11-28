/**
 * The linked-design clause injected into seat kickoffs, and role
 * contracts (v0.0.84): splits the Owner's linked `design/` bundle into
 * the Design catalog (the only design/ files a Lead reads — structured
 * inventory, a decomposition input) and Design source (interaction logic a
 * Lead NEVER reads and binds by reference in Peer contracts; Peers read the
 * full bundle inside their Task worktree).
 */
import { readOpenDesignLink, type OpenDesignProjectLink } from './open-design/open-design-link-state.ts';
export function linkedDesignSpecification(root?: string, recorded?: OpenDesignProjectLink, role?: 'lead' | 'supervisor' | 'agent'): string {
  const link = (root ? readOpenDesignLink(root) : undefined) ?? recorded;
  if (!link) return '';
  const visualBoundary = role === 'lead' ? 'Visual-Evidence & Screenshot Boundary: Accept from text only (report-<task>-<n>.md 6-Field Handoff, git show --stat, git diff, Gate results). Lead NEVER loads *.png/*.jpg/*.webp (e.g. evidence-*/) because inline images persist and hit provider image caps. Delegate UI parity to a fresh read-only Peer (reviewer or scout) in Task worktree; decide from claim + file:line (blocking vs non-blocking).\n' : '';
  return `Open Design Linked Specification (design/)\n${link.projectName} · ${link.screenCount} screens (authoritative UI/UX spec, two halves).\nDesign catalog (the ONLY design/ files a Lead reads): design/design-manifest.json, design/screens-data.js, design/app-data.js, design/screens.html — a decomposition input, not a build spec (name screens by id/flow from design/screens-data.js).\nDesign source (a Lead NEVER reads; bind by reference in Peer contracts): design/index.html, design/app.js, design/styles.css, design/screens.css (Peers read full design/ in Task worktree).\n${visualBoundary}`;
}
