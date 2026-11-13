import { HandoffProgressSchema } from "./handoff.ts";
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
export const FACTORY_VIEW_VERSION = 4 as const;

/** The five model-bearing roles — mirrors src/lanes.ts (kept by test/lanes.test.ts). */
export const LaneNameSchema = z.enum(["supervisor", "lead", "worker", "watch", "freshEyes"]);
export type LaneName = z.infer<typeof LaneNameSchema>;

export const LanesSchema = z.object({
  supervisor: z.string(),
  lead: z.string(),
  worker: z.string(),
  watch: z.string(),
  freshEyes: z.string(),
});
export type Lanes = z.infer<typeof LanesSchema>;

/** A partial lane table — the batch save's payload (`factory.lanes.setBatch`). */
export const LanesUpdateSchema = z.object({
  supervisor: z.string().optional(),
  lead: z.string().optional(),
  worker: z.string().optional(),
  watch: z.string().optional(),
  freshEyes: z.string().optional(),
});
export type LanesUpdate = z.infer<typeof LanesUpdateSchema>;

/**
 * One Owner-authored `Lane profile` as the Lane Profiles bar reads it
 * (v0.0.38, ADR 0026 §2) — a named 5-lane preset persisted in
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

/** The task counts the fold derives — the poll cadence and the headline read them; no Task list rides the view (ADR 0056). */
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
 * - `closed` — a task_closed exists (v0.5.0, ADR 0054 §5): retired without
 *   acceptance; terminal beside `accepted` and counted in no open/running/
 *   attention tile.
 * - `needs-human` — the latest state marker is a needs_human (a later gate
 *   verdict or acceptance displaces it: an Owner answer wakes the task).
 * - `running` — an attempt is open, or a spawn landed with no verdict since.
 * - `ready-to-accept` — the latest verdict is green and unaccepted.
 * - `red` — the latest verdict is red and unaccepted.
 * - `waiting` — contracted, never run (no attempt and no spawn yet).
 */
