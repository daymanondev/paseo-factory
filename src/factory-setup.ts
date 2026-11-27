/**
 * Pure core Factory setup policy, validation, canonicalization, hashing,
 * diagnostic scrubbing, out-of-ledger persistence, and interrupted-apply
 * recovery (ADR 0073).
 *
 * Zero `plugin/` or `@getpaseo/*` imports so `scripts/sync-plugin-core.mjs`
 * mirrors this file verbatim into `plugin/server/core/factory-setup.ts`.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { FactoryError } from "./errors.ts";
import { makeDurableDirectory } from "./history-stage.ts";
import { atomicJson, readOptionalJson, stateMutation } from "./json-store.ts";
import { projectStateDir } from "./project.ts";
import { PROJECT_RELEASE_MODES, PROJECT_STORE_RELEASE_MODES } from "./project-settings.ts";
import type { ProjectReleaseMode, ProjectStoreReleaseMode } from "./project-settings.ts";
import { safeId } from "./safe-id.ts";

export const FACTORY_SETUP_TIER1_COMPANIONS = ["factory-skills-pack"] as const;
export const FACTORY_SETUP_TIER2_COMPANIONS = ["factory-release-lab"] as const;
export const FACTORY_SETUP_COMPANION_IDS = [
  ...FACTORY_SETUP_TIER1_COMPANIONS,
  ...FACTORY_SETUP_TIER2_COMPANIONS,
] as const;

export const FACTORY_SETUP_MAX_ACTIONS = 16;
export const FACTORY_SETUP_MAX_REASON_CHARS = 500;
export const FACTORY_SETUP_MAX_HELPER_MCP_NAME_CHARS = 128;
export const FACTORY_SETUP_MAX_DIAGNOSTIC_CHARS = 500;
export const FACTORY_SETUP_RECOVERED_APPLYING_ERROR =
  "Daemon restarted while applying setup proposal — safe to Retry or Dismiss";

export const FACTORY_SETUP_CANONICAL_ORDER = [
  "vault_hydrate",
  "install_companion",
  "set_release_mode",
  "set_store_release_mode",
  "set_skill_pack",
  "set_helper_mcp",
  "sync_open_design",
] as const;

export type FactorySetupTier = 1 | 2;
export type FactorySetupCompanionId = (typeof FACTORY_SETUP_COMPANION_IDS)[number];

export type FactorySetupAction =
  | { kind: "install_companion"; id: FactorySetupCompanionId }
  | { kind: "set_release_mode"; mode: ProjectReleaseMode; branch?: string | null }
  | { kind: "set_store_release_mode"; mode: ProjectStoreReleaseMode }
  | { kind: "set_skill_pack"; pack: string; enabled: boolean }
  | { kind: "set_helper_mcp"; name: string; enabled: boolean }
  | { kind: "sync_open_design"; projectId: string }
  | { kind: "vault_hydrate" };

export type FactorySetupActionKind = FactorySetupAction["kind"];
export type SetupProposalStatus = "pending" | "applying" | "failed";
export type SetupActionStepStatus = "pending" | "done" | "failed" | "skipped";
export type SetupAuditActor = "supervisor" | "owner-approved" | "owner-declined" | "owner-dismissed";

export interface SetupActionStepResult {
  index: number;
  action: FactorySetupAction;
  tier: FactorySetupTier;
  status: SetupActionStepStatus;
  summary?: string;
  error?: string;
}

export interface SetupProposalRecord {
  schemaVersion: 1;
  id: string;
  actionsHash: string;
  projectSlug: string;
  status: SetupProposalStatus;
  reason: string;
  warnings?: string[];
  supervisorHandoffAgentId?: string;
  actions: FactorySetupAction[];
  steps: SetupActionStepResult[];
  createdAt: string;
  updatedAt: string;
}

export interface SetupAuditEntry {
  timestamp: string;
  projectSlug: string;
  proposalId?: string;
  actionsHash?: string;
  tier: FactorySetupTier;
  actor: SetupAuditActor;
  reason: string;
  steps: SetupActionStepResult[];
}

export interface ValidatedFactorySetupInput {
  actions: FactorySetupAction[];
  canonicalActions: FactorySetupAction[];
  actionsHash: string;
  tier: FactorySetupTier;
  reason: string;
}

const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ASCII_CONTROL_GLOBAL_RE = /[\u0000-\u001f\u007f]/g;
const NON_NEWLINE_REASON_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u0085]/g;
const MULTI_PARAGRAPH_RE = /\n[ \t]*\n/;
const FORBIDDEN_GIT_BRANCH_CHARS_RE = /[~^:?*\[]/;

const CANONICAL_ORDER_RANK: Record<FactorySetupActionKind, number> = {
  vault_hydrate: 0,
  install_companion: 1,
  set_release_mode: 2,
  set_store_release_mode: 3,
  set_skill_pack: 4,
  set_helper_mcp: 5,
  sync_open_design: 6,
};

const ALLOWED_KEYS_BY_KIND: Record<FactorySetupActionKind, ReadonlySet<string>> = {
  install_companion: new Set(["kind", "id"]),
  set_release_mode: new Set(["kind", "mode", "branch"]),
  set_store_release_mode: new Set(["kind", "mode"]),
  set_skill_pack: new Set(["kind", "pack", "enabled"]),
  set_helper_mcp: new Set(["kind", "name", "enabled"]),
  sync_open_design: new Set(["kind", "projectId"]),
  vault_hydrate: new Set(["kind"]),
};

const PROPOSAL_STATUSES: ReadonlySet<string> = new Set(["pending", "applying", "failed"]);
const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "done", "failed", "skipped"]);
const AUDIT_ACTORS: ReadonlySet<string> = new Set([
  "supervisor",
  "owner-approved",
  "owner-declined",
  "owner-dismissed",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/**
 * Validates a git branch name using strict `git check-ref-format --branch`
 * safety rules. Accepts single-level (`main`) and hierarchical (`release/v1.0`)
 * branch names; rejects whitespace, control chars, leading `-`, bare `@`,
 * `HEAD`, `@{`, `..`, `\`, `~`, `^`, `:`, `?`, `*`, `[`, leading/trailing `/`,
 * `//`, trailing `.`, and path components starting with `.` or ending with `.lock`.
 */
