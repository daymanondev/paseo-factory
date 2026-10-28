/**
 * The Factory surface's view vocabulary (v0.0.13, ADR 0009 §2) — the one
 * shape the client renders and the server folds. Plain JSON only: `shared/`
 * may be imported by both bundles, so it names no SDK surface beyond zod and
 * no node built-in. The `version` literal is the snapshot's compatibility
 * contract — a client that sees a version it does not know says so, never
 * guesses. The server-side fold (ledger → view) lives in
 * plugin/server/view.ts; this file is the wire shape alone.
 */
import { z } from "zod";

/** Bump when the shape changes in a way an older client cannot render. */
export const FACTORY_VIEW_VERSION = 3 as const;

/** The six model-bearing roles — mirrors src/lanes.ts (kept by test/lanes.test.ts). */
export const LaneNameSchema = z.enum(["supervisor", "lead", "worker", "watch", "retro", "freshEyes"]);
export type LaneName = z.infer<typeof LaneNameSchema>;

export const LanesSchema = z.object({
  supervisor: z.string(),
  lead: z.string(),
  worker: z.string(),
  watch: z.string(),
  retro: z.string(),
  freshEyes: z.string(),
});
export type Lanes = z.infer<typeof LanesSchema>;

/** A partial lane table — the batch save's payload (`factory.lanes.setBatch`). */
export const LanesUpdateSchema = z.object({
  supervisor: z.string().optional(),
  lead: z.string().optional(),
  worker: z.string().optional(),
  watch: z.string().optional(),
  retro: z.string().optional(),
  freshEyes: z.string().optional(),
});
export type LanesUpdate = z.infer<typeof LanesUpdateSchema>;

/**
 * One Owner-authored `Lane profile` as the Lane Profiles bar reads it
 * (v0.0.38, ADR 0026 §2) — a named 6-lane preset persisted in
 * `<stateDir>/profiles.json`, always whole (Copy-on-Apply), never a live
 * pointer into a Project's `lanes.json`.
 */
export const LaneProfileViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  lanes: LanesSchema,
  updatedAt: z.string(),
});
export type LaneProfileView = z.infer<typeof LaneProfileViewSchema>;

/** The five header tiles — counts the fold derives, the header just lights. */
export const KpisSchema = z.object({
  needsHuman: z.number().int(),
  running: z.number().int(),
  readyToAccept: z.number().int(),
  accepted: z.number().int(),
  totalCostUsd: z.number(),
  totalTokens: z.number().int(),
});
export type Kpis = z.infer<typeof KpisSchema>;

/** One Watch pass as the detail modal reads it (record-only, always shown). */
const WatchAttemptSchema = z.object({
  outcome: z.string(),
  model: z.string(),
  error: z.string().nullable(),
  maxProbability: z.number().nullable(),
  answers: z.record(z.string(), z.number().nullable()).nullable(),
});

/** One Fresh-eyes pass as the detail modal reads it (advisory, green only). */
const EyeAttemptSchema = z.object({
  outcome: z.string(),
  model: z.string(),
  finding: z.string(),
});

/** One rung of the Attempt Ladder (#1 → #2 → #3). */
export const AttemptViewSchema = z.object({
  n: z.number().int(),
  /** The attempt's latest gate verdict; null while the attempt is still open. */
  verdict: z.enum(["red", "green"]).nullable(),
  /** True between claim and report — the run is in flight. */
  reviewState: z.enum(["off", "pending", "incomplete", "clear", "concern", "failed"]).optional(),
  ownerEligible: z.boolean().optional(),
  leadEligible: z.boolean().optional(),
  open: z.boolean(),
  exit: z.number().int().nullable(),
  note: z.string().nullable(),
  sha: z.string().nullable(),
  /** A respawn_dispatched landed since the previous attempt — the ↻ badge. */
  respawned: z.boolean(),
  /** The Peer agent id that produced this attempt, when recorded on the claim or run events. */
  agentId: z.string().nullable().optional(),
  /** The gate log / report file names in the stateDir, when they exist. */
  gateLog: z.string().nullable(),
  report: z.string().nullable(),
  /** The claim's ts — the swimlane segment's start anchor. */
  claimedAt: z.string().nullable(),
  /** The verdict's ts — the swimlane segment's end anchor. */
  verdictAt: z.string().nullable(),
  watch: WatchAttemptSchema.nullable(),
  eye: EyeAttemptSchema.nullable(),
});
export type AttemptView = z.infer<typeof AttemptViewSchema>;

