/** Shared design vocabulary for lint, evidence and the Owner studio. */
export const DESIGN_STATES = ['empty', 'loading', 'populated', 'error', 'offline', 'permission-denied'] as const;
export type DesignState = typeof DESIGN_STATES[number];
export type DesignViewport = 'desktop' | 'tablet' | 'mobile';
export interface ScrumDesignFinding {
  screen: string;
  state?: DesignState;
  viewport?: DesignViewport;
  selector?: string;
  status?: 'approved' | 'revise';
  note: string;
}
export type ScreenStatuses = Record<string, 'approved' | 'revise'>;
export type ScreenSurface = 'mobile' | 'desktop' | 'responsive';
export interface DesignScreen { surface: ScreenSurface; id: string; title?: string; body: string; line: number }
export const screenIdValid = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id);
export function designScreens(experience: string, manifest?: string): DesignScreen[] {
  const text = experience.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, '');
  const headings = [...text.matchAll(/^#{2,3}\s+Screen:\s*(\S+)(?:[ \t]+[—–-][ \t]+([^\n]+))?[^\n]*$/gm)];
  if (headings.length) return headings.map((m, i) => {
    const body = text.slice(m.index! + m[0].length, headings[i + 1]?.index ?? text.length);
    const surface = body.match(/(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}Surface\*{0,2}\s*:\s*\*{0,2}\s*(mobile|desktop|responsive)\b/i)?.[1].toLowerCase() as ScreenSurface | undefined;
    return { id: m[1], title: m[2], surface: surface ?? 'responsive', line: text.slice(0, m.index).split('\n').length, body };
  });
  if (manifest) {
    try { const data = JSON.parse(manifest); return (Array.isArray(data.screens) ? data.screens : []).map((s: { id: string; title?: string; surface?: ScreenSurface }) => ({ id: s.id, title: s.title, surface: s.surface ?? 'responsive', body: text, line: 1 })); } catch { /* Linter diagnoses absent declarations. */ }
  }
  return [];
}
export interface BrowserViewportEvidence {
  screen?: string; name?: string; width: number; height: number;
  screenshot: { path: string; sha256: string };
}
export interface BrowserStateEvidence { screen: string; state: DesignState; keyboard: boolean; passed: boolean; notApplicable?: string }
export interface DesignDetectorSummary {
  tool: 'impeccable'; passed: boolean; nonAdvisoryCount: number; advisoryCount?: number;
  viewportsChecked: Array<{ screen?: string; width: number; height: number; nonAdvisoryCount: number }>;
  findings?: Array<{ ruleId: string; severity: 'error' | 'warning' | 'advisory'; selector?: string; message: string }>;
}
export interface BrowserEvidenceReport {
  network: 'disabled'; consoleErrors: string[]; pageErrors?: string[];
  screens?: Array<{ id: string; title?: string; surface?: ScreenSurface }>;
  viewports: BrowserViewportEvidence[]; states: BrowserStateEvidence[]; detector?: DesignDetectorSummary;
}
export const desktopViewport = (v: { width: number; height: number }): boolean => v.width >= 1280 && v.height >= 800;
export const mobileViewport = (v: { width: number; height: number }): boolean => v.width > 0 && v.width <= 430 && v.height >= 640 && v.height <= 844;
export function detectorIssues(detector: DesignDetectorSummary | undefined, requireClean = true, surfaces: ScreenSurface[] = ['responsive']): string[] {
  if (!detector || detector.tool !== 'impeccable' || typeof detector.passed !== 'boolean' || !Number.isSafeInteger(detector.nonAdvisoryCount) || detector.nonAdvisoryCount < 0 || (requireClean && (detector.passed !== true || detector.nonAdvisoryCount !== 0)) ||
    !Array.isArray(detector.viewportsChecked) || (surfaces.some(s => s !== 'mobile') && !detector.viewportsChecked.some(desktopViewport)) || (surfaces.some(s => s !== 'desktop') && !detector.viewportsChecked.some(mobileViewport)) ||
    detector.viewportsChecked.some(v => !Number.isFinite(v.width) || !Number.isFinite(v.height) || !Number.isSafeInteger(v.nonAdvisoryCount) || v.nonAdvisoryCount < 0 || (requireClean && v.nonAdvisoryCount !== 0)) ||
    (detector.findings !== undefined && (!Array.isArray(detector.findings) || detector.findings.some(f => !f || !['error', 'warning', 'advisory'].includes(f.severity) || (requireClean && f.severity !== 'advisory')))))
    return ['impeccable detector needs zero non-advisory findings across Desktop and Mobile'];
  return [];
}
/** Same coverage floor for mockups, Dev story checks and QA browser audits. */
export function browserCoverageIssues(report: BrowserEvidenceReport, required: Array<string | Pick<DesignScreen, 'id' | 'surface'>>, strict = true, options: { requireCleanDetector?: boolean } = {}): string[] {
  const issues: string[] = [];
  if (report?.network !== 'disabled' || !Array.isArray(report.consoleErrors) || report.consoleErrors.length ||
    (report.pageErrors !== undefined && (!Array.isArray(report.pageErrors) || report.pageErrors.length)) ||
    !Array.isArray(report.viewports) || !report.viewports.length || !Array.isArray(report.states) || !report.states.length)
    return ['offline network, clean console/page errors, viewport screenshots and state checks required'];
  if ((report.screens !== undefined && (!Array.isArray(report.screens) || report.screens.some(s => !s || !screenIdValid(s.id)))) || report.states.some(s => !s || !screenIdValid(s.screen)) || report.viewports.some(v => !v || !Number.isFinite(v.width) || v.width < 1 || !Number.isFinite(v.height) || v.height < 1)) return ['invalid screen/viewport evidence'];
  const declarations = required.map(s => typeof s === 'string' ? { id: s, surface: 'responsive' as ScreenSurface } : s);
  const screens = new Set([...declarations.map(s => s.id), ...(report.screens ?? []).map(s => s.id), ...report.states.map(s => s.screen), ...report.viewports.flatMap(v => v.screen ? [v.screen] : [])]);
  for (const screen of screens) {
    if (!screenIdValid(screen)) issues.push('screen IDs must be stable kebab-case');
    for (const state of DESIGN_STATES) {
      const check = report.states.find(s => s.screen === screen && s.state === state);
      if (!check || !(check.keyboard === true && check.passed === true) && !(!strict && typeof check.notApplicable === 'string' && check.notApplicable.trim().length > 5)) issues.push(`${screen}/${state} needs a passing keyboard check`);
    }
    if (strict) {
      const captures = report.viewports.filter(v => v.screen === screen || (!v.screen && screens.size === 1));
      const surface = declarations.find(s => s.id === screen)?.surface ?? report.screens?.find(s => s.id === screen)?.surface ?? 'responsive';
      const needed = surface === 'mobile' ? [['Mobile (390x844)', mobileViewport] as const] : surface === 'desktop' ? [['Desktop (1280x800)', desktopViewport] as const] : [['Desktop (1280x800)', desktopViewport] as const, ['Mobile (390x844)', mobileViewport] as const];
      for (const [label, matches] of needed) {
        if (!captures.some(matches)) issues.push(`${screen} needs ${label} screenshots`);
        const checks = Array.isArray(report.detector?.viewportsChecked) ? report.detector.viewportsChecked : [];
        if (!checks.some(v => (!v.screen || v.screen === screen) && matches(v))) issues.push(`${screen} needs impeccable detector ${label} coverage`);
      }
    }
  }
  if (strict || report.detector !== undefined) issues.push(...detectorIssues(report.detector, options.requireCleanDetector ?? true, [...screens].map(id => declarations.find(s => s.id === id)?.surface ?? report.screens?.find(s => s.id === id)?.surface ?? 'responsive')));
  return issues;
}
export interface DesignTokens { colors: string[]; colorNames?: Record<string, string>; typography: string[]; spacing: string[]; radius: string[]; components: string[] }
/** Parse token declarations, never arbitrary prose containing category words. */
export function designTokens(text: string): DesignTokens {
  const tokens: DesignTokens = { colors: [], colorNames: {}, typography: [], spacing: [], radius: [], components: [] };
  type Category = 'colors' | 'typography' | 'spacing' | 'radius' | 'components';
  const category = (name: string): Category | undefined => ({ color: 'colors', colors: 'colors', typography: 'typography', spacing: 'spacing', radius: 'radius', radii: 'radius', rounded: 'radius', component: 'components', components: 'components' } as Record<string, Category>)[name.toLowerCase()];
  const clean = (s: string) => s.trim().replace(/^['"`]|['"`,]$/g, '');
  const add = (kind: Category, value: string) => {
    value = clean(value);
    if (!value || value.length > 160 || /^(?:none|TODO|TBD|placeholder)\b/i.test(value)) return;
    if (kind === 'colors') {
      for (const m of value.matchAll(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{3}\b/gi)) {
        if (!tokens.colors.includes(m[0])) tokens.colors.push(m[0]);
        const name = value.slice(0, m.index).match(/([\w-]+)\s*:?\s*['"]?$/)?.[1];
        if (name) tokens.colorNames![m[0]] = name;
      }
    } else if ((kind !== 'spacing' && kind !== 'radius') || /\b\d+(?:\.\d+)?(?:px|rem)\b/.test(value)) {
      if (!/letterSpacing/i.test(value) && !tokens[kind].includes(value)) tokens[kind].push(value);
    }
  };
  const front = text.match(/^---\s*\n([^]*?)\n---(?:\s*\n|$)/);
  if (front) {
    let kind: Category | undefined, role = '', fields: string[] = [], childIndent = 0;
    const flush = () => { if (kind && role && fields.length) add(kind, role + ': ' + fields.join(', ')); fields = []; role = ''; };
    for (const line of front[1].split('\n')) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const entry = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
      if (!entry) continue;
      const [, indent, key, raw] = entry;
      if (!indent) { flush(); childIndent = 0; kind = category(key); if (kind && raw) add(kind, raw); }
      else if (kind) {
        if (!childIndent || indent.length <= childIndent) { childIndent = indent.length; flush(); if (raw) add(kind, key + ': ' + clean(raw)); else role = key; }
        else if (role) fields.push(key + ': ' + clean(raw));
      }
    }
    flush();
    text = text.slice(front[0].length);
  }
  let section: Category | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      const next = category(heading[1].replace(/\s+tokens?$/i, ''));
      if (next) section = next;
      else if (section === 'components' && /^###\s/.test(line)) add('components', heading[1]);
      else section = undefined;
      continue;
    }
    const definition = line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '');
    const explicit = definition.match(/^([a-z]+)\s*[:|—-]\s*(.+)$/i);
    const kind = explicit && category(explicit[1]);
    if (kind) add(kind, explicit![2]);
    else if (section && /^(?:[-*]\s+|\|)/.test(line) && /[:|]/.test(definition)) add(section, definition);
  }
  return tokens;
}
