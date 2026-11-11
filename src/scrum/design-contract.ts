/** Scrum design-approval evidence contract; the shared vocabulary lives in open-design/design-vocab.ts. */
import { DESIGN_STATES, designScreens, designTokens, screenIdValid } from "../open-design/design-vocab.ts";
import type { DesignScreen, DesignState, DesignTokens, ScreenSurface } from "../open-design/design-vocab.ts";
export { DESIGN_STATES, designScreens, designTokens, screenIdValid };
export type { DesignScreen, DesignState, DesignTokens, ScreenSurface };
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
export interface BrowserViewportEvidence {
  screen?: string; name?: string; width: number; height: number;
  scrollWidth?: number; clientWidth?: number;
  screenshot: { path: string; sha256: string };
}
export interface BrowserStateEvidence { screen: string; state: DesignState; keyboard: boolean; passed: boolean; notApplicable?: string }
export interface DesignDetectorSummary {
  tool: 'open-design' | 'impeccable'; direction?: string; passed: boolean; nonAdvisoryCount: number; advisoryCount?: number;
  viewportsChecked: Array<{ screen?: string; width: number; height: number; nonAdvisoryCount: number }>;
  findings?: Array<{ ruleId: string; severity: 'error' | 'warning' | 'advisory'; selector?: string; message: string }>;
}
export interface BrowserEvidenceReport {
  network: 'disabled'; consoleErrors: string[]; pageErrors?: string[];
  screens?: Array<{ id: string; title?: string; surface?: ScreenSurface }>;
  viewports: BrowserViewportEvidence[]; states: BrowserStateEvidence[]; detector?: DesignDetectorSummary;
}
export const desktopViewport = (v: { width: number; height: number }): boolean => !!v && v.width >= 1280 && v.height >= 800;
export const mobileViewport = (v: { width: number; height: number }): boolean => !!v && v.width > 0 && v.width <= 430 && v.height >= 640 && v.height <= 844;
export function detectorIssues(detector: DesignDetectorSummary | undefined, requireClean = true, surfaces: ScreenSurface[] = ['responsive'], requireOpenDesignOnly = false): string[] {
  if (requireOpenDesignOnly && detector?.tool !== 'open-design') return ['New runs require detector.tool: open-design'];
  if (!detector || !['open-design', ...(requireOpenDesignOnly ? [] : ['impeccable'])].includes(detector.tool) || typeof detector.passed !== 'boolean' || !Number.isSafeInteger(detector.nonAdvisoryCount) || detector.nonAdvisoryCount < 0 || (requireClean && (detector.passed !== true || detector.nonAdvisoryCount !== 0)) ||
    !Array.isArray(detector.viewportsChecked) || (surfaces.some(s => s !== 'mobile') && !detector.viewportsChecked.some(desktopViewport)) || (surfaces.some(s => s !== 'desktop') && !detector.viewportsChecked.some(mobileViewport)) ||
    detector.viewportsChecked.some(v => !v || !Number.isFinite(v.width) || !Number.isFinite(v.height) || !Number.isSafeInteger(v.nonAdvisoryCount) || v.nonAdvisoryCount < 0 || (requireClean && v.nonAdvisoryCount !== 0)) ||
    (detector.findings !== undefined && (!Array.isArray(detector.findings) || detector.findings.some(f => !f || !['error', 'warning', 'advisory'].includes(f.severity) || (requireClean && f.severity !== 'advisory')))))
    return ['Open Design detector needs zero non-advisory findings across declared surfaces'];
  return [];
}
/** Same coverage floor for mockups, Dev story checks and QA browser audits. */
export interface BrowserCoverageOptions {
  requireCleanDetector?: boolean;
  requireOpenDesignOnly?: boolean;
  sharedEdgeStates?: boolean;
  requireBoard?: boolean;
}
export function browserCoverageIssues(report: BrowserEvidenceReport, required: Array<string | Pick<DesignScreen, 'id' | 'surface'>>, strict = true, options: BrowserCoverageOptions = {}): string[] {
  const issues: string[] = [];
  const modern = options.requireOpenDesignOnly || report?.detector?.tool === 'open-design';
  if (report?.network !== 'disabled' || !Array.isArray(report.consoleErrors) || report.consoleErrors.length ||
    (modern && !Array.isArray(report.pageErrors)) || (report.pageErrors !== undefined && (!Array.isArray(report.pageErrors) || report.pageErrors.length)) ||
    !Array.isArray(report.viewports) || !report.viewports.length || !Array.isArray(report.states) || !report.states.length)
    return ['offline network, clean console/page errors, viewport screenshots and state checks required'];
  if ((report.screens !== undefined && (!Array.isArray(report.screens) || report.screens.some(s => !s || !screenIdValid(s.id) || (s.surface !== undefined && !['mobile', 'desktop', 'responsive'].includes(s.surface))))) || report.states.some(s => !s || !screenIdValid(s.screen) || !DESIGN_STATES.includes(s.state)) || report.viewports.some(v => !v || !Number.isFinite(v.width) || v.width < 1 || !Number.isFinite(v.height) || v.height < 1)) return ['invalid screen/viewport evidence'];
  const declarations = required.map(s => typeof s === 'string' ? { id: s, surface: 'responsive' as ScreenSurface } : s);
  const shared = options.sharedEdgeStates ?? modern;
  const screens = new Set(shared ? declarations.map(s => s.id) : [...declarations.map(s => s.id), ...(report.screens ?? []).map(s => s.id), ...report.states.map(s => s.screen), ...report.viewports.flatMap(v => v.screen ? [v.screen] : [])]);
  if (!screens.size) for (const s of report.screens ?? []) screens.add(s.id);
  const passing = (screen: string | undefined, state: DesignState) => report.states.some(s => (!screen || s.screen === screen) && s.state === state && ((s.keyboard === true && s.passed === true) || (!strict && typeof s.notApplicable === 'string' && s.notApplicable.trim().length > 5)));
  for (const screen of screens) {
    if (!screenIdValid(screen)) issues.push('screen IDs must be stable kebab-case');
    for (const state of shared ? ['populated'] as const : DESIGN_STATES) if (!passing(screen, state)) issues.push(`${screen}/${state} needs a passing keyboard check`);
    if (strict) {
      const captures = report.viewports.filter(v => v.screen === screen || (!v.screen && screens.size === 1));
      const surface = declarations.find(s => s.id === screen)?.surface ?? report.screens?.find(s => s.id === screen)?.surface ?? 'responsive';
      const mobile = modern ? (v: {width: number; height: number}) => v.width === 390 && v.height === 844 : mobileViewport;
      const needed = surface === 'mobile' ? [['Mobile (390x844)', mobile] as const] : surface === 'desktop' ? [['Desktop (1280x800)', desktopViewport] as const] : [['Desktop (1280x800)', desktopViewport] as const, ['Mobile (390x844)', mobile] as const];
      for (const [label, matches] of needed) {
        if (!captures.some(matches)) issues.push(`${screen} needs ${label} screenshots`);
        const checks = Array.isArray(report.detector?.viewportsChecked) ? report.detector.viewportsChecked : [];
        if (!checks.some(v => v && (!v.screen || v.screen === screen) && matches(v))) issues.push(`${screen} needs Open Design detector ${label} coverage`);
      }
    }
  }
  if (shared) for (const state of DESIGN_STATES.filter(s => s !== 'populated')) if (!passing(undefined, state)) issues.push(`System & Edge States/${state} needs a passing keyboard check`);
  if (options.requireBoard && !report.viewports.some(v => v.screen === 'screens-board' && /(?:^|\/)screens-board\.png$/.test(v.screenshot?.path ?? ''))) issues.push('screens-board needs a screens-board.png screenshot');
  if (modern) for (const viewport of report.viewports) {
    if (!Number.isFinite(viewport.scrollWidth) || !Number.isFinite(viewport.clientWidth) || viewport.clientWidth! <= 0 || viewport.scrollWidth! < 0 || viewport.scrollWidth! > viewport.clientWidth!) issues.push(`${viewport.screen ?? 'viewport'} needs zero horizontal overflow measurements`);
    if (!viewport.screenshot || typeof viewport.screenshot.path !== 'string' || !/\.png$/.test(viewport.screenshot.path) || !/^[a-f0-9]{64}$/.test(viewport.screenshot.sha256)) issues.push('viewport needs SHA-256 PNG screenshot evidence');
  }
  if (strict || report.detector !== undefined) issues.push(...detectorIssues(report.detector, options.requireCleanDetector ?? true, [...screens].map(id => declarations.find(s => s.id === id)?.surface ?? report.screens?.find(s => s.id === id)?.surface ?? 'responsive'), options.requireOpenDesignOnly));
  return issues;
}