export function isValidGitBranchRef(branch: string): boolean {
  if (typeof branch !== "string" || branch.length === 0) return false;
  if (ASCII_CONTROL_RE.test(branch)) return false;
  if (/\s/.test(branch)) return false;
  if (branch.startsWith("-")) return false;
  if (branch === "@") return false;
  if (branch === "HEAD") return false;
  if (branch.includes("@{")) return false;
  if (branch.includes("..")) return false;
  if (branch.includes("\\")) return false;
  if (FORBIDDEN_GIT_BRANCH_CHARS_RE.test(branch)) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return false;
  if (branch.endsWith(".")) return false;
  const parts = branch.split("/");
  for (const part of parts) {
    if (part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) {
      return false;
    }
  }
  return true;
}

export const isValidSetupBranchName = isValidGitBranchRef;

function sanitizeSetupReason(rawReason: unknown): string {
  if (typeof rawReason !== "string") {
    throw new FactoryError("invalid-setup-reason", "reason must be a string");
  }
  const normalized = rawReason
    .replace(/\r\n?/g, "\n")
    .replace(NON_NEWLINE_REASON_CONTROL_GLOBAL_RE, "");
  if (MULTI_PARAGRAPH_RE.test(normalized)) {
    throw new FactoryError("invalid-setup-reason", "reason must be a single paragraph");
  }
  const cleaned = normalized
    .replace(/[\n\t]+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    throw new FactoryError("invalid-setup-reason", "reason must not be empty");
  }
  if (cleaned.length > FACTORY_SETUP_MAX_REASON_CHARS) {
    throw new FactoryError(
      "invalid-setup-reason",
      `reason must be at most ${FACTORY_SETUP_MAX_REASON_CHARS} characters`,
    );
  }
  return cleaned;
}

function assertNoUnexpectedDefinedKeys(
  raw: Record<string, unknown>,
  kind: FactorySetupActionKind,
  index: number,
): void {
  const allowed = ALLOWED_KEYS_BY_KIND[kind];
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.has(key)) continue;
    if (value !== undefined && value !== null) {
      throw new FactoryError(
        "invalid-setup-action",
        `actions[${index}]: unexpected field "${key}" for ${kind}`,
      );
    }
  }
}

