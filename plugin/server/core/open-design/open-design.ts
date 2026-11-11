/** Embedded, offline UX engine. Native Open Design is an optional adapter. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OPEN_DESIGN_FRAMES } from './open-design-assets.ts';

export const OPEN_DESIGN_DIRECTIONS = [
  { id: 'editorial-monocle', colors: ['#f7f8f4', '#214f3d', '#162019', '#e9f0e5'], typography: 'Georgia display; system UI sans', craft: 'Generous breathing room, warm paper and sage tonal surfaces' },
  { id: 'modern-minimal', colors: ['#fafafa', '#09090b', '#e4e4e7'], typography: 'System sans; tabular numerals', craft: 'Crisp monochrome, hairline borders and precision grids' },
  { id: 'human-approachable', colors: ['#fbf9f5', '#a34e35', '#214f3d'], typography: 'Georgia display; system UI sans', craft: 'Warm cream, soft pills and friendly progressive wizards' },
  { id: 'tech-utility', colors: ['#f8fafc', '#0f172a', '#475569'], typography: 'System sans; monospace telemetry', craft: 'Dense slate utility, keyboard-first controls' },
  { id: 'brutalist-experimental', colors: ['#ffffff', '#000000', '#dedede'], typography: 'Bold editorial display; system sans', craft: 'High contrast editorial grids and bold structural rules' },
] as const;

export const OPEN_DESIGN_CONTRACT = `Open Design UX contract:
Bind one direction or installed Brand Design System in DESIGN.md, styles.css :root tokens and mockups/design-manifest.json. Embedded directions: ${OPEN_DESIGN_DIRECTIONS.map(d => `${d.id}: ${d.colors.join(', ')}; ${d.typography}; ${d.craft}`).join('\n')}.
One primary action per screen in thumb zone. Decompose journeys into focused steps with choice chips, radio cards, bottom sheets and SVG charts. Use drenched hero surfaces, borderless soft tonal surfaces, consistent system/editorial font pairings, 44px touch targets, visible focus and reduced motion. Card paragraphs stay within 280 visible characters.
For mobile, start from the complete staged .od-frames/iphone.html, android.html or neutral.html shell and place product content in .phone-content. Preserve hardware chrome, safe areas and separate --phone-* tokens. Use .od-frames/layout.css (@layer od-layout). Desktop/responsive web pages are their own product surface. Reserve space for fixed navigation and scroll content internally.
Deliver mockups/index.html (interactive), screens.html (story-grouped Flow Board with .frame-connection arrows and a System & Edge States group), styles.css, app.js, screens.css, screens-data.js and design-manifest.json {directionId or designSystemId, tokens, journeyGroups, screens, componentPatterns}. Expand journeys into as many focused screens as needed. EXPERIENCE.md declares Core Screens with ## Screen: kebab-case-id, Surface: mobile | desktop | responsive, primary journey and state behaviors.
Prototype routing reads ?screen=<id>&state=<state>, reflects root dataset.screen/state and handles scrum:set-state messages. Preserve app navigation for contextual empty/loading/error/offline/permission-denied states. Keep screen/state controls in the outer Studio. Use product language and SVG icons; keep internal spec identifiers in documentation.
Record actual offline Chromium evidence in browser.json: network: disabled, consoleErrors: [], pageErrors: [], viewports with screen, width/height, scrollWidth/clientWidth and SHA-256 PNG screenshot path/hash. Capture screens-board (screens-board.png) and every Core Screen at its declared surface (Mobile 390x844, Desktop 1280x800, responsive both). Record passing keyboard populated checks for each Core Screen and all five system states through edge screens/state handlers, or the legacy six-state matrix. Record detector {tool: open-design, passed: true, nonAdvisoryCount: 0, viewportsChecked, findings}. Derive it from factory open-design lint --dir <mockupsDir> and actual viewport checks; never invent results. Run lint-scrum-doc --kind ux before Claim. Dev consumes the approved manifest, DESIGN.md, styles.css and screens.html; UI Dev and QA supply the same offline evidence before sign-off.`;

/** Preserve authored assets across retries/revisions. */
export function stageOpenDesignFrames(mockupsDir: string): string[] {
  const dir = join(mockupsDir, '.od-frames');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(OPEN_DESIGN_FRAMES)) {
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), content);
  }
  return Object.keys(OPEN_DESIGN_FRAMES).map(name => join(dir, name));
}

export function inspectOpenDesignHost(environment: Record<string, string | undefined> = process.env) {
  const resourceRoot = environment.OPEN_DESIGN_RESOURCE_ROOT ?? (process.platform === 'win32' ? join(environment.LOCALAPPDATA ?? '', 'Programs/Open Design/resources/open-design') : '/Applications/Open Design.app/Contents/Resources/open-design');
  const available = existsSync(resourceRoot);
  const cli = join(dirname(resourceRoot), 'app/prebundled/daemon/daemon-cli.mjs');
  const catalog = join(resourceRoot, 'design-systems');
  const designSystems = existsSync(catalog) ? readdirSync(catalog).filter(id => existsSync(join(catalog, id, 'tokens.css')) && existsSync(join(catalog, id, 'DESIGN.md'))).sort().map(id => ({ id, directory: join(catalog, id), tokens: join(catalog, id, 'tokens.css'), design: join(catalog, id, 'DESIGN.md'), usage: join(catalog, id, 'USAGE.md'), components: join(catalog, id, 'components.manifest.json') })) : [];
  const binary = process.platform === 'darwin' ? resolve(resourceRoot, '../../MacOS/Open Design') : process.platform === 'win32' ? resolve(resourceRoot, '../../Open Design.exe') : process.execPath;
  return { binary: existsSync(binary) ? binary : process.execPath, available: available || !!environment.OPEN_DESIGN_DAEMON_URL, resourceRoot: available ? resourceRoot : null, daemonUrl: environment.OPEN_DESIGN_DAEMON_URL ?? null, cli: existsSync(cli) ? cli : null, designSystems };
}

/** Folder-backed import body understood by Open Design's projects API. Writeback stays external. */
export function openDesignWorkspace(mockupsDir: string, sourceRef: string) {
  return { baseDir: resolve(mockupsDir), orchestratorWorkspace: { kind: 'scratch', writeback: 'external', sourceLabel: 'Paseo Factory', sourceRef } };
}

export { runOpenDesignLint } from './open-design-lint.ts';