export const TaskStatusSchema = z.enum(["accepted", "closed", "needs-human", "running", "ready-to-accept", "red", "waiting"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskViewSchema = z.object({
  task: z.string(),
  workspace: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  ownerEligible: z.boolean().optional(),
  leadEligible: z.boolean().optional(),
  pendingLanding: z.boolean().optional(),
  accepted: z.boolean(),
  acceptedBy: z.string().nullable(),
  /** The clean retirement's own facts (v0.5.0, ADR 0054 §5) — present exactly when `status` is `closed`. */
  closed: z.object({ seq: z.number().int(), at: z.string(), reason: z.string(), by: z.string() }).optional(),
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
  /**
   * The usage rollup's model name for this task (v0.0.87, ADR 0043 §4) — the
   * most recently updated session's model, set even when historical runs
   * landed no `meter_written` line. Unset when the rollup knows nothing.
   */
  usageModel: z.string().nullable().optional(),
  needsHumanReason: z.string().nullable(),
  /** The Peer's SLP disposition from the Contract (ADR 0053 §3); `engineer` when the Contract names none. */
  disposition: z.enum(["engineer", "architect", "reviewer", "scout"]).optional(),
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
  handoffProgress: HandoffProgressSchema.nullable().optional(),
  /** How many mail items wait queued in the Project's `mailbox.jsonl` fold — Lead-only. */
  queuedMailCount: z.number().optional(),
  requiresAttention: z.boolean().nullable(),
  /** Why the daemon flags the agent for attention (`permission`, `error`, `finished`, …) — the panel reads `permission` as a stuck seat. */
  attentionReason: z.string().nullable().optional(),
  /** The daemon's last error line for the agent, when it reported one. */
  lastError: z.string().nullable().optional(),
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
  /** The Project's Ledger could not be opened for the snapshot (v0.0.89) — its stream renders empty; additive, older clients ignore it. */
  ledgerError: z.string().optional(),
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

/**
 * One aggregated usage row (v0.0.87, ADR 0043 §4) — the four disjoint
 * additive buckets plus turns/sessions/cost, the shape the Project Token &
 * Model Usage card, the per-task pills, and the CLI table all render.
 */
export const UsageBucketsSchema = z.object({
  turns: z.number().int(),
  sessionCount: z.number().int(),
  inputUncachedTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
  totalTokens: z.number().int(),
  /** Summed session cost — null when no session reported dollars (never a fabricated zero). */
  totalCostUsd: z.number().nullable(),
});
export type UsageBucketsView = z.infer<typeof UsageBucketsSchema>;

/** One `(provider, model)` row of the By Model / Provider breakdown. */
export const ModelUsageRowSchema = z.object({
  provider: z.string(),
  harness: z.string(),
  model: z.string(),
}).extend(UsageBucketsSchema.shape);
export type ModelUsageRowView = z.infer<typeof ModelUsageRowSchema>;

/** One seat row of the By Seat / Role breakdown. */
export const SeatUsageRowSchema = z.object({
  seat: z.enum(["supervisor", "lead", "agent", "watch"]),
  label: z.string(),
}).extend(UsageBucketsSchema.shape);
export type SeatUsageRowView = z.infer<typeof SeatUsageRowSchema>;

/** One task's aggregated usage across all its Attempts and Peer handoffs — `model` is the card badge. */
export const TaskUsageRowSchema = z.object({
  task: z.string(),
  model: z.string().nullable(),
}).extend(UsageBucketsSchema.shape);
export type TaskUsageRowView = z.infer<typeof TaskUsageRowSchema>;

/** The Project Usage half (v0.0.87, ADR 0043 §4) — the rollup fold of `<projectStateDir>/usage.json`. */
export const ProjectUsageViewSchema = z.object({
  updatedAt: z.string(),
  backfilledAt: z.string().nullable().optional(),
  totals: UsageBucketsSchema,
  byModel: z.array(ModelUsageRowSchema),
  bySeat: z.array(SeatUsageRowSchema),
  byTask: z.array(TaskUsageRowSchema),
});
export type ProjectUsageView = z.infer<typeof ProjectUsageViewSchema>;

/** The whole Factory surface snapshot — one RPC answer, one render. */
export const OpenDesignProjectLinkSchema = z.object({
  projectId: z.string(), projectName: z.string(), designSystemId: z.string().nullable().optional(), directionId: z.string().nullable().optional(),
  sourceUpdatedAt: z.number(), syncedAt: z.string(), digest: z.string(), screenCount: z.number(), files: z.array(z.string()),
});
/** Credential-free Helper MCP status displayed to the Owner and coordination seats. */
export const HelperMcpViewSchema = z.object({
  name: z.string(), transport: z.enum(["stdio", "http"]), enabled: z.boolean(),
  targetProviders: z.array(z.enum(["pi", "claude", "codex", "opencode"])),
  vaultSync: z.boolean(),
  sources: z.array(z.enum(["antigravity", "pi", "claude", "vault", "factory"])),
  status: z.enum(["connected", "auth_expired", "missing_env", "unreachable", "disabled"]),
  statusDetail: z.string().optional(), oauthExpiresAt: z.number().optional(),
});

export type HelperMcpConfigUpdate = Partial<Pick<z.infer<typeof HelperMcpViewSchema>, "enabled" | "targetProviders" | "vaultSync">>;

export const InstalledSkillViewSchema = z.object({
  name: z.string(), pack: z.string(), source: z.string(), revision: z.string().nullable(),
  freshness: z.enum(['up_to_date', 'update_available', 'local']),
  harnesses: z.array(z.object({ name: z.string(), healthy: z.boolean(), available: z.boolean() })),
  roles: z.array(z.string()),
});
export const ProjectSkillPackViewSchema = z.object({
  id: z.string(), label: z.string(), enabled: z.boolean(), autoDetected: z.boolean(),
});
export const HostEcosystemItemViewSchema = z.object({
  id: z.string(), name: z.string(), ecosystem: z.string(), path: z.string().nullable(),
  skills: z.array(z.string()), status: z.enum(['linked', 'available']),
  kind: z.enum(['skill', 'pack', 'plugin']), mcpServers: z.array(z.string()),
});
export const SkillHubViewSchema = z.object({
  totalInstalled: z.number(), upToDateCount: z.number(), updateAvailableCount: z.number(),
  localCustomCount: z.number(), symlinkDriftCount: z.number(),
  installedSkills: z.array(InstalledSkillViewSchema),
  projectPacks: z.array(ProjectSkillPackViewSchema),
  hostCatalog: z.array(HostEcosystemItemViewSchema),
  roleMatrix: z.array(z.object({
    role: z.string(), skills: z.array(z.string()),
  })),
});
export type SkillHubView = z.infer<typeof SkillHubViewSchema>;

// ---- the Project panel view-model (v0.6.0, ADR 0056 §5) ---------------------------------------------

/**
 * The one primary action a Needs-you item carries (spec story 23) — a target the
 * client maps to a jump or a desktop act, never an Accept. The mutating kinds
 * (`install-prerequisites`, `start-supervisor`, `sync-open-design`) are desktop-only
 * on the client; mobile renders a hint to use Paseo Desktop in their place.
 */
export const PanelNeedsYouActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("handoff-supervisor"), label: z.string() }),
  z.object({ kind: z.literal("open-agent"), agentId: z.string(), label: z.string() }),
  z.object({ kind: z.literal("install-prerequisites"), label: z.string() }),
  /** No Supervisor or Lead lives to decide — the way forward is to start the Supervisor. */
  z.object({ kind: z.literal("start-supervisor"), label: z.string() }),
  /** A broken Open Design link is healed by syncing the design again. */
  z.object({ kind: z.literal("sync-open-design"), label: z.string() }),
]);
export type PanelNeedsYouAction = z.infer<typeof PanelNeedsYouActionSchema>;

