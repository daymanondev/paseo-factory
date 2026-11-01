/** Lightweight prompt projection: agents need only the repository copy, never the catalog. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenDesignProjectLink } from './scrum/open-design-link.ts';
export function linkedDesignSpecification(root?: string, recorded?: OpenDesignProjectLink): string {
  let link = recorded;
  if (root) try { link = JSON.parse(readFileSync(join(root, 'design/open-design-link.json'), 'utf8')); } catch { /* Unlinked workspace. */ }
  if (!link) return '';
  return `Open Design Linked Specification (design/)\n${link.projectName} · ${link.screenCount} screens. The Owner's linked design is the authoritative UI/UX specification: design/screens.html (Flow Board), design/index.html (interactive prototype), design/styles.css (:root tokens), design/design-manifest.json. Lead must bind design/ in Peer contracts; Peers implement those screens and tokens. In Scrum, preserve and refine the Owner's linked Open Design screens seeded in .scratch/<initiativeId>/mockups/; generate EXPERIENCE.md, DESIGN.md and browser.json around them. Do not overwrite them with a generic layout.\n`;
}
