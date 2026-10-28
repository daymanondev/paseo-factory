/**
 * The Factory surface's RPC contracts (v0.0.13, ADR 0009 §2/§4) — the one
 * vocabulary both halves import. Every method name is `factory.*` (the
 * daemon validates `[a-z][a-z0-9._-]*` and uniqueness); every output is a
 * discriminated union on `ok` so a refusal is data, never an exception
 * (PigMonitor's `Failure` pattern). The handlers run inside the plugin
 * server process that owns the single Factory instance — the in-process
 * single-writer amendment to ADR 0004: Owner acts from the UI invoke
 * `factory.accept(...)`/`factory.retro()` directly, never through the
 * spool.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ImportMaterializationSchema, ImportStatusSchema, FactoryViewSchema, LaneNameSchema, LaneProfileViewSchema, LanesSchema, LanesUpdateSchema, ProjectViewSchema, TaskDetailViewSchema, VaultStatusViewSchema } from "./view.ts";

/** Every handler's refusal shape: a stable machine code plus the human sentence. */
export const Failure = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });

export { ImportStatusSchema } from "./view.ts";

export const snapshot = defineRpc({
  name: "factory.snapshot",
  input: z.object({
    /**
     * The Project scope (v0.0.14, ADR 0010 §1): any directory inside the
     * Project's repository — the workspace panel's dir, or a root picked in
     * the global Project Selector. Omitted, the snapshot is the unscoped
     * global view. An unresolvable path degrades to the global view (the
     * panel must render outside git repos too), never a guess.
     */
    projectRoot: z.string().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), view: FactoryViewSchema }), Failure]),
});

// Method names must match /^[a-z][a-z0-9._-]*$/ (the daemon validates and
// rejects uppercase), so the camelCase ticket spelling `factory.taskDetail`
// ships as `factory.task.detail`.
export const taskDetail = defineRpc({
  name: "factory.task.detail",
  input: z.object({ task: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true), detail: TaskDetailViewSchema }), Failure]),
});

export const accept = defineRpc({
  name: "factory.accept",
  input: z.object({ task: z.string().min(1), attempt: z.number().int().min(1) }),
  output: z.union([z.object({ ok: z.literal(true), seq: z.number().int(), summary: z.string() }), Failure]),
});

export const retro = defineRpc({
  name: "factory.retro",
  input: z.object({
    /**
     * The Project scope (v0.0.38, ADR 0026 §1) — any directory inside the
     * Project's repository. The pass resolves that Project's own `retro` lane
     * override before the machine table; omitted keeps the machine lane.
     */
    projectRoot: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      outcome: z.string(),
      proposalCount: z.number().int().nullable(),
      proposalsPath: z.string().nullable(),
      error: z.string().nullable(),
    }),
    Failure,
  ]),
});

export const lanesSet = defineRpc({
  name: "factory.lanes.set",
  input: z.object({
    lane: LaneNameSchema,
    value: z.string().min(1),
    /** The Project scope — the save targets its override file and the model sync finds its seat agent. */
    projectRoot: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      lanes: z.object({
        supervisor: z.string(),
        lead: z.string(),
        worker: z.string(),
        watch: z.string(),
        retro: z.string(),
        freshEyes: z.string(),
      }),
      /** What the live seat model sync did: applied / skipped (no live seat agent) / failed (reason). */
      modelSync: z.string(),
    }),
    Failure,
  ]),
});

// The atomic batch lane save (v0.0.38, ADR 0026 §1 — the Watch & Retro race
// fix): every lane in `lanes` lands in ONE write, so two cards never race on
// `lanes.json` or the daemon config reload. (The spec's camelCase spelling
// `factory.lanes.setBatch` ships as `factory.lanes.set.batch` — method names
// must match /^[a-z][a-z0-9._-]*$/, the `factory.task.detail` precedent.)
export const lanesSetBatch = defineRpc({
  name: "factory.lanes.set.batch",
  input: z.object({
    /** The lanes to persist — at least one; a refused lane writes nothing, anywhere. */
    lanes: LanesUpdateSchema.refine((update) => Object.values(update).some((value) => value !== undefined), {
      message: "lanes must name at least one lane",
    }),
    /** The Project scope — the batch targets its override file and the seat sync finds its seat agents. */
    projectRoot: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      lanes: LanesSchema,
      /** What the live seat transition did per seat: applied in-place / retired / skipped (no live seat) / failed (reason). */
      modelSync: z.string(),
    }),
    Failure,
  ]),
});

