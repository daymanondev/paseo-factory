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
export interface DesignScreen { id: string; title?: string; body: string; line: number }
export const screenIdValid = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id);
export function designScreens(experience: string, manifest?: string): DesignScreen[] {
  const text = experience.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, '');
  const headings = [...text.matchAll(/^#{2,3}\s+Screen:\s*(\S+)(?:\s+[—–-]\s+([^\n]+))?[^\n]*$/gm)];
  if (headings.length) return headings.map((m, i) => ({ id: m[1], title: m[2], line: text.slice(0, m.index).split('\n').length, body: text.slice(m.index! + m[0].length, headings[i + 1]?.index ?? text.length) }));
  if (manifest) {
    try { const data = JSON.parse(manifest); return (Array.isArray(data.screens) ? data.screens : []).map((s: { id: string; title?: string }) => ({ id: s.id, title: s.title, body: text, line: 1 })); } catch { /* Linter diagnoses absent declarations. */ }
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
  viewportsChecked: Array<{ width: number; height: number; nonAdvisoryCount: number }>;
  findings?: Array<{ ruleId: string; severity: 'error' | 'warning' | 'advisory'; selector?: string; message: string }>;
}
export interface BrowserEvidenceReport {
  network: 'disabled'; consoleErrors: string[]; pageErrors?: string[];
  screens?: Array<{ id: string; title?: string }>;
  viewports: BrowserViewportEvidence[]; states: BrowserStateEvidence[]; detector?: DesignDetectorSummary;
}
export const desktopViewport = (v: { width: number; height: number }): boolean => v.width >= 1280 && v.height >= 800;
export const mobileViewport = (v: { width: number; height: number }): boolean => v.width > 0 && v.width <= 430 && v.height >= 640 && v.height <= 844;
export function detectorIssues(detector: DesignDetectorSummary | undefined, requireClean = true): string[] {
  if (!detector || detector.tool !== 'impeccable' || typeof detector.passed !== 'boolean' || !Number.isSafeInteger(detector.nonAdvisoryCount) || detector.nonAdvisoryCount < 0 || (requireClean && (detector.passed !== true || detector.nonAdvisoryCount !== 0)) ||
    !Array.isArray(detector.viewportsChecked) || !detector.viewportsChecked.some(desktopViewport) || !detector.viewportsChecked.some(mobileViewport) ||
    detector.viewportsChecked.some(v => !Number.isFinite(v.width) || !Number.isFinite(v.height) || !Number.isSafeInteger(v.nonAdvisoryCount) || v.nonAdvisoryCount < 0 || (requireClean && v.nonAdvisoryCount !== 0)) ||
    (detector.findings !== undefined && (!Array.isArray(detector.findings) || detector.findings.some(f => !f || !['error', 'warning', 'advisory'].includes(f.severity) || (requireClean && f.severity !== 'advisory')))))
    return ['impeccable detector needs zero non-advisory findings across Desktop and Mobile'];
  return [];
}
/** Same coverage floor for mockups, Dev story checks and QA browser audits. */
export function browserCoverageIssues(report: BrowserEvidenceReport, required: string[], strict = true, options: { requireCleanDetector?: boolean } = {}): string[] {
  const issues: string[] = [];
  if (report?.network !== 'disabled' || !Array.isArray(report.consoleErrors) || report.consoleErrors.length ||
    (report.pageErrors !== undefined && (!Array.isArray(report.pageErrors) || report.pageErrors.length)) ||
    !Array.isArray(report.viewports) || !report.viewports.length || !Array.isArray(report.states) || !report.states.length)
    return ['offline network, clean console/page errors, viewport screenshots and state checks required'];
  if ((report.screens !== undefined && (!Array.isArray(report.screens) || report.screens.some(s => !s || !screenIdValid(s.id)))) || report.states.some(s => !s || !screenIdValid(s.screen)) || report.viewports.some(v => !v || !Number.isFinite(v.width) || v.width < 1 || !Number.isFinite(v.height) || v.height < 1)) return ['invalid screen/viewport evidence'];
  const screens = new Set([...required, ...(report.screens ?? []).map(s => s.id), ...report.states.map(s => s.screen), ...report.viewports.flatMap(v => v.screen ? [v.screen] : [])]);
  for (const screen of screens) {
    if (!screenIdValid(screen)) issues.push('screen IDs must be stable kebab-case');
    for (const state of DESIGN_STATES) {
      const check = report.states.find(s => s.screen === screen && s.state === state);
      if (!check || !(check.keyboard === true && check.passed === true) && !(!strict && typeof check.notApplicable === 'string' && check.notApplicable.trim().length > 5)) issues.push(`${screen}/${state} needs a passing keyboard check`);
    }
    if (strict) {
      const captures = report.viewports.filter(v => v.screen === screen || (!v.screen && screens.size === 1));
      if (!captures.some(desktopViewport) || !captures.some(mobileViewport)) issues.push(`${screen} needs Desktop (1280x800) and Mobile (390x844) screenshots`);
    }
  }
  if (strict || report.detector !== undefined) issues.push(...detectorIssues(report.detector, options.requireCleanDetector ?? true));
  return issues;
}
export interface DesignTokens { colors: string[]; typography: string[]; spacing: string[]; radius: string[]; components: string[] }
export function designTokens(text: string): DesignTokens {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const category = (pattern: RegExp) => lines.filter(l => pattern.test(l));
  return { colors: [...new Set(text.match(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{3}\b/gi) ?? [])], typography: category(/typograph|font|heading|type scale/i), spacing: category(/spacing|space|gap/i), radius: category(/radius|radii/i), components: category(/component|button|input|card/i) };
}
