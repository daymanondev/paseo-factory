/**
 * paseo-factory core — the v0.0.1 verification loop as a plain module.
 *
 * Zero Paseo imports by design: the plugin shell (and anything else) loads
 * this and gets contract → ledger → gate → report. Written once, lives
 * forever (`research/03-hands-on/04-andrew-room.md` §12).
 */
export { createFactory } from "./factory.ts";
export type { Factory, FactoryOptions, ContractInput, ClaimInput, ClaimOutcome, AcceptInput, SpawnInput, SpawnDecision, RespawnInput, RespawnDecision, MeterInput } from "./factory.ts";
export { resolveProject, projectStateDir, readProjectRegistration, writeProjectRegistration, ensureProjectRegistered, listProjectRegistrations, discoverProjects } from "./project.ts";
export type { ProjectResolution, ProjectRegistration } from "./project.ts";
export { resolveClaimedCommit, checkCleanAt, diffBetween, changedFiles, scopeCoversFile, headCommitSync, changesOutsideScope, landTaskWorktree, taskWorktreePath, parseTaskWorktreePath, taskWorktreeBranch, prepareTaskWorktree } from "./workspace.ts";
export type { CommitResolution, TreeCheck, LandingResult, PrepareTaskWorktreeOptions, PrepareTaskWorktreeResult } from "./workspace.ts";
export { Ledger, usageIsValid } from "./ledger.ts";
export { runGate } from "./gate.ts";
export type { GateInput, GateResult } from "./gate.ts";
export { eyeConfigPath, isEyeLaneUsable, loadEyeConfig, resolveEyeLane, runFreshEyesPass, tailWithMarker, parseEyeAnswer } from "./fresh-eyes.ts";
export type { EyeConfig, EyeConfigResult, EyeLaneResolution, FreshEyesOutcome, FreshEyesPassInput, ParsedEyeAnswer } from "./fresh-eyes.ts";
export {
  WATCH_QUESTIONS,
  buildCodeAnswers,
  buildWatchPrompt,
  renderTimelineTranscript,
  runWatchPass,
  watchLaneAvailable,
} from "./watch.ts";
export type {
  CodeAnswersInput,
  CopilotRunner,
  TimelineFetcher,
  TimelineFetchResult,
  WatchOutcome,
  WatchPassInput,
  WatchQuestion,
  WatchTimelineEntry,
} from "./watch.ts";
export { renderReport } from "./report.ts";
export {
  buildRetroDigest,
  buildRetroPrompt,
  orderForRatification,
  parseRetroProposals,
  renderRetroFile,
  retroDay,
  retroFilePath,
  retroLaneAvailable,
  runRetroPass,
  writtenRetroForDay,
} from "./retro.ts";
export type { ParsedRetro, RetroCorpus, RetroOutcome, RetroPassInput, RetroProposal } from "./retro.ts";
export { FactoryError } from "./errors.ts";
export {
  DEFAULT_LANE,
  EYE_JSON_LANE,
  LANE_NAMES,
  TOOLLESS_OPENCODE_CONFIG,
  defaultLanes,
  laneCliAvailable,
  laneCliInvocation,
  laneError,
  lanesPath,
  loadLanes,
  parseLane,
  projectLanesPath,
  runLaneCli,
  saveLanes,
} from "./lanes.ts";
export type { LaneCliInvocation, LaneCliRunner, LaneName, Lanes, LanesResult, ParsedLane } from "./lanes.ts";
export { provisionPiAgentHome, renderRoleAppendSystem } from "./pi-home.ts";
export type { PiAgentRole, ProvisionPiHomeOptions } from "./pi-home.ts";
export {
  FOOTER_MARK,
  ROLE_SKILL_INDEX,
  SEAT_TITLES,
  renderRoleContract,
  renderSeatBootstrapPrompt,
  skillFooter,
} from "./roles-contract.ts";
export type { ProjectIdentity, RoleContractOptions, RoleName, SeatBootstrapInput, SeatName } from "./roles-contract.ts";
export { ensureFactorySkill, ensureFactorySkillSafe, factorySkillPath, renderFactorySkill } from "./skill.ts";
export type { FactorySkillInput } from "./skill.ts";
export {
  ackLeadMail,
  ackMailDelivery,
  deliverLeadMail,
  enqueueLeadMail,
  foldLeadMailboxEvents,
  foldMailboxEvents,
  markMailDelivered,
  readLeadMailbox,
  recoverLeadMailbox,
  requeueLeadMail,
  requeueMailDelivery,
} from "./mailbox.ts";
export type {
  InFlightDelivery,
  LeadMailFrom,
  LeadMailItem,
  LeadMailKind,
  LeadMailMessage,
  LeadMailboxEvent,
  LeadMailboxState,
  MailAckedEvent,
  MailDeliveredEvent,
  MailKind,
  MailQueuedEvent,
  MailRecipient,
  MailRequeuedEvent,
  MailSource,
} from "./mailbox.ts";
export { buildVaultPath, clearGhAuthCache, createDefaultVaultRunner, ensureLocalGitExcludeAndWorktreeInclude, ensureRemoteVaultRepo, hydrateVaultDirect, importVaultSecrets, loadVaultConfig, parseVaultManifest, probeGhAuth, pullVault, pushVault, readVaultStatus, reconcileVaultLedgers, resolveVaultApps, saveVaultConfig, sealVaultBuffer, syncVault, unsealVaultBuffer } from "./vault.ts";
export type { HydrateVaultDirectOptions, ImportVaultSecretsInput, ImportVaultSecretsResult, PullVaultOptions, PushVaultOptions, ResolvedVaultApp, SyncVaultOptions, SyncVaultResult, VaultConfig, VaultEnvelope, VaultGhAuthStatus, VaultHydrationResult, VaultLedgerSource, VaultManifest, VaultManifestEntry, VaultPushResult, VaultRunner, VaultRunnerCall, VaultRuntimeEnv, VaultStatusView, VaultTransportOptions } from "./vault.ts";
export {
  judgeShellCommand,
  judgeFilePath,
  judgeSeatShellCommand,
  judgeSeatFilePath,
  extractWriteTargets,
  refuseGitArgv,
  refuseSupervisorGitArgv,
  shellTokens,
  writableRootsFor,
  MEMORY_FILES,
  SEAT_MEMORY_WHITELIST,
  SEAT_WRITE_FENCE_MESSAGE,
  isSeatMemoryPathAllowed,
  isSeatMemoryRelativePathAllowed,
} from "./choke.ts";
export type { ChokeDecision, GitRefusal, WritableRoots, MemoryFence, MemoryFileName } from "./choke.ts";
export {
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_OUTPUT_CAP_BYTES,
  REPORT_NOTE_MAX_CHARS,
  EYE_TOTAL_BUDGET_MS,
  EYE_DIFF_MAX_CHARS,
  EYE_GATE_OUTPUT_MAX_CHARS,
  EYE_MAX_TOKENS,
  WATCH_TOTAL_BUDGET_MS,
  WATCH_TIMELINE_MAX_CHARS,
  WATCH_DIFF_MAX_CHARS,
  WATCH_GATE_OUTPUT_MAX_CHARS,
  WATCH_CALLOUT_THRESHOLD,
} from "./constants.ts";
export type {
  Verdict,
  EventName,
  Timestamp,
  LedgerEvent,
  PendingEvent,
  ContractSet,
  ClaimReported,
  GateStarted,
  GateFinished,
  FreshEyesWritten,
  WatchWritten,
  ReportWritten,
  AttemptAccepted,
  PermitAllowed,
  PermitDenied,
  GitBlocked,
  SpawnDispatched,
  SpawnRefused,
  RespawnDispatched,
  RespawnRefused,
  MeterWritten,
  MeterUsage,
  RetroWritten,
} from "./events.ts";
export { EVENT_NAMES, MAX_ATTEMPTS } from "./events.ts";

export { projectTask } from "./task-state.ts";
export type { AcceptanceRole, AttemptState, ReviewState } from "./task-state.ts";