// The per-Project override reset (v0.0.38, ADR 0026 §2): removes the Project's
// `lanes.json` so it inherits the machine table again.
export const lanesReset = defineRpc({
  name: "factory.lanes.reset",
  input: z.object({
    /** The Project whose override file is removed — required; the machine table has nothing to reset. */
    projectRoot: z.string().min(1),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      lanes: LanesSchema,
      /** Whether a `<projectStateDir>/lanes.json` override actually existed and was removed. */
      removed: z.boolean(),
      /** What the live seat transition did per seat: applied in-place / retired / skipped / failed (reason). */
      modelSync: z.string(),
    }),
    Failure,
  ]),
});

// The `Lane profile` CRUD + apply (v0.0.38, ADR 0026 §2/§5) — Owner-authored
// 6-lane presets in `<stateDir>/profiles.json`, applied Copy-on-Apply.
export const profilesSave = defineRpc({
  name: "factory.profiles.save",
  input: z.object({
    /** The profile id — a normalized slug (`[a-z0-9][a-z0-9-_]{0,63}`); omitted derives one from `name`. */
    id: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    /** The 6 lanes whole; omitted saves the scope's current effective table (`projectRoot`'s, else the machine's). */
    lanes: LanesSchema.optional(),
    /** The scope whose CURRENT lanes become the profile when `lanes` is omitted. */
    projectRoot: z.string().optional(),
  }),
  output: z.union([
    z.object({ ok: z.literal(true), profile: LaneProfileViewSchema, summary: z.string() }),
    Failure,
  ]),
});

export const profilesApply = defineRpc({
  name: "factory.profiles.apply",
  input: z.object({
    profileId: z.string().min(1),
    /** The Project scope — omitted applies Copy-on-Apply to the machine table (the "All projects" act). */
    projectRoot: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      lanes: LanesSchema,
      /** What the live seat transition did per seat: applied in-place / retired / skipped / failed (reason). */
      modelSync: z.string(),
    }),
    Failure,
  ]),
});

export const profilesDelete = defineRpc({
  name: "factory.profiles.delete",
  input: z.object({
    profileId: z.string().min(1),
  }),
  output: z.union([
    z.object({ ok: z.literal(true), deleted: z.boolean(), summary: z.string() }),
    Failure,
  ]),
});

export const supervisorEnsure = defineRpc({
  name: "factory.supervisor.ensure",
  input: z.object({
    /** The Project to seat — any directory inside its repository (v0.0.14, ADR 0010 §1). */
    projectRoot: z.string(),
    message: z.string().optional(),
  }),
  output: z.union([
    z.object({ ok: z.literal(true), agentId: z.string(), created: z.boolean(), projectRoot: z.string(), slug: z.string() }),
    Failure,
  ]),
});

export const supervisorRevoke = defineRpc({
  name: "factory.supervisor.revoke",
  input: z.object({
    /** The Project scope; omitted revokes the first live supervisor (the legacy global act). */
    projectRoot: z.string().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), agentId: z.string() }), Failure]),
});

// The Lead seat's lifecycle (v0.0.14, ADR 0010 §2): ensure finds-or-creates
// the standing seat=lead agent at <project-root>; rotate cancels + archives
// it so the next dispatch starts a fresh Lead grounded in the Ledger.
export const leadEnsure = defineRpc({
  name: "factory.lead.ensure",
  input: z.object({ projectRoot: z.string(), message: z.string().optional() }),
  output: z.union([
    z.object({ ok: z.literal(true), agentId: z.string(), created: z.boolean(), projectRoot: z.string(), slug: z.string() }),
    Failure,
  ]),
});