function validateActionAtIndex(raw: unknown, index: number): FactorySetupAction {
  const prefix = `actions[${index}]: `;
  if (!isPlainObject(raw)) {
    throw new FactoryError("invalid-setup-action", `${prefix}must be an object`);
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED_KEYS_BY_KIND, kind)) {
    throw new FactoryError("invalid-setup-action", `${prefix}unknown or missing kind "${String(kind)}"`);
  }
  const typedKind = kind as FactorySetupActionKind;
  assertNoUnexpectedDefinedKeys(raw, typedKind, index);

  switch (typedKind) {
    case "install_companion": {
      if (typeof raw.id !== "string" || raw.id.trim() === "") {
        throw new FactoryError("invalid-setup-action", `${prefix}install_companion requires non-empty string id`);
      }
      if (!(FACTORY_SETUP_COMPANION_IDS as readonly string[]).includes(raw.id)) {
        throw new FactoryError(
          "setup-action-forbidden",
          `${prefix}companion "${raw.id}" is not in the setup whitelist`,
        );
      }
      return { kind: "install_companion", id: raw.id as FactorySetupCompanionId };
    }
    case "set_release_mode": {
      if (typeof raw.mode !== "string" || !(PROJECT_RELEASE_MODES as readonly string[]).includes(raw.mode)) {
        throw new FactoryError(
          "invalid-setup-action",
          `${prefix}set_release_mode.mode must be one of ${PROJECT_RELEASE_MODES.join(", ")}`,
        );
      }
      if (raw.branch === undefined) {
        return { kind: "set_release_mode", mode: raw.mode as ProjectReleaseMode };
      }
      if (raw.branch === null) {
        return { kind: "set_release_mode", mode: raw.mode as ProjectReleaseMode, branch: null };
      }
      if (typeof raw.branch !== "string" || !isValidGitBranchRef(raw.branch)) {
        throw new FactoryError(
          "invalid-setup-action",
          `${prefix}invalid release branch "${String(raw.branch)}"`,
        );
      }
      return { kind: "set_release_mode", mode: raw.mode as ProjectReleaseMode, branch: raw.branch };
    }
    case "set_store_release_mode": {
      if (typeof raw.mode !== "string" || !(PROJECT_STORE_RELEASE_MODES as readonly string[]).includes(raw.mode)) {
        throw new FactoryError(
          "invalid-setup-action",
          `${prefix}set_store_release_mode.mode must be one of ${PROJECT_STORE_RELEASE_MODES.join(", ")}`,
        );
      }
      return { kind: "set_store_release_mode", mode: raw.mode as ProjectStoreReleaseMode };
    }
    case "set_skill_pack": {
      if (typeof raw.pack !== "string" || !safeId(raw.pack)) {
        throw new FactoryError("invalid-setup-action", `${prefix}set_skill_pack.pack must be a safe identifier`);
      }
      if (typeof raw.enabled !== "boolean") {
        throw new FactoryError("invalid-setup-action", `${prefix}set_skill_pack.enabled must be a boolean`);
      }
      return { kind: "set_skill_pack", pack: raw.pack, enabled: raw.enabled };
    }
    case "set_helper_mcp": {
      if (typeof raw.name !== "string" || ASCII_CONTROL_RE.test(raw.name)) {
        throw new FactoryError(
          "invalid-setup-action",
          `${prefix}set_helper_mcp.name must be a string without control characters`,
        );
      }
      const trimmed = raw.name.trim();
      if (trimmed.length === 0 || trimmed.length > FACTORY_SETUP_MAX_HELPER_MCP_NAME_CHARS) {
        throw new FactoryError(
          "invalid-setup-action",
          `${prefix}set_helper_mcp.name must be 1..${FACTORY_SETUP_MAX_HELPER_MCP_NAME_CHARS} characters`,
        );
      }
      if (typeof raw.enabled !== "boolean") {
        throw new FactoryError("invalid-setup-action", `${prefix}set_helper_mcp.enabled must be a boolean`);
      }
      return { kind: "set_helper_mcp", name: trimmed, enabled: raw.enabled };
    }
    case "sync_open_design": {
      if (typeof raw.projectId !== "string" || !safeId(raw.projectId)) {
        throw new FactoryError(
          "invalid-setup-action",
          `${prefix}sync_open_design.projectId must be a safe identifier`,
        );
      }
      return { kind: "sync_open_design", projectId: raw.projectId };
    }
    case "vault_hydrate": {
      return { kind: "vault_hydrate" };
    }
  }
}

