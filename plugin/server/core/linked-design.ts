/**
 * The linked-design clause injected into seat kickoffs, role contracts, and
 * Scrum prompts (v0.0.84): splits the Owner's linked `design/` bundle into
 * the Design catalog (the only design/ files a Lead reads — structured
 * inventory, a decomposition input) and Design source (interaction logic a
 * Lead NEVER reads and binds by reference in Peer contracts; Peers read the
 * full bundle inside their Task worktree).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenDesignProjectLink } from './scrum/open-design-link.ts';
export function linkedDesignSpecification(root?: string, recorded?: OpenDesignProjectLink): string {
  let link = recorded;
  if (root) try { link = JSON.parse(readFileSync(join(root, 'design/open-design-link.json'), 'utf8')); } catch { /* Unlinked workspace. */ }
  if (!link) return '';
  return `Open Design Linked Specification (design/)\n${link.projectName} · ${link.screenCount} screens. The Owner's linked design is the authoritative UI/UX specification, read in two halves.\nDesign catalog (the ONLY design/ files a Lead reads): design/design-manifest.json (tokens), design/screens-data.js (the full screen inventory — ids, titles, descriptions, per-group flows), design/app-data.js (seed/configuration data), design/screens.html (Flow Board). The catalog is a decomposition input, not a build spec: contracts name screens by id and flow from design/screens-data.js.\nDesign source (a Lead NEVER reads; bind it by reference in Peer contracts): design/index.html (interactive prototype), design/app.js (interaction logic), design/styles.css, design/screens.css. Peers read the full design/ bundle inside their Task worktree, so implementation fidelity is unchanged.\nIn Scrum, preserve and refine the Owner's linked Open Design screens seeded in .scratch/<initiativeId>/mockups/; generate EXPERIENCE.md, DESIGN.md and browser.json around them. Do not overwrite them with a generic layout.\n`;
}