/** The Owner-actionable item kinds, in the order the list shows them. */
export const PANEL_NEEDS_YOU_KINDS = ["needs-human", "attempt-ceiling", "seat-stuck", "no-supervisor", "supervisor-near-mark", "handoff-stuck", "prerequisites", "open-design-broken"] as const;

export const PanelNeedsYouItemSchema = z.object({
  key: z.string(),
  kind: z.enum(PANEL_NEEDS_YOU_KINDS),
  title: z.string(),
  /** A needs-human question, a gate note, a daemon error line — null when the title says it all. */
  detail: z.string().nullable(),
  /** Always one action — when no seat lives to resolve the item, it is Start Supervisor. */
  action: PanelNeedsYouActionSchema,
});
export type PanelNeedsYouItem = z.infer<typeof PanelNeedsYouItemSchema>;

/** Colour is for exceptions: `normal` draws no pill, `waiting` is amber, `error` is red. */
export const PanelToneSchema = z.enum(["normal", "waiting", "error"]);
export type PanelTone = z.infer<typeof PanelToneSchema>;

export const PanelSeatRowSchema = z.object({
  role: z.enum(["supervisor", "lead"]),
  vacant: z.boolean(),
  agentId: z.string().nullable(),
  /** Plain-language status — working, idle, error, waiting for permission. */
  statusLabel: z.string(),
  tone: PanelToneSchema,
  model: z.string().nullable(),
  /** The vacancy sentence (or a daemon error line for a live seat); null otherwise. */
  hint: z.string().nullable(),
  /** The Lead's context-window reading against the 128k handoff mark — Lead only. */
  context: z.object({ usedTokens: z.number().nullable(), markTokens: z.number(), label: z.string(), fraction: z.number().nullable() }).nullable(),
  /** The Lead handoff state in words, with the queued mail count — Lead only. */
  handoff: z.object({ state: z.enum(["normal", "rotation_pending", "handing_over"]), label: z.string(), queuedMailCount: z.number().int() }).nullable(),
});
export type PanelSeatRow = z.infer<typeof PanelSeatRowSchema>;

/**
 * One Supervisor candidate chat (v0.6.1, ADR 0057 §5) — a live chat in the
 * Project's workspace the panel offers as "Use this chat as Supervisor"
 * (`factory.supervisor.adopt`) while the old Supervisor still lives. Rows
 * appear only then; with the seat vacant, the next candidate session binds
 * itself through the auto-bind door.
 */
export const PanelSupervisorCandidateRowSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  statusLabel: z.string(),
  tone: PanelToneSchema,
  model: z.string().nullable(),
});
export type PanelSupervisorCandidateRow = z.infer<typeof PanelSupervisorCandidateRowSchema>;

export const PanelPeerRowSchema = z.object({
  agentId: z.string(),
  task: z.string(),
  /** `Peer · T-08` — the name the Owner reads. */
  title: z.string(),
  disposition: z.enum(["engineer", "architect", "reviewer", "scout"]),
  statusLabel: z.string(),
  tone: PanelToneSchema,
  model: z.string().nullable(),
});
export type PanelPeerRow = z.infer<typeof PanelPeerRowSchema>;

export const PanelOpenDesignSchema = z.object({
  state: z.enum(["unlinked", "linked", "broken"]),
  projectName: z.string().nullable(),
  syncedAt: z.string().nullable(),
  /** Why a link is broken. */
  detail: z.string().nullable(),
});
export type PanelOpenDesign = z.infer<typeof PanelOpenDesignSchema>;

/** What the onboarding wizard needs to know about a folder that is not yet a Project. */
export const PanelOnboardingSchema = z.object({
  folder: z.string().nullable(),
  gitRepo: z.boolean(),
  hasCommits: z.boolean(),
  existingLead: z.boolean(),
});
export type PanelOnboarding = z.infer<typeof PanelOnboardingSchema>;