function actionTargetKey(action: FactorySetupAction): string {
  switch (action.kind) {
    case "vault_hydrate":
      return "vault_hydrate";
    case "install_companion":
      return `install_companion:${action.id}`;
    case "set_release_mode":
      return "set_release_mode";
    case "set_store_release_mode":
      return "set_store_release_mode";
    case "set_skill_pack":
      return `set_skill_pack:${action.pack}`;
    case "set_helper_mcp":
      return `set_helper_mcp:${action.name}`;
    case "sync_open_design":
      return "sync_open_design";
  }
}

function actionTieBreakKey(action: FactorySetupAction): string {
  switch (action.kind) {
    case "install_companion":
      return action.id;
    case "set_skill_pack":
      return action.pack;
    case "set_helper_mcp":
      return action.name;
    case "sync_open_design":
      return action.projectId;
    default:
      return canonicalJson(action);
  }
}

function normalizeSetupAction(action: FactorySetupAction): FactorySetupAction {
  switch (action.kind) {
    case "install_companion":
      return { kind: "install_companion", id: action.id };
    case "set_release_mode":
      return action.branch === undefined
        ? { kind: "set_release_mode", mode: action.mode }
        : { kind: "set_release_mode", mode: action.mode, branch: action.branch };
    case "set_store_release_mode":
      return { kind: "set_store_release_mode", mode: action.mode };
    case "set_skill_pack":
      return { kind: "set_skill_pack", pack: action.pack, enabled: action.enabled };
    case "set_helper_mcp":
      return { kind: "set_helper_mcp", name: action.name, enabled: action.enabled };
    case "sync_open_design":
      return { kind: "sync_open_design", projectId: action.projectId };
    case "vault_hydrate":
      return { kind: "vault_hydrate" };
  }
}

/**
 * Validates and normalizes `actions` (1..16 items, per-index errors, strict
 * whitelist/branch/safeId checks, duplicate/conflicting target rejection) and
 * `reason` (trimmed single paragraph, control chars stripped, 1..500 chars).
 */
export function validateFactorySetupInput(rawActions: unknown, rawReason: unknown): ValidatedFactorySetupInput {
  if (!Array.isArray(rawActions)) {
    throw new FactoryError("invalid-setup-actions", "actions must be an array");
  }
  if (rawActions.length === 0) {
    throw new FactoryError("invalid-setup-actions", "actions must contain at least 1 action");
  }
  if (rawActions.length > FACTORY_SETUP_MAX_ACTIONS) {
    throw new FactoryError(
      "invalid-setup-actions",
      `actions must contain at most ${FACTORY_SETUP_MAX_ACTIONS} actions`,
    );
  }

  const reason = sanitizeSetupReason(rawReason);
  const actions: FactorySetupAction[] = [];
  const seenTargets = new Set<string>();

  for (let i = 0; i < rawActions.length; i += 1) {
    const validated = validateActionAtIndex(rawActions[i], i);
    const target = actionTargetKey(validated);
    if (seenTargets.has(target)) {
      throw new FactoryError(
        "setup-action-conflict",
        `actions[${i}]: duplicate or conflicting action for "${target}"`,
      );
    }
    seenTargets.add(target);
    actions.push(validated);
  }

  const canonicalActions = canonicalizeSetupActions(actions);
  const tier = classifySetupBundleTier(canonicalActions);
  const actionsHash = computeSetupActionsHash(canonicalActions);

  return { actions, canonicalActions, actionsHash, tier, reason };
}

/**
 * Sorts a bundle into canonical dependency order with deterministic
 * intra-kind tie-breaking and stripped `undefined` optional fields.
 */
export function canonicalizeSetupActions(actions: readonly FactorySetupAction[]): FactorySetupAction[] {
  return actions
    .map(normalizeSetupAction)
    .sort((a, b) => {
      const rankDiff = CANONICAL_ORDER_RANK[a.kind] - CANONICAL_ORDER_RANK[b.kind];
      if (rankDiff !== 0) return rankDiff;
      const keyDiff = compareCodeUnits(actionTieBreakKey(a), actionTieBreakKey(b));
      if (keyDiff !== 0) return keyDiff;
      return compareCodeUnits(canonicalJson(a), canonicalJson(b));
    });
}