export const leadRotate = defineRpc({
  name: "factory.lead.rotate",
  input: z.object({ projectRoot: z.string() }),
  output: z.union([z.object({ ok: z.literal(true), agentId: z.string() }), Failure]),
});

export const projectReset = defineRpc({
  name: "factory.project.reset",
  input: z.object({
    projectRoot: z.string().optional(),
    project: z.string().optional(),
    keepSeats: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      project: z.string(),
      projectRoot: z.string(),
      purgedEvents: z.number().int(),
      tasks: z.array(z.string()),
      removedFiles: z.number().int(),
      archivedSeats: z.array(z.string()),
      archivedAgents: z.array(z.string()),
      summary: z.string(),
      view: FactoryViewSchema.optional(),
    }),
    Failure,
  ]),
});

export const projectAdd = defineRpc({
  name: "factory.project.add",
  input: z.object({
    projectRoot: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      path: z.string(),
      projectRoot: z.string(),
      slug: z.string(),
      project: ProjectViewSchema,
      bootstrapped: z.boolean(),
      summary: z.string(),
      view: FactoryViewSchema.optional(),
    }),
    Failure,
  ]),
});

export const projectDelete = defineRpc({
  name: "factory.project.delete",
  input: z.object({
    projectRoot: z.string().optional(),
    projectSlug: z.string().optional(),
    project: z.string().optional(),
    seat: z.string().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      project: z.string(),
      projectRoot: z.string(),
      purgedEvents: z.number().int(),
      tasks: z.array(z.string()),
      removedFiles: z.number().int(),
      archivedSeats: z.array(z.string()),
      archivedAgents: z.array(z.string()),
      summary: z.string(),
      view: FactoryViewSchema.optional(),
    }),
    Failure,
  ]),
});

export const projectPickFolder = defineRpc({
  name: "factory.project.pick.folder",
  input: z
    .object({
      prompt: z.string().optional(),
    })
    .optional(),
  output: z.union([
    z.object({
      ok: z.literal(true),
      cancelled: z.literal(true),
      path: z.null(),
    }),
    z.object({
      ok: z.literal(true),
      cancelled: z.literal(false),
      path: z.string(),
      projectRoot: z.string(),
      slug: z.string(),
      project: ProjectViewSchema,
      bootstrapped: z.boolean(),
      summary: z.string(),
      view: FactoryViewSchema.optional(),
    }),
    Failure,
  ]),
});

// The UI's quick dispatch (v0.0.20, ADR 0013 §4): the third internal caller
// of the in-process `enqueueLeadMail()` pipeline — the same door the spool's
// `lead_dispatch` rides (auto-ensure the Lead seat, queue the directive in
// `<projectStateDir>/mailbox.jsonl`, pump the per-Project lane), reached
// from the Factory surface instead of the CLI.
export const leadDispatch = defineRpc({
  name: "factory.lead.dispatch",
  input: z.object({
    /** The Project scope — any directory inside its repository (the seat bridges' law). */
    projectRoot: z.string().optional(),
    /** The registered Project slug — the registry door when no root is at hand. */
    project: z.string().optional(),
    /** Whose act the mail records — the UI's two seats (peers ride the hook, never dispatch). */
    from: z.enum(["supervisor", "owner"]).optional(),
    message: z.string().min(1),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      project: z.string(),
      leadAgentId: z.string(),
      mailId: z.string(),
      rotationState: z.string(),
      summary: z.string(),
    }),
    Failure,
  ]),
});

// Ratify via Supervisor (v0.0.14, ADR 0010 §6): dispatch one Retro proposal
// to the Project's Supervisor to apply to <project-root>/AGENTS.md,
// CONTEXT.md, or Gate config — the two-tier memory loop's Owner act.
export const ratifyProposal = defineRpc({
  name: "factory.retro.ratify",
  input: z.object({ projectRoot: z.string(), day: z.string(), proposalId: z.number().int() }),
  output: z.union([z.object({ ok: z.literal(true), agentId: z.string(), summary: z.string() }), Failure]),
});