/**
 * A task's verification-line status — the fold's own state machine over the
 * ledger, so filter chips and KPI tiles agree by construction:
 * - `accepted` — an attempt_accepted exists (the task is closed).
 * - `needs-human` — the latest state marker is a needs_human (a later gate
 *   verdict or acceptance displaces it: an Owner answer wakes the task).
 * - `running` — an attempt is open, or a spawn landed with no verdict since.
 * - `ready-to-accept` — the latest verdict is green and unaccepted.
 * - `red` — the latest verdict is red and unaccepted.
 * - `waiting` — contracted, never run (no attempt and no spawn yet).
 */
export const TaskStatusSchema = z.enum(["accepted", "needs-human", "running", "ready-to-accept", "red", "waiting"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskViewSchema = z.object({
  execution: z.object({ mode: z.literal("scrum"), runId: z.string(), role: z.enum(["pm", "ux", "architect", "dev", "qa"]), configRevision: z.number() }).optional(),
  task: z.string(),
  workspace: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  ownerEligible: z.boolean().optional(),
  leadEligible: z.boolean().optional(),
  pendingLanding: z.boolean().optional(),
  accepted: z.boolean(),
  acceptedBy: z.string().nullable(),
  /** Accepted evidence wins over any later anomalous Attempt. */
  currentAttempt: z.number().optional(),
  verdict: z.enum(["green", "red"]).optional(),
  /** The latest meter/spawn provider string, when a run ever named one. */
  lane: z.string().nullable(),
  /** The latest Peer agent id bound to this task in its current Contract epoch, when known. */
  agentId: z.string().nullable().optional(),
  /** The cost cell's honest states — the Cost read's own law, never a fabricated zero. */
  costState: z.enum(["none", "metered", "subscription", "absent"]),
  costUsd: z.number().nullable(),
  totalTokens: z.number().int().optional(),
  needsHumanReason: z.string().nullable(),
  /** Choke counts for the Evidence Pills: allowed / denied / git blocks. */
  choke: z.object({ allowed: z.number().int(), denied: z.number().int(), blocked: z.number().int() }),
  attempts: z.array(AttemptViewSchema),
  lastSeq: z.number().int(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** One live daemon agent, as the Seat Graph renders it. */
export const AgentViewSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  thinking: z.string().nullable().optional(),
  /** The labels.seat the agent carries — "supervisor" / "lead" for the standing seats. */
  seat: z.string().nullable(),
  /** The factory task this agent is bound to (a ledger claim/spawn/meter named it), when any. */
  task: z.string().nullable(),
  /** The Timeline Oracle's last seqEnd, when the daemon answered. */
  seqEnd: z.number().nullable(),
  /**
   * The Lead telemetry pair (v0.0.20, ADR 0013 §6): the daemon's live
   * `agent.lastUsage` context-window reading — present on the Project's Lead
   * (null when the daemon reports no usage), unset on every other agent.
   * The spec names the pair `z.number().nullable()`; the `.optional()` half
   * is what lets non-Lead agents leave it unset (the `thinking` tri-state
   * precedent) — an older client ignores either shape, so the version stays.
   */
  contextUsedTokens: z.number().nullable().optional(),
  contextMaxTokens: z.number().nullable().optional(),
  /**
   * The Lead rotation state machine's durable state as `project.json` records
   * it (v0.0.20, ADR 0013 §5) — Lead-only; unset when unrecorded (absent
   * reads as "normal").
   */
  rotationState: z.enum(["normal", "rotation_pending", "handing_over"]).optional(),
  /** How many mail items wait queued in the Project's `mailbox.jsonl` fold — Lead-only. */
  queuedMailCount: z.number().optional(),
  requiresAttention: z.boolean().nullable(),
  cwd: z.string().nullable(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

/** One discovered Project (v0.0.14, ADR 0010 §1; v0.0.35, ADR 0024) — the canonical slug and its root, plus optional missingRoot flag. */
export const ProjectViewSchema = z.object({
  slug: z.string(),
  root: z.string(),
  name: z.string().optional(),
  commonDir: z.string().optional(),
  missingRoot: z.boolean().optional(),
  supervisorId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  activeTaskCount: z.number().int().optional(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;
export type ProjectInfo = ProjectView;

/** One thinking option a provider model advertises. */
export const ThinkingOptionViewSchema = z.object({
  id: z.string(),
  label: z.string().nullable().optional(),
});
export type ThinkingOptionView = z.infer<typeof ThinkingOptionViewSchema>;

/** One model entry advertised by a provider. */
export const ProviderModelViewSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  thinkingOptions: z.array(ThinkingOptionViewSchema).nullable().optional(),
  defaultThinkingOptionId: z.string().nullable().optional(),
});
export type ProviderModelView = z.infer<typeof ProviderModelViewSchema>;

/** One provider family the lane picker lists. */
export const ProviderViewSchema = z.object({
  provider: z.string(),
  available: z.boolean(),
  models: z.array(ProviderModelViewSchema).nullable(),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/** One rendered retro: day, outcome, and the R1..Rn proposals parsed out of its file. */
export const RetroViewSchema = z.object({
  seq: z.number().int(),
  day: z.string(),
  outcome: z.string(),
  model: z.string(),
  proposalCount: z.number().int().nullable(),
  proposalsPath: z.string().nullable(),
  proposals: z.array(z.object({ id: z.number().int(), cls: z.string(), text: z.string() })),
});
export type RetroView = z.infer<typeof RetroViewSchema>;

/**
 * One companion plugin's lifecycle state as the daemon reports it (v0.0.17,
 * ADR 0012 §2) — `not_installed` is the fold's own default for a catalog
 * entry the daemon's plugin list does not carry (or cannot be asked for).
 */
export const CompanionStatusSchema = z.enum(["not_installed", "running", "disabled", "failed"]);
export type CompanionStatus = z.infer<typeof CompanionStatusSchema>;

/** How a companion was installed — the daemon's install identity kind. */
export const CompanionInstallKindSchema = z.enum(["git", "directory", "npm"]);
export type CompanionInstallKind = z.infer<typeof CompanionInstallKindSchema>;

/** One Companion (or Core) plugin card — the catalog entry joined with live daemon state and on-demand update status (v0.0.25, ADR 0012 §3–§4). */
export const CompanionPluginViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  description: z.string(),
  canonicalSource: z.string(),
  sidebarLabel: z.string(),
  sidebarIcon: z.string(),
  capabilities: z.array(z.string()),
  /** Who may install this plugin — public open-source or private invite-only (v0.0.30, ADR 0012 §2). */
  access: z.enum(["public", "private"]),
  status: CompanionStatusSchema,
  enabled: z.boolean(),
  installKind: CompanionInstallKindSchema.nullable(),
  installedSource: z.string().nullable(),
  currentRevision: z.string().nullable(),
  /** Installed semantic version from package.json / npm metadata (v0.0.25, ADR 0012 §3) — null when uninstalled or unknown. */
  version: z.string().nullable(),
  /** Latest remote revision from the last on-demand update check (v0.0.25, ADR 0012 §4) — null when unchecked or local. */
  latestRevision: z.string().nullable(),
  /** How many commits behind the remote head the installed checkout is (v0.0.25) — null when unchecked or local. */
  commitsBehind: z.number().int().nullable(),
  /** Whether a remote update is available (`true`), up to date (`false`), or unchecked/local (`null`) (v0.0.25, ADR 0012 §4). */
  updateAvailable: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type CompanionPluginView = z.infer<typeof CompanionPluginViewSchema>;

/** One ledger line for the stream — seq, ts, kind, and a one-line rendering. */
export const LedgerLineViewSchema = z.object({
  seq: z.number().int(),
  ts: z.string(),
  event: z.string(),
  task: z.string().nullable(),
  line: z.string(),
});
export type LedgerLineView = z.infer<typeof LedgerLineViewSchema>;

/**
 * The `Private vault` status half (v0.0.21, ADR 0014 §4) — the zod mirror of
 * the core's `VaultStatusView` (`plugin/server/core/vault.ts`): the
 * `configured`/`repo`/`branch`/`nodeId`/`hasPassphrase`/`cloneExists`/
 * `lastHydratedAt`/`lastHydrateMode`/`lastPushedAt`/`sharedSecrets`/
 * `hydratedApps`/`error` shape the Private Vault (GitHub) card renders. The
 * gather is a pure filesystem probe the snapshot handler owns; this file is
 * the wire shape alone.
 */
export const ImportMaterializationSchema = z.object({ status: z.enum(["pending", "applied", "refused"]), diagnostics: z.array(z.string()) });

export const ImportStatusSchema = z.object({ materialization: ImportMaterializationSchema.optional(), id: z.string(), target: z.string(), status: z.enum(["staged", "pending", "applied", "conflicted"]), added: z.number().optional(), duplicates: z.number().optional(), conflicts: z.array(z.object({ reason: z.string(), sourceId: z.string().optional(), eventId: z.string().optional() })).optional(), diagnostics: z.array(z.string()) });

export const VaultStatusViewSchema = z.object({
  historyImports: z.array(ImportStatusSchema).optional(),
  configured: z.boolean(),
  repo: z.string().nullable(),
  branch: z.string(),
  nodeId: z.string(),
  hasPassphrase: z.boolean(),
  cloneExists: z.boolean(),
  lastHydratedAt: z.string().nullable(),
  lastHydrateMode: z.enum(["direct", "sync"]).nullable(),
  lastPushedAt: z.string().nullable(),
  sharedSecrets: z.object({
    ascKey: z.boolean(),
    ascCredentials: z.boolean(),
    gplayServiceAccount: z.boolean(),
    eyeConfig: z.boolean(),
  }),
  hydratedApps: z.array(z.string()),
  ghInstalled: z.boolean(),
  ghAuthenticated: z.boolean(),
  ghUser: z.string().nullable(),
  suggestedRepo: z.string().nullable(),
  error: z.string().nullable(),
});
export type VaultStatusView = z.infer<typeof VaultStatusViewSchema>;

/** The whole Factory surface snapshot — one RPC answer, one render. */
export const ScrumConfigSchema = z.object({ configRevision: z.number().int().optional(), schemaVersion: z.literal(1), requireUiApproval: z.boolean(), lanes: z.object({ supervisor: z.string(), lead: z.string(), pm: z.string(), ux: z.string(), architect: z.string(), dev: z.string(), qa: z.string(), watch: z.string(), retro: z.string() }) });
export const ExecutionViewSchema = z.object({ selectedMode: z.enum(["slp", "scrum"]), revision: z.number(), pendingMode: z.enum(["slp", "scrum"]).optional(), error: z.string().optional(), config: ScrumConfigSchema.optional(), profiles: z.array(z.object({ id: z.string(), name: z.string(), config: ScrumConfigSchema, updatedAt: z.string() })).optional(), run: z.object({ runId: z.string(), phase: z.string(), revision: z.number(), configRevision: z.number(), config: ScrumConfigSchema, qaResult: z.object({ status: z.string(), productSha: z.string(), confirmedDefects: z.number() }).optional(), fixRounds: z.number(), decisions: z.number(), design: z.object({ revision: z.number(), digest: z.string(), decision: z.string().optional() }).optional() }).optional() });
export type ExecutionView = z.infer<typeof ExecutionViewSchema>;

export const FactoryViewSchema = z.object({
  execution: ExecutionViewSchema.optional(),
  version: z.literal(FACTORY_VIEW_VERSION),
  stateDir: z.string(),
  generatedAt: z.string(),
  lanes: LanesSchema,
  /**
   * The machine-only Lane table (v0.0.38, ADR 0026 §3) — what
   * `Reset to Machine Default` re-inherits and the client's reset gate plans
   * live-seat transitions against (`planLiveSeatTransitions(view.lanes,
   * view.machineLanes, …)`). Additive field on a v3 view: an older client
   * ignores the extra JSON key, so the version stays (the vault field's own
   * precedent). Equals `lanes` on the unscoped machine view.
   */
  machineLanes: LanesSchema,
  kpis: KpisSchema,
  tasks: z.array(TaskViewSchema),
  agents: z.array(AgentViewSchema),
  providers: z.array(ProviderViewSchema),
  supervisor: AgentViewSchema.nullable(),
  /** The Project's standing Lead agent (v0.0.14, ADR 0010 §2) — null when the seat is vacant. */
  lead: AgentViewSchema.nullable(),
  retro: z.array(RetroViewSchema),
  /** The newest lines first, capped — a stream, not a mirror. */
  ledger: z.array(LedgerLineViewSchema),
  /** The daemon half's health: null when every daemon read answered. */
  daemonError: z.string().nullable(),
  /** The snapshot's active Project scope — null on the unscoped global view (v0.0.14). */
  project: ProjectViewSchema.nullable(),
  /** Every discovered Project for the header's Project Selector, slug order. */
  projects: z.array(ProjectViewSchema),
  /** The Core plugin (`paseo-factory`) joined with the daemon's plugin list and update check cache (v0.0.25, ADR 0012 §2). */
  corePlugin: CompanionPluginViewSchema,
  /** The companion catalog joined with the daemon's plugin list (v0.0.17, ADR 0012 §2). */
  companions: z.array(CompanionPluginViewSchema),
  /** ISO timestamp of the last on-demand plugin update check for this daemon home — null when not yet checked (v0.0.25, ADR 0012 §4). */
  pluginsCheckedAt: z.string().nullable(),
  /**
   * The `Private vault` status half (v0.0.21, ADR 0014 §4) — the card's whole
   * world, gathered per snapshot. An additive field on a v3 view: an older
   * client ignores the extra JSON key, so the version stays (the companions
   * field's own precedent).
   */
  vault: VaultStatusViewSchema,
  /**
   * The Owner-authored `Lane profile` library (v0.0.38, ADR 0026 §2/§5) —
   * every profile in `<stateDir>/profiles.json`, name-then-id order. Additive
   * fields on a v3 view: an older client ignores the extra JSON keys, so the
   * version stays (the companions/vault field's own precedent).
   */
  profiles: z.array(LaneProfileViewSchema),
  /**
   * The scope's active `Lane profile` — the recorded `activeProfileByScope`
   * entry when the profile still lives, else a profile whose 6 lanes match
   * `lanes` — null when neither names one.
   */
  activeProfileId: z.string().nullable(),
  /** True when the recorded active profile's lanes differ from `lanes` — the "Modified from <Profile>" state. */
  activeProfileModified: z.boolean(),
  /** True when the scoped Project's own `<projectStateDir>/lanes.json` names at least one lane (v0.0.38, ADR 0026 §2). */
  hasProjectLaneOverride: z.boolean(),
});
export type FactoryView = z.infer<typeof FactoryViewSchema>;

/** One task's full detail — the modal's payload: contract, and per-attempt file contents (tailed). */
export const TaskDetailViewSchema = z.object({
  version: z.literal(FACTORY_VIEW_VERSION),
  task: TaskViewSchema,
  contract: z.object({
    task: z.string(),
    workspace: z.string(),
    gate: z.string(),
    artifact: z.string(),
    scope: z.array(z.string()).nullable(),
    /** The mandated SKILL.md workflows (v0.0.14) — null when the contract names none. */
    skills: z.array(z.string()).nullable(),
    base: z.string().nullable(),
    description: z.string().nullable(),
    watch: z.boolean(),
    freshEyes: z.boolean(),
    by: z.string().nullable(),
  }),
  attempts: z.array(
    z.object({
      n: z.number().int(),
      verdict: z.enum(["red", "green"]).nullable(),
      agentId: z.string().nullable().optional(),
      report: z.string().nullable(),
      gateLog: z.string().nullable(),
    }),
  ),
});
export type TaskDetailView = z.infer<typeof TaskDetailViewSchema>;
