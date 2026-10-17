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

/** The five header tiles — counts the fold derives, the header just lights. */
export const KpisSchema = z.object({
  needsHuman: z.number().int(),
  running: z.number().int(),
  readyToAccept: z.number().int(),
  accepted: z.number().int(),
  totalCostUsd: z.number(),
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
  open: z.boolean(),
  exit: z.number().int().nullable(),
  note: z.string().nullable(),
  sha: z.string().nullable(),
  /** A respawn_dispatched landed since the previous attempt — the ↻ badge. */
  respawned: z.boolean(),
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
  task: z.string(),
  workspace: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  accepted: z.boolean(),
  acceptedBy: z.string().nullable(),
  /** The latest meter/spawn provider string, when a run ever named one. */
  lane: z.string().nullable(),
  /** The cost cell's honest states — the Cost read's own law, never a fabricated zero. */
  costState: z.enum(["none", "metered", "subscription", "absent"]),
  costUsd: z.number().nullable(),
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
  requiresAttention: z.boolean().nullable(),
  cwd: z.string().nullable(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

/** One discovered Project (v0.0.14, ADR 0010 §1) — the canonical slug and its root. */
export const ProjectViewSchema = z.object({
  slug: z.string(),
  root: z.string(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

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

/** One Companion plugin card — the catalog entry joined with live daemon state. */
export const CompanionPluginViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  description: z.string(),
  canonicalSource: z.string(),
  sidebarLabel: z.string(),
  sidebarIcon: z.string(),
  capabilities: z.array(z.string()),
  status: CompanionStatusSchema,
  enabled: z.boolean(),
  installKind: CompanionInstallKindSchema.nullable(),
  installedSource: z.string().nullable(),
  currentRevision: z.string().nullable(),
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

/** The whole Factory surface snapshot — one RPC answer, one render. */
export const FactoryViewSchema = z.object({
  version: z.literal(FACTORY_VIEW_VERSION),
  stateDir: z.string(),
  generatedAt: z.string(),
  lanes: LanesSchema,
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
  /** The companion catalog joined with the daemon's plugin list (v0.0.17, ADR 0012 §2). */
  companions: z.array(CompanionPluginViewSchema),
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
      report: z.string().nullable(),
      gateLog: z.string().nullable(),
    }),
  ),
});
export type TaskDetailView = z.infer<typeof TaskDetailViewSchema>;
