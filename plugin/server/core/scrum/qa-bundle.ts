import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitBytes, sha256 } from "./artifacts.ts";
import { safeId, safePath } from "./types.ts";
export const QA_LENSES = [
  "intent-alignment",
  "blind-hunter",
  "edge-case-hunter",
  "verification-gap",
] as const;
export interface EvidenceFile {
  path: string;
  sha256: string;
}
export interface QaExecution {
  command: string;
  exit: number;
  firstAttempt: boolean;
  fixtureId: string;
  environment: string;
  seed: string;
  tests: number;
  passed: number;
  skipped: number;
  expectedFailures: number;
  evidence: EvidenceFile[];
}
export interface QaFinding {
  id: string;
  confirmed: boolean;
  required: boolean;
  resolved: boolean;
  severity: "high" | "medium" | "low";
  requirement: string;
  reproduction: string;
  evidence: EvidenceFile[];
  kind: "product" | "harness";
}
export interface QaBundle {
  id: string;
  required: boolean;
  files: (EvidenceFile & { target: string })[];
  command: string;
  fixtureSetup: string;
  discoveryEvidence: EvidenceFile;
}
export interface QaReport {
  schemaVersion: 1;
  auditId: string;
  productSha: string;
  status: "clean" | "defects_found" | "blocked" | "inconclusive";
  baseline: QaExecution;
  runs: QaExecution[];
  testIds: string[];
  requirementRefs: string[];
  designRefs: string[];
  lenses: string[];
  findings: QaFinding[];
  bundles: QaBundle[];
  activeSuite: boolean;
}
const evidenceValid = (e: EvidenceFile): boolean =>
  !!e && safePath(e.path) && /^[a-f0-9]{64}$/.test(e.sha256);