// The companion plugin lifecycle (v0.0.17, ADR 0012 §3): install from the
// catalog's canonical GitHub sources (or a developer's custom source/ref —
// never a probed `../` sibling), then manage the five lifecycle acts. Every
// call targets the daemon home serving this surface, and a daemon-side
// failure refuses as data — `{ ok: false, code: "daemon_failed", error }` —
// never an exception.
export const pluginsInstall = defineRpc({
  name: "factory.plugins.install",
  input: z.object({
    /** Target plugin id ("paseo-factory" | "factory-burn-lab" | "factory-release-lab") or "all" for batch install of uninstalled companions. */
    target: z.enum(["paseo-factory", "factory-burn-lab", "factory-release-lab", "all"]),
    /** Optional custom source override (Git source, npm spec, or explicit local directory path). Omitted uses canonicalSource. */
    source: z.string().optional(),
    /** Optional Git branch, tag, or commit ref when installing from a Git source. */
    ref: z.string().optional(),
    mergeLedgers: z.boolean().optional(),
    overwriteConfigs: z.boolean().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), installed: z.array(z.string()), summary: z.string() }), Failure]),
});

export const pluginsManage = defineRpc({
  name: "factory.plugins.manage",
  input: z.object({
    pluginId: z.enum(["paseo-factory", "factory-burn-lab", "factory-release-lab", "all"]),
    action: z.enum(["enable", "disable", "reload", "update", "remove"]),
  }),
  output: z.union([z.object({ ok: z.literal(true), pluginId: z.string(), action: z.string(), summary: z.string() }), Failure]),
});

export const pluginsCheckUpdates = defineRpc({
  name: "factory.plugins.check.updates",
  input: z.object({}),
  output: z.union([
    z.object({
      ok: z.literal(true),
      checkedAt: z.string(),
      updatesAvailable: z.array(z.string()),
      summary: z.string(),
    }),
    Failure,
  ]),
});

// The Private vault surface (v0.0.21, ADR 0014 §4; v0.0.22 unified sync &
// 1-click key import): configure persists the Owner's repo/branch/passphrase
// to the `0o600` `<stateDir>/vault-config.json` and returns the refreshed
// status; hydrate streams the zero-clone Direct hydrate tarball, pull runs
// the two-way Vault sync checkout, push packages this machine's runtime tree
// back to the remote, sync runs the unified smart bidirectional sync (with
// automatic `<ghUser>/factory-vault` creation on unconfigured homes), and
// import seals keys from disk into `vault-runtime/secrets/` and optionally
// syncs. Every refusal is data — the vendored core's own `vault-*`
// FactoryError codes ride the Failure union — never an exception.
export const vaultConfigure = defineRpc({
  name: "factory.vault.configure",
  input: z.object({
    /** The private GitHub `owner/repo` slug (or a local git path for tests). */
    repo: z.string().min(1),
    branch: z.string().min(1),
    /** Absent preserves the persisted passphrase; an empty string clears it. */
    passphrase: z.string().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema, summary: z.string() }), Failure]),
});

export const vaultHydrate = defineRpc({
  name: "factory.vault.hydrate",
  input: z.object({
    /**
     * Repo override for this hydrate — omitted uses the persisted config's
     * repo. On a home with no saved config the override is persisted as the
     * vault config of record (the hydrate that named the repo is the hydrate
     * that configured the home).
     */
    repo: z.string().optional(),
    /** The tarball ref — omitted uses the configured branch. */
    ref: z.string().optional(),
    mergeLedgers: z.boolean().optional(),
    overwriteConfigs: z.boolean().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema, hydratedFiles: z.array(z.string()), summary: z.string(), materialization: ImportMaterializationSchema.optional(), historyImports: z.array(ImportStatusSchema).optional() }), Failure]),
});

