import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './artifacts.ts';
import { safePath } from './types.ts';
import { browserCoverageIssues } from './design-contract.ts';
import type { BrowserEvidenceReport } from './design-contract.ts';
/** Verification used by Dev's injected Gate and QA's authoritative audit. */
export function verifyBrowserFiles(root: string, report: BrowserEvidenceReport, screens: string[]): string[] {
  const issues = browserCoverageIssues(report, screens);
  if (issues.length) return issues;
  for (const viewport of report.viewports) {
    const ref = viewport.screenshot;
    try {
      if (!safePath(ref?.path) || ref.path.startsWith('/')) throw Error('unsafe path');
      const bytes = readFileSync(join(root, ref.path));
      if (sha256(bytes) !== ref.sha256 || bytes.length <= 8 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('invalid PNG/hash');
    } catch { issues.push(`missing or changed browser screenshot: ${ref?.path}`); }
  }
  return issues;
}