function executionValid(e: QaExecution): boolean {
  return (
    !!e &&
    typeof e.command === "string" &&
    !!e.command.trim() &&
    Number.isInteger(e.exit) &&
    typeof e.firstAttempt === "boolean" &&
    !!e.fixtureId &&
    !!e.environment &&
    typeof e.seed === "string" &&
    [e.tests, e.passed, e.skipped, e.expectedFailures].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) &&
    Array.isArray(e.evidence) &&
    e.evidence.length > 0 &&
    e.evidence.every(evidenceValid)
  );
}
export function validateQaReport(value: unknown): string[] {
  const r = value as QaReport;
  if (
    !r ||
    r.schemaVersion !== 1 ||
    !safeId(r.auditId) ||
    !/^[a-f0-9]{40}$/.test(r.productSha) ||
    !["clean", "defects_found", "blocked", "inconclusive"].includes(r.status)
  )
    return ["invalid QA report identity/status"];
  const issues: string[] = [];
  if (typeof r.activeSuite !== "boolean") issues.push("activeSuite must explicitly be a boolean");
  if (
    !executionValid(r.baseline) ||
    r.baseline.exit !== 0 ||
    r.baseline.passed !== r.baseline.tests ||
    !r.baseline.firstAttempt ||
    r.baseline.skipped ||
    r.baseline.expectedFailures
  )
    issues.push("pre-existing baseline must pass with evidence");
  if (!Array.isArray(r.runs) || !r.runs.every(executionValid))
    issues.push("invalid candidate execution evidence");
  if (
    !Array.isArray(r.testIds) ||
    !r.testIds.length ||
    !Array.isArray(r.requirementRefs) ||
    !r.requirementRefs.length ||
    !Array.isArray(r.designRefs)
  )
    issues.push("test IDs and requirement/design references required");
  if (!Array.isArray(r.lenses) || !QA_LENSES.every((l) => r.lenses.includes(l)))
    issues.push(
      "all four QA lenses required (including claims/deletion checks)",
    );
  if (
    !Array.isArray(r.findings) ||
    r.findings.some(
      (f) =>
        !safeId(f?.id) ||
        !["high", "medium", "low"].includes(f.severity) ||
        !["product", "harness"].includes(f.kind) ||
        typeof f.confirmed !== "boolean" ||
        typeof f.required !== "boolean" ||
        typeof f.resolved !== "boolean" ||
        !f.requirement ||
        !f.reproduction ||
        !Array.isArray(f.evidence) ||
        !f.evidence.length ||
        !f.evidence.every(evidenceValid),
    )
  )
    issues.push(
      "findings require severity, requirement, reproduction and evidence",
    );
  if (
    !Array.isArray(r.bundles) ||
    r.bundles.some(
      (b) =>
        !safeId(b?.id) ||
        typeof b.required !== "boolean" ||
        !b.command ||
        !b.fixtureSetup ||
        !evidenceValid(b.discoveryEvidence) ||
        !Array.isArray(b.files) ||
        !b.files.length ||
        b.files.some(
          (f) =>
            !evidenceValid(f) ||
            !safePath(f.target) ||
            f.target.startsWith(".scratch/"),
        ),
    )
  )
    issues.push("invalid regression bundle manifest/discovery evidence");
  if (
    r.status === "defects_found" &&
    (!r.findings?.some(
      (f) => f.confirmed && f.kind === "product" && !f.resolved,
    ) ||
      !r.runs?.some((e) => e.exit !== 0))
  )
    issues.push("defects_found needs a confirmed reproduced product defect");
  if (r.status === "clean") {
    if (
      !Array.isArray(r.runs) ||
      r.runs.length !== 2 ||
      r.runs.some(
        (e) =>
          !executionValid(e) ||
          e.exit !== 0 ||
          !e.firstAttempt ||
          e.tests < 1 ||
          e.tests !== e.passed ||
          e.skipped !== 0 ||
          e.expectedFailures !== 0,
      ) ||
      r.runs[0]?.fixtureId === r.runs[1]?.fixtureId
    )
      issues.push(
        "clean requires two isolated first-attempt passes with no skipped/expected failures",
      );
    if (
      r.findings?.some(
        (f) =>
          (f.required && !f.resolved) || (f.kind === "harness" && !f.resolved),
      )
    )
      issues.push("clean report has unresolved findings");
  }
  return issues;
}
export function verifyQaFiles(root: string, report: QaReport): string[] {
  const issues = validateQaReport(report);
  if (issues.length) return issues;
  const files = [report.baseline, ...report.runs]
    .flatMap((e) => e.evidence)
    .concat(
      report.findings.flatMap((f) => f.evidence),
      report.bundles.flatMap((b) => [...b.files, b.discoveryEvidence]),
    );
  for (const ref of files) {
    try {
      if (sha256(readFileSync(join(root, ref.path))) !== ref.sha256)
        issues.push(`evidence hash mismatch: ${ref.path}`);
    } catch {
      issues.push(`missing evidence: ${ref.path}`);
    }
  }
  return issues;
}
export function bundlePromoted(
  root: string,
  artifactCommit: string,
  bundle: QaBundle,
): boolean {
  return bundle.files.every((f) => {
    try {
      const original = gitBytes(root, "show", `${artifactCommit}:${f.path}`);
      const active = gitBytes(root, "show", `HEAD:${f.target}`);
      return sha256(original) === f.sha256 && sha256(active) === f.sha256;
    } catch {
      return false;
    }
  });
}
export function executableRevisionIsCurrent(
  root: string,
  productSha: string,
  reportPaths: string[],
): boolean {
  if (!/^[a-f0-9]{40}$/.test(productSha)) return false;
  try {
    gitBytes(root, "merge-base", "--is-ancestor", productSha, "HEAD");
    const changed = gitBytes(
      root,
      "diff",
      "--name-only",
      "-z",
      productSha,
      "HEAD",
    )
      .toString()
      .split("\0")
      .filter(Boolean);
    return changed.every((path) => reportPaths.includes(path));
  } catch {
    return false;
  }
}