export const vaultPull = defineRpc({
  name: "factory.vault.pull",
  input: z.object({
    /** Reconcile the vault's `state/nodes/*` ledger snapshots into this machine's ledgers after hydrating. */
    mergeLedgers: z.boolean().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema, hydratedFiles: z.array(z.string()), summary: z.string(), materialization: ImportMaterializationSchema.optional(), historyImports: z.array(ImportStatusSchema).optional() }), Failure]),
});

export const vaultPush = defineRpc({
  name: "factory.vault.push",
  input: z.object({
    /** Snapshot this machine's ledgers under its node namespace before pushing. */
    includeLedgers: z.boolean().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema, pushedFiles: z.array(z.string()), summary: z.string() }), Failure]),
});

export const vaultSync = defineRpc({
  name: "factory.vault.sync",
  input: z.object({
    repo: z.string().optional(),
    branch: z.string().optional(),
    passphrase: z.string().optional(),
    mergeLedgers: z.boolean().optional(),
    includeLedger: z.boolean().optional(),
    overwriteConfigs: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      vault: VaultStatusViewSchema,
      materialization: ImportMaterializationSchema.optional(), historyImports: z.array(ImportStatusSchema).optional(),
      createdRepo: z.boolean(),
      hydratedFiles: z.array(z.string()),
      pushedFiles: z.array(z.string()),
      pushed: z.boolean(),
      summary: z.string(),
    }),
    Failure,
  ]),
});

export const vaultImport = defineRpc({
  name: "factory.vault.import",
  input: z.object({
    ascKeyPath: z.string().optional(),
    ascKeyId: z.string().optional(),
    ascIssuer: z.string().optional(),
    gplayKeyPath: z.string().optional(),
    eyeConfigPath: z.string().optional(),
    appKey: z.string().optional(),
    keystorePath: z.string().optional(),
    storePass: z.string().optional(),
    keyAlias: z.string().optional(),
    firebaseProjectId: z.string().optional(),
    googleServicesJsonPath: z.string().optional(),
    googleServiceInfoPlistPath: z.string().optional(),
    syncAfterImport: z.boolean().optional(),
  }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      vault: VaultStatusViewSchema,
      materialization: ImportMaterializationSchema.optional(), historyImports: z.array(ImportStatusSchema).optional(),
      importedFiles: z.array(z.string()),
      pushed: z.boolean(),
      summary: z.string(),
    }),
    Failure,
  ]),
});


export const historyImport = defineRpc({ name: "factory.history.import", input: z.object({ project: z.string().optional(), sources: z.array(z.object({ nodeId: z.string(), lines: z.string() })).optional() }), output: z.object({ ok: z.literal(true), imports: z.array(ImportStatusSchema) }) });
export const historyImports = defineRpc({ name: "factory.history.imports", input: z.object({}), output: z.object({ ok: z.literal(true), imports: z.array(ImportStatusSchema) }) });

export const historyUpgrade = defineRpc({
  name: "factory.history.upgrade",
  input: z.object({ action: z.enum(["preflight", "apply", "resume", "restore"]), transactionId: z.string().optional(), projectSlug: z.string().optional() }),
  output: z.union([z.object({ ok: z.literal(true), result: z.unknown() }), Failure]),
});

export const executionSetMode = defineRpc({
  name: "factory.execution.set-mode",
  input: z.object({ projectRoot: z.string().optional(), mode: z.enum(["slp", "scrum"]) }),
  output: z.union([z.object({ ok: z.literal(true), data: z.unknown() }), Failure]),
});
export const scrumCommand = defineRpc({
  name: "factory.scrum.command",
  input: z.object({ projectRoot: z.string().optional(), operation: z.string(), runId: z.string().optional(), requestId: z.string(), expectedRevision: z.number().int().optional(), payload: z.record(z.string(), z.unknown()).optional() }),
  output: z.union([z.object({ ok: z.literal(true), data: z.unknown() }), Failure]),
});
