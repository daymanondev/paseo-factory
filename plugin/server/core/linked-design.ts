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
  const visualBoundary = role === 'lead' ? 'Visual-Evidence & Screenshot Boundary: The Lead accepts work from text artifacts only: report-<task>-<n>.md (6-Field Handoff), git show --stat, git diff, and Gate results. The Lead NEVER loads screenshot, storyboard, or simulator images (*.png/*.jpg/*.webp, e.g. evidence-*/) into its long-lived session: inline images persist across turns and hit provider image caps (e.g. 10). For multi-screen visual parity or subjective UI checks, delegate to a fresh read-only Peer (reviewer or scout) in the Task worktree; decide from its text handoff (claim + file:line, blocking vs non-blocking).\n' : '';
  return `Open Design Linked Specification (design/)\n${link.projectName} · ${link.screenCount} screens. The Owner's linked design is the authoritative UI/UX specification, read in two halves.\nDesign catalog (the ONLY design/ files a Lead reads): design/design-manifest.json (tokens), design/screens-data.js (the full screen inventory — ids, titles, descriptions, per-group flows), design/app-data.js (seed/configuration data), design/screens.html (Flow Board). The catalog is a decomposition input, not a build spec: contracts name screens by id and flow from design/screens-data.js.\nDesign source (a Lead NEVER reads; bind it by reference in Peer contracts): design/index.html (interactive prototype), design/app.js (interaction logic), design/styles.css, design/screens.css. Peers read the full design/ bundle inside their Task worktree, so implementation fidelity is unchanged.\n${visualBoundary}`;
}