export function classifySetupActionTier(action: FactorySetupAction): FactorySetupTier {
  switch (action.kind) {
    case "vault_hydrate":
    case "set_skill_pack":
    case "sync_open_design":
      return 1;
    case "install_companion":
      return action.id === "factory-skills-pack" ? 1 : 2;
    case "set_release_mode":
    case "set_store_release_mode":
    case "set_helper_mcp":
      return 2;
  }
}

export function classifySetupBundleTier(actions: readonly FactorySetupAction[]): FactorySetupTier {
  return actions.some((action) => classifySetupActionTier(action) === 2) ? 2 : 1;
}

export function formatSetupActionLabel(action: FactorySetupAction): string {
  switch (action.kind) {
    case "install_companion":
      return action.id === "factory-release-lab"
        ? "Install Release Lab (factory-release-lab)"
        : "Install Core Skill Pack (factory-skills-pack)";
    case "set_release_mode":
      return `Set Release mode -> ${action.mode}${action.branch ? ` (branch ${action.branch})` : ""}`;
    case "set_store_release_mode":
      return `Set Store release mode -> ${action.mode}`;
    case "set_skill_pack":
      return `${action.enabled ? "Enable" : "Disable"} skill pack "${action.pack}"`;
    case "set_helper_mcp":
      return `${action.enabled ? "Enable" : "Disable"} Helper MCP "${action.name}"`;
    case "sync_open_design":
      return `Sync Open Design (${action.projectId})`;
    case "vault_hydrate":
      return "Hydrate Private Vault (project-scoped)";
  }
}

export function computeSetupActionsHash(actions: readonly FactorySetupAction[]): string {
  const canonical = canonicalizeSetupActions(actions);
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

/**
 * Strips ANSI escape sequences and control characters, redacts common secret
 * patterns (PEM private keys, Bearer/Basic auth, URL credentials, GitHub/API
 * tokens, env secret assignments), and caps length at `<= maxChars` (default 500).
 */
export function scrubSetupDiagnostic(text: string, maxChars = FACTORY_SETUP_MAX_DIAGNOSTIC_CHARS): string {
  const limit = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : FACTORY_SETUP_MAX_DIAGNOSTIC_CHARS;
  let cleaned = String(text)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(ASCII_CONTROL_GLOBAL_RE, "")
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g, "$1[REDACTED]@")
    .replace(/(https?:\/\/)([^/\s:@]+)@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password|passphrase|auth|access_token)=)([^&\s]+)/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{16,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_KEY]")
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|AUTH_KEY|ASC_KEY[A-Z0-9_]*|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= limit) return cleaned;
  if (limit === 1) return "…";
  let cut = limit - 1;
  const lastCode = cleaned.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut -= 1;
  }
  return `${cleaned.slice(0, cut)}…`;
}

function sanitizeStepResult(step: SetupActionStepResult): SetupActionStepResult {
  const sanitized: SetupActionStepResult = {
    index: step.index,
    action: normalizeSetupAction(step.action),
    tier: step.tier,
    status: step.status,
  };
  if (step.summary !== undefined) {
    sanitized.summary = scrubSetupDiagnostic(step.summary);
  }
  if (step.error !== undefined) {
    sanitized.error = scrubSetupDiagnostic(step.error);
  }
  return sanitized;
}

function isStepResult(value: unknown): value is SetupActionStepResult {
  if (!isPlainObject(value)) return false;
  if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) return false;
  if (value.tier !== 1 && value.tier !== 2) return false;
  if (typeof value.status !== "string" || !STEP_STATUSES.has(value.status)) return false;
  if (value.summary !== undefined && typeof value.summary !== "string") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  try {
    validateActionAtIndex(value.action, value.index as number);
  } catch {
    return false;
  }
  return true;
}

