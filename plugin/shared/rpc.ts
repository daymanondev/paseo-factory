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
import { FactoryViewSchema, LaneNameSchema, TaskDetailViewSchema, VaultStatusViewSchema } from "./view.ts";

/** Every handler's refusal shape: a stable machine code plus the human sentence. */
export const Failure = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });

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
  input: z.object({}),
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
    /** Target companion id ("factory-burn-lab" | "factory-connector") or "all" for batch install of uninstalled companions. */
    target: z.enum(["factory-burn-lab", "factory-connector", "factory-release-lab", "all"]),
    /** Optional custom source override (Git source, npm spec, or explicit local directory path). Omitted uses canonicalSource. */
    source: z.string().optional(),
    /** Optional Git branch, tag, or commit ref when installing from a Git source. */
    ref: z.string().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), installed: z.array(z.string()), summary: z.string() }), Failure]),
});

export const pluginsManage = defineRpc({
  name: "factory.plugins.manage",
  input: z.object({
    pluginId: z.enum(["factory-burn-lab", "factory-connector", "factory-release-lab"]),
    action: z.enum(["enable", "disable", "reload", "update", "remove"]),
  }),
  output: z.union([z.object({ ok: z.literal(true), pluginId: z.string(), action: z.string(), summary: z.string() }), Failure]),
});

// The Private vault surface (v0.0.21, ADR 0014 §4): configure persists the
// Owner's repo/branch/passphrase to the `0o600` `<stateDir>/vault-config.json`
// and returns the refreshed status; hydrate streams the zero-clone Direct
// hydrate tarball, pull runs the two-way Vault sync checkout, push packages
// this machine's runtime tree back to the remote. Every refusal is data —
// the vendored core's own `vault-*` FactoryError codes ride the Failure
// union — never an exception.
export const vaultConfigure = defineRpc({
  name: "factory.vault.configure",
  input: z.object({
    /** The private GitHub `owner/repo` slug (or a local git path for tests). */
    repo: z.string().min(1),
    branch: z.string().min(1),
    /** Absent preserves the persisted passphrase; an empty string clears it. */
    passphrase: z.string().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema }), Failure]),
});

export const vaultHydrate = defineRpc({
  name: "factory.vault.hydrate",
  input: z.object({
    /** One-off repo override — omitted uses the persisted config's repo. */
    repo: z.string().optional(),
    /** The tarball ref — omitted uses the configured branch. */
    ref: z.string().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema, hydratedFiles: z.array(z.string()) }), Failure]),
});

export const vaultPull = defineRpc({
  name: "factory.vault.pull",
  input: z.object({
    /** Reconcile the vault's `state/nodes/*` ledger snapshots into this machine's ledgers after hydrating. */
    mergeLedgers: z.boolean().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema, hydratedFiles: z.array(z.string()) }), Failure]),
});

export const vaultPush = defineRpc({
  name: "factory.vault.push",
  input: z.object({
    /** Snapshot this machine's ledgers under its node namespace before pushing. */
    includeLedgers: z.boolean().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), vault: VaultStatusViewSchema, pushedFiles: z.array(z.string()) }), Failure]),
});