/** The workspace panel's whole world: header, Needs you, Seats, Open Design — or the not-a-Project readiness. */
export const PanelViewSchema = z.object({
  isProject: z.boolean(),
  name: z.string().nullable(),
  summary: z.string(),
  needsYou: z.array(PanelNeedsYouItemSchema),
  seats: z.object({
    supervisor: PanelSeatRowSchema,
    lead: PanelSeatRowSchema,
    peers: z.array(PanelPeerRowSchema),
    /** The Project's Supervisor candidate chats — non-empty only while a live Supervisor holds the seat (v0.6.1, ADR 0057 §5). */
    supervisorCandidates: z.array(PanelSupervisorCandidateRowSchema),
  }).nullable(),
  openDesign: PanelOpenDesignSchema.nullable(),
  onboarding: PanelOnboardingSchema.nullable(),
});
export type PanelView = z.infer<typeof PanelViewSchema>;

// ---- the seat directory (v0.6.1 W4 spike, ADR 0057 §8/§11) ---------------------------------------

/**
 * One live seat in the all-Projects directory (`factory.seats.directory`) —
 * the read-only composer pill's whole world: which Project, which Paseo
 * workspace, which agent, which role, on which lane, how close to the
 * handoff mark. The handoff state is a `null` placeholder in v0.6.1; W9 fills
 * it with the real per-seat progress.
 */
export const SeatDirectoryEntrySchema = z.object({
  /** The owning Project's canonical slug. */
  slug: z.string(),
  /** The Paseo workspace the seat's session lives in — null when the daemon reports none (no pill anchors). */
  workspaceId: z.string().nullable(),
  agentId: z.string(),
  role: z.enum(["supervisor", "lead", "peer"]),
  provider: z.string(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  /** The daemon's live context-window reading — null when it reports none, never a fabricated zero. */
  contextUsedTokens: z.number().nullable(),
  /** The v0.6.1 handoff mark — the flat 128k (W9 makes it follow the model's window). */
  markTokens: z.number().int(),
  /** The handoff-state placeholder — `null` until W9. */
  handoffState: z.string().nullable(),
});
export type SeatDirectoryEntry = z.infer<typeof SeatDirectoryEntrySchema>;

/**
 * One Project row of the directory — the header button's whole world: the
 * Project's root workspace (where the button lands) and the Needs-you count
 * its label carries, folded by the same panel projection the workspace panel
 * renders.
 */
export const ProjectDirectoryEntrySchema = z.object({
  slug: z.string(),
  /** The Project's root workspace id — the registration's, else the live Supervisor's or Lead's; null when none is known. */
  workspaceId: z.string().nullable(),
  /** How many Needs-you items the Project's panel view carries. */
  needsYouCount: z.number().int(),
});
export type ProjectDirectoryEntry = z.infer<typeof ProjectDirectoryEntrySchema>;

export const FactoryViewSchema = z.object({
  /** The Project panel's view-model, projected server-side — the client only renders it (v0.6.0, ADR 0056). */
  panel: PanelViewSchema,
  skillHub: SkillHubViewSchema.optional(),
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
  agents: z.array(AgentViewSchema),
  providers: z.array(ProviderViewSchema),
  supervisor: AgentViewSchema.nullable(),
  /** The Project's standing Lead agent (v0.0.14, ADR 0010 §2) — null when the seat is vacant. */
  lead: AgentViewSchema.nullable(),
  /** The daemon half's health: null when every daemon read answered. */
  daemonError: z.string().nullable(),
  /** The snapshot's active Project scope — null on the unscoped global view (v0.0.14). */
  project: ProjectViewSchema.nullable(),
  /** The Core plugin (`paseo-factory`) joined with the daemon's plugin list and update check cache (v0.0.25, ADR 0012 §2). */
  corePlugin: CompanionPluginViewSchema,
  /** The companion catalog joined with the daemon's plugin list (v0.0.17, ADR 0012 §2). */
  companions: z.array(CompanionPluginViewSchema),
  /** Host-level companion tools & skill packs (`factory-skills-pack`) inspected per snapshot (ADR 0036 §5). */
  companionTools: z.array(CompanionPluginViewSchema).optional(),
  helperMcps: z.array(HelperMcpViewSchema).optional(),
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
  /**
   * The Project Token Usage half (v0.0.87, ADR 0043 §4) — the scoped
   * Project's rollup fold, null on the unscoped global view or when no
   * session was recorded. Additive optional field on a v3 view: an older
   * client ignores the extra JSON key, so the version stays (the vault
   * field's own precedent).
   */
  projectUsage: ProjectUsageViewSchema.nullable().optional(),
});
export type FactoryView = z.infer<typeof FactoryViewSchema>;