function isSetupProposalRecord(value: unknown): value is SetupProposalRecord {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (typeof value.actionsHash !== "string" || !/^[a-f0-9]{64}$/.test(value.actionsHash)) return false;
  if (typeof value.projectSlug !== "string" || !safeId(value.projectSlug)) return false;
  if (typeof value.status !== "string" || !PROPOSAL_STATUSES.has(value.status)) return false;
  if (typeof value.reason !== "string" || value.reason.trim() === "") return false;
  if (typeof value.createdAt !== "string" || value.createdAt.trim() === "") return false;
  if (typeof value.updatedAt !== "string" || value.updatedAt.trim() === "") return false;
  if (
    value.warnings !== undefined &&
    (!Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string"))
  ) {
    return false;
  }
  if (
    value.supervisorHandoffAgentId !== undefined &&
    (typeof value.supervisorHandoffAgentId !== "string" || value.supervisorHandoffAgentId.trim() === "")
  ) {
    return false;
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0) return false;
  for (let i = 0; i < value.actions.length; i += 1) {
    try {
      validateActionAtIndex(value.actions[i], i);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(value.steps) || !value.steps.every(isStepResult)) return false;
  return true;
}

function isSetupAuditEntry(value: unknown): value is SetupAuditEntry {
  if (!isPlainObject(value)) return false;
  if (typeof value.timestamp !== "string" || value.timestamp.trim() === "") return false;
  if (typeof value.projectSlug !== "string" || !safeId(value.projectSlug)) return false;
  if (value.proposalId !== undefined && (typeof value.proposalId !== "string" || value.proposalId.trim() === "")) {
    return false;
  }
  if (value.actionsHash !== undefined && (typeof value.actionsHash !== "string" || !/^[a-f0-9]{64}$/.test(value.actionsHash))) {
    return false;
  }
  if (value.tier !== 1 && value.tier !== 2) return false;
  if (typeof value.actor !== "string" || !AUDIT_ACTORS.has(value.actor)) return false;
  if (typeof value.reason !== "string" || value.reason.trim() === "") return false;
  if (!Array.isArray(value.steps) || !value.steps.every(isStepResult)) return false;
  return true;
}

export function setupProposalPath(stateDir: string, slug: string): string {
  if (!safeId(slug)) throw new FactoryError("invalid-project-slug", slug);
  return join(projectStateDir(stateDir, slug), "setup-proposal.json");
}

export function setupAuditPath(stateDir: string, slug: string): string {
  if (!safeId(slug)) throw new FactoryError("invalid-project-slug", slug);
  return join(projectStateDir(stateDir, slug), "setup-audit.jsonl");
}

export function readSetupProposal(stateDir: string, slug: string): SetupProposalRecord | undefined {
  const path = setupProposalPath(stateDir, slug);
  const raw = readOptionalJson(path, "setup-proposal-invalid");
  if (raw === undefined) return undefined;
  if (!isSetupProposalRecord(raw) || raw.projectSlug !== slug) {
    throw new FactoryError("setup-proposal-invalid", `setup-proposal-invalid: ${path}`);
  }
  return raw;
}

export function writeSetupProposal(
  stateDir: string,
  slug: string,
  record: SetupProposalRecord,
): SetupProposalRecord {
  const path = setupProposalPath(stateDir, slug);
  if (!isSetupProposalRecord(record) || record.projectSlug !== slug) {
    throw new FactoryError("setup-proposal-invalid", `setup-proposal-invalid: ${path}`);
  }
  const normalized: SetupProposalRecord = {
    schemaVersion: 1,
    id: record.id,
    actionsHash: record.actionsHash,
    projectSlug: record.projectSlug,
    status: record.status,
    reason: record.reason,
    ...(record.warnings !== undefined ? { warnings: [...record.warnings] } : {}),
    ...(record.supervisorHandoffAgentId !== undefined
      ? { supervisorHandoffAgentId: record.supervisorHandoffAgentId }
      : {}),
    actions: record.actions.map(normalizeSetupAction),
    steps: record.steps.map(sanitizeStepResult),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return stateMutation(stateDir, () => {
    atomicJson(path, normalized);
    return normalized;
  });
}

export function clearSetupProposal(stateDir: string, slug: string): boolean {
  const path = setupProposalPath(stateDir, slug);
  return stateMutation(stateDir, () => {
    const existed = existsSync(path);
    rmSync(path, { force: true });
    return existed;
  });
}

export function appendSetupAudit(
  stateDir: string,
  slug: string,
  entry: Omit<SetupAuditEntry, "timestamp"> & { timestamp?: string },
): SetupAuditEntry {
  const path = setupAuditPath(stateDir, slug);
  const normalized: SetupAuditEntry = {
    timestamp: entry.timestamp?.trim() || new Date().toISOString(),
    projectSlug: entry.projectSlug,
    ...(entry.proposalId !== undefined ? { proposalId: entry.proposalId } : {}),
    ...(entry.actionsHash !== undefined ? { actionsHash: entry.actionsHash } : {}),
    tier: entry.tier,
    actor: entry.actor,
    reason: entry.reason,
    steps: entry.steps.map(sanitizeStepResult),
  };
  if (!isSetupAuditEntry(normalized) || normalized.projectSlug !== slug) {
    throw new FactoryError("setup-audit-invalid", `setup-audit-invalid: ${path}`);
  }
  return stateMutation(stateDir, () => {
    makeDurableDirectory(dirname(path));
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(normalized)}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return normalized;
  });
}

export function readSetupAudit(stateDir: string, slug: string): SetupAuditEntry[] {
  const path = setupAuditPath(stateDir, slug);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new FactoryError("setup-audit-invalid", `setup-audit-invalid: ${path}: ${String(error)}`);
  }
  const entries: SetupAuditEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new FactoryError("setup-audit-invalid", `setup-audit-invalid: ${path}:${i + 1}: ${String(error)}`);
    }
    if (!isSetupAuditEntry(parsed) || parsed.projectSlug !== slug) {
      throw new FactoryError("setup-audit-invalid", `setup-audit-invalid: ${path}:${i + 1}`);
    }
    entries.push(parsed);
  }
  return entries;
}

export function clearSetupAudit(stateDir: string, slug: string): boolean {
  const path = setupAuditPath(stateDir, slug);
  return stateMutation(stateDir, () => {
    const existed = existsSync(path);
    rmSync(path, { force: true });
    return existed;
  });
}

function isProposalRunActive(
  activeProposalRuns: ReadonlySet<string> | ReadonlyMap<string, unknown> | undefined,
  slug: string,
  proposalId: string,
): boolean {
  if (activeProposalRuns === undefined) return false;
  if ("get" in activeProposalRuns && typeof activeProposalRuns.get === "function") {
    const bySlug = activeProposalRuns.get(slug);
    if (bySlug !== undefined && bySlug !== false && bySlug !== null) {
      return typeof bySlug === "string" ? bySlug === proposalId : true;
    }
    const byId = activeProposalRuns.get(proposalId);
    return byId !== undefined && byId !== false && byId !== null;
  }
  return activeProposalRuns.has(slug) || activeProposalRuns.has(proposalId);
}

/**
 * Recovers an orphaned `"applying"` setup proposal (no active single-flight
 * runner in `activeProposalRuns`) into `"failed"` so `Retry` or `Dismiss`
 * remains available and `setup-proposal-busy` never wedges after a crash.
 */
export function recoverInterruptedSetupProposal(
  stateDir: string,
  slug: string,
  activeProposalRuns?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  now: () => string = () => new Date().toISOString(),
): SetupProposalRecord | undefined {
  const initial = readSetupProposal(stateDir, slug);
  if (initial === undefined || initial.status !== "applying") return initial;
  if (isProposalRunActive(activeProposalRuns, slug, initial.id)) return initial;

  return stateMutation(stateDir, () => {
    const current = readSetupProposal(stateDir, slug);
    if (current === undefined || current.status !== "applying") return current;
    if (isProposalRunActive(activeProposalRuns, slug, current.id)) return current;

    let markedFailure = false;
    const nextSteps: SetupActionStepResult[] = current.steps.map((step) => {
      if (step.status === "done") return step;
      if (!markedFailure) {
        markedFailure = true;
        return {
          ...step,
          status: "failed",
          error: FACTORY_SETUP_RECOVERED_APPLYING_ERROR,
        };
      }
      return {
        ...step,
        status: "skipped",
      };
    });
    if (!markedFailure && nextSteps.length > 0) {
      const lastIndex = nextSteps.length - 1;
      nextSteps[lastIndex] = {
        ...nextSteps[lastIndex],
        status: "failed",
        error: FACTORY_SETUP_RECOVERED_APPLYING_ERROR,
      };
    }

    const recovered: SetupProposalRecord = {
      ...current,
      status: "failed",
      steps: nextSteps,
      updatedAt: now(),
    };
    atomicJson(setupProposalPath(stateDir, slug), recovered);
    return recovered;
  });
}
