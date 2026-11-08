/**
 * The Integrations screen (T-09a + T-09b, ADR 0051) — the `/integrations`
 * route, folded entirely from the existing snapshot: the plugin roster (the
 * Core plugin, the companion tools, the companion catalog — status, version,
 * on-demand update state), the host skill ecosystem's own rows (linked vs
 * available), and the Helper MCP roster (name, transport, connection
 * health), plus the scoped Project's Open Design link and the
 * plugins-checked-at stamp. T-09b adds the Owner's plugin writes through the
 * sidecar's allowlisted door — the "Check for updates" probe
 * (`factory.plugins.check.updates`), a per-card canonical-source Install for
 * not-installed companions and tools (`factory.plugins.install`), Update for
 * any card the last check marked (`factory.plugins.manage` update), and
 * Enable/Disable for the catalog companions. EVERY install/manage opens a
 * confirm dialog naming the plugin and the act (the prototype's
 * integration-dialog vocabulary over the console's reused dialog chrome —
 * `design/management.css` card/header classes, `design/styles.css`
 * dialog/facts classes); its JS is mock-only and never ported. Cancel sends
 * nothing; every reply arm, refusals and `daemon_failed` included, renders
 * verbatim as data; a success refreshes the snapshot so the stamp and the
 * update dots land. The door itself (not this screen) narrows what can ever
 * be sent: no remove/reload, no disabling the console's own host plugin, no
 * core install, no custom source/ref or ledger/config override — and no
 * Start/Ensure seat control exists anywhere (ADR 0017).
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/management.css";
import { integrationsScreenModel, type IntegrationsMcpRow, type IntegrationsPluginRow, type IntegrationsSkillRow } from "../integrations-view.ts";
import {
  pluginsCheckUpdatesViaSidecar,
  pluginsInstallViaSidecar,
  pluginsManageViaSidecar,
  type PluginsCheckUpdatesReply,
  type PluginsInstallInput,
  type PluginsInstallReply,
  type PluginsManageInput,
  type PluginsManageReply,
} from "../plugins.ts";

/** The three tabs' own ids — the prototype's vocabulary, a client-side view switch and never an RPC write. */
type IntegrationTab = "plugins" | "skills" | "mcps";

/** One card's Owner acts — each opens the confirm dialog naming the plugin and the act. */
type PluginAct = "install" | "update" | "enable" | "disable";

/** Any of the screen's write replies — the banner renders whichever landed, verbatim. */
type PluginsWriteReply = PluginsCheckUpdatesReply | PluginsInstallReply | PluginsManageReply;

/** The confirm dialog's own spelling of each act — the sentence, the banner's gerund, and the confirm button's word. */
const ACT_WORDS: Record<PluginAct, { verb: string; gerund: string; confirm: string }> = {
  install: { verb: "Install", gerund: "Installing", confirm: "Install plugin" },
  update: { verb: "Update", gerund: "Updating", confirm: "Update plugin" },
  enable: { verb: "Enable", gerund: "Enabling", confirm: "Enable plugin" },
  disable: { verb: "Disable", gerund: "Disabling", confirm: "Disable plugin" },
};

/** The sentence each act's confirm carries under the plugin's name — the honest outcome per act. */
function actNotice(row: IntegrationsPluginRow, act: PluginAct): string {
  switch (act) {
    case "install":
      return `The daemon installs ${row.title} from its canonical source and enables it — the roster refreshes when the install lands.`;
    case "update":
      return `The daemon updates ${row.title} to the latest revision${row.commitsBehind !== null ? ` (${row.commitsBehind} commit${row.commitsBehind === 1 ? "" : "s"} behind)` : ""} — the roster refreshes to the new version.`;
    case "enable":
      return `The daemon enables ${row.title} again — its card returns to Running on the next snapshot.`;
    case "disable":
      return `The daemon disables ${row.title} — the plugin stops serving until it is enabled again. Nothing is removed.`;
  }
}

/** Which acts a card offers — the fold's own facts decide, card kind first (the door narrows the same line). */
function pluginActs(row: IntegrationsPluginRow): readonly PluginAct[] {
  const acts: PluginAct[] = [];
  if (row.kind !== "core" && row.status === "not_installed") acts.push("install");
  if (row.updateAvailable === true) acts.push("update");
  if (row.kind === "companion" && row.status !== "not_installed") acts.push(row.enabled ? "disable" : "enable");
  return acts;
}

/** One plugin card — the prototype's `.integration-card` with its Owner acts (T-09b): Install, Update, Enable/Disable. */
function PluginCard({ row, pending, onAct }: { row: IntegrationsPluginRow; pending: boolean; onAct: (row: IntegrationsPluginRow, act: PluginAct) => void }) {
  const update =
    row.updateAvailable === true
      ? `Update available${row.commitsBehind !== null ? ` · ${row.commitsBehind} commit${row.commitsBehind === 1 ? "" : "s"} behind` : ""}`
      : row.updateAvailable === false
        ? "Up to date"
        : null;
  const acts = pluginActs(row);
  return (
    <article className={`integration-card${row.updateAvailable === true ? " has-update" : ""}`} aria-label={`${row.title} plugin`}>
      <div className="integration-card-top">
        <span className={`integration-item-icon tone-${row.tone}`} aria-hidden="true">
          {row.title.slice(0, 1).toUpperCase()}
        </span>
        <div className="integration-card-title-group">
          <strong>
            {row.title}
            {row.core ? " · Core" : ""}
          </strong>
          <div className="integration-card-submeta">
            <span className="integration-card-status">
              <span className={`dot ${row.statusTone}`} aria-hidden="true" />
              <span>{row.statusLabel}</span>
            </span>
            {row.versionLabel !== null ? (
              <>
                <span className="integration-card-sep" aria-hidden="true">
                  ·
                </span>
                <span className="integration-card-version">{row.versionLabel}</span>
              </>
            ) : null}
            {update !== null ? (
              <>
                <span className="integration-card-sep" aria-hidden="true">
                  ·
                </span>
                <span className={row.updateAvailable === true ? "amber" : "muted"}>{update}</span>
              </>
            ) : null}
          </div>
        </div>
        {acts.length > 0 ? (
          <div className="integration-card-right">
            {acts.map((act) =>
              act === "update" ? (
                <button
                  key={act}
                  type="button"
                  className="integration-card-update-btn"
                  aria-label={`Update ${row.title}`}
                  disabled={pending}
                  onClick={() => onAct(row, act)}
                >
                  <span className="dot amber" aria-hidden="true" />
                  <span>Update</span>
                </button>
              ) : (
                <button key={act} type="button" className="btn ghost" aria-label={`${ACT_WORDS[act].verb} ${row.title}`} disabled={pending} onClick={() => onAct(row, act)}>
                  {ACT_WORDS[act].verb}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
      <p className="integration-card-desc">{row.description}</p>
    </article>
  );
}

/** One skill-ecosystem row — the prototype's `.skill-row-clean` with the Inspect button's slot read-only. */
function SkillRow({ row }: { row: IntegrationsSkillRow }) {
  const detail =
    row.skills.length > 0
      ? `${row.skills.length} skill${row.skills.length === 1 ? "" : "s"} · ${row.skills.join(", ")}`
      : row.mcpServers.length > 0
        ? `MCP servers: ${row.mcpServers.join(", ")}`
        : "No skills listed";
  return (
    <article className="skill-row-clean" aria-label={`${row.name} skills`}>
      <div className="skill-clean-main">
        <span className="skill-clean-icon" aria-hidden="true">
          {row.name.slice(0, 1).toUpperCase()}
        </span>
        <strong className="skill-clean-name">{row.name}</strong>
        <span className="skill-clean-desc">{detail}</span>
      </div>
      <span className="skill-clean-pack">{row.ecosystem}</span>
      <span className="skill-clean-role">{row.kind === "skill" ? "Skill" : row.kind === "pack" ? "Pack" : "Plugin"}</span>
      <div className="skill-clean-action">
        <span className={`badge${row.status === "linked" ? " green" : ""}`}>{row.status === "linked" ? "Linked" : "Available"}</span>
      </div>
    </article>
  );
}

/** One Helper MCP card — the prototype's `.mcp-server-card` minus its probe/sync buttons (T-09c+). */
function McpCard({ row }: { row: IntegrationsMcpRow }) {
  const iconTone = row.statusTone === "green" ? "cyan" : row.statusTone === "amber" ? "coral" : "lime";
  return (
    <article className="mcp-server-card" aria-label={`${row.name} MCP server`}>
      <div className="mcp-clean-top">
        <span className={`integration-item-icon tone-${iconTone}`} aria-hidden="true">
          {row.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="mcp-clean-identity">
          <h3>{row.name}</h3>
          <div className="mcp-clean-submeta">
            <span className="mcp-clean-health" title={row.statusDetail ?? row.statusLabel}>
              <span className={`dot ${row.statusTone}`} aria-hidden="true" />
              <span>{row.statusLabel}</span>
            </span>
            <span className="integration-card-sep" aria-hidden="true">
              ·
            </span>
            <span className="mcp-clean-transport">{row.transport}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

/** The scoped Project's Open Design link — the prototype's design card as a read-only data list. */
function OpenDesignCard({ model }: { model: ReturnType<typeof integrationsScreenModel> }) {
  const link = model.openDesign;
  return (
    <div className="panel content-card console-integrations-design" aria-label="Open Design link">
      <div className="card-top">
        <div>
          <span className="eyebrow">OPEN DESIGN LINK</span>
          <h2>{link === null ? "Not linked" : link.projectName}</h2>
        </div>
        <span className={`badge${link === null ? "" : " cyan"}`}>{link === null ? "Not linked" : "Linked"}</span>
      </div>
      {link === null ? (
        <p>This Project carries no Open Design link in the snapshot — linking lands in a later wave.</p>
      ) : (
        <dl className="data-list">
          <div>
            <dt>Project</dt>
            <dd>{link.projectName}</dd>
          </div>
          <div>
            <dt>Screens</dt>
            <dd>{link.screenCount}</dd>
          </div>
          <div>
            <dt>Synced at</dt>
            <dd>{link.syncedAtLabel}</dd>
          </div>
          <div>
            <dt>Digest</dt>
            <dd className="mono" title={link.digest}>
              {link.digestShort}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

// ---- the plugin act confirm (T-09b) ----------------------------------------------------------------

/**
 * The one confirm EVERY install/manage passes through — it names the plugin
 * and the act, carries the card's own status/version facts, and states the
 * honest outcome. Cancel sends nothing; the confirm button sends exactly the
 * one act's input (a target for install, a pluginId+action for manage). The
 * reply renders at the screen's banner — a refusal keeps the dialog for
 * another try, a success closes it (the snapshot refreshes behind it).
 */
function PluginActDialog({
  row,
  act,
  submit,
  close,
}: {
  row: IntegrationsPluginRow;
  act: PluginAct;
  submit: () => Promise<PluginsWriteReply>;
  close: () => void;
}) {
  const words = ACT_WORDS[act];
  const [phase, setPhase] = useState<"confirm" | "saving">("confirm");
  const run = async () => {
    setPhase("saving");
    const reply = await submit();
    if (reply.ok) close();
    else setPhase("confirm");
  };
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : close}>
      <div className="dialog console-dialog" role="dialog" aria-modal="true" aria-label={`${words.verb} ${row.title}?`} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>
            {words.verb} {row.title}?
          </strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <p>{actNotice(row, act)}</p>
          <dl className="data-list">
            <div>
              <dt>Plugin</dt>
              <dd>{row.id}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{row.statusLabel}</dd>
            </div>
            {row.versionLabel !== null ? (
              <div>
                <dt>Version</dt>
                <dd>{row.versionLabel}</dd>
              </div>
            ) : null}
          </dl>
          {phase === "confirm" ? (
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button type="button" className={`btn ${act === "disable" ? "danger" : "primary"}`} onClick={() => void run()}>
                {words.confirm}
              </button>
            </div>
          ) : (
            <p className="small muted" role="status">
              {words.gerund}…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- the screen ------------------------------------------------------------------------------------

export interface IntegrationsScreenProps {
  view: FactoryView;
  /** The on-demand update check transport — the sidecar RPC door by default, a fixture in tests. */
  pluginsCheckUpdates?: (input: Record<string, never>) => Promise<PluginsCheckUpdatesReply>;
  /** The canonical-source companion install transport (T-09b). */
  pluginsInstall?: (input: PluginsInstallInput) => Promise<PluginsInstallReply>;
  /** The narrowed manage transport (T-09b) — enable/disable/update only. */
  pluginsManage?: (input: PluginsManageInput) => Promise<PluginsManageReply>;
  /** Fired after a successful write — the shell refreshes the snapshot (and so the roster and stamp). */
  onChanged?: () => void;
}

export function IntegrationsScreen({
  view,
  pluginsCheckUpdates = pluginsCheckUpdatesViaSidecar,
  pluginsInstall = pluginsInstallViaSidecar,
  pluginsManage = pluginsManageViaSidecar,
  onChanged = () => {},
}: IntegrationsScreenProps) {
  const model = integrationsScreenModel(view);
  const [tab, setTab] = useState<IntegrationTab>("plugins");
  const [pending, setPending] = useState(false);
  /** The card act awaiting its confirm — null while no dialog is open. */
  const [confirming, setConfirming] = useState<{ row: IntegrationsPluginRow; act: PluginAct } | null>(null);
  /** The last write's reply — both arms render verbatim; the dialog act closes on success. */
  const [status, setStatus] = useState<{ act: string; reply: PluginsWriteReply } | null>(null);

  const run = async <R extends PluginsWriteReply>(act: string, write: () => Promise<R>): Promise<R> => {
    setPending(true);
    const reply = await write();
    setPending(false);
    setStatus({ act, reply });
    if (reply.ok) onChanged();
    return reply;
  };

  const writeOf = (row: IntegrationsPluginRow, act: PluginAct): Promise<PluginsWriteReply> => {
    const sentence = `${ACT_WORDS[act].gerund} ${row.title}`;
    if (act === "install") return run(sentence, () => pluginsInstall({ target: row.id }));
    return run(sentence, () => pluginsManage({ pluginId: row.id, action: act }));
  };

  const tabs: readonly { id: IntegrationTab; label: string; count: number }[] = [
    { id: "plugins", label: "Plugins & tools", count: model.plugins.length },
    { id: "skills", label: "Skills", count: model.skills.length },
    { id: "mcps", label: "MCP servers", count: model.mcps.length },
  ];
  return (
    <section aria-label="Integrations" className="console-integrations">
      <div className="page-heading">
        <div>
          <h1>Integrations</h1>
          <p className="muted">
            {model.scope} · Plugin updates: {model.pluginsCheckedAtLabel}
          </p>
        </div>
      </div>
      {view.daemonError !== null ? (
        <div className="notice" role="status">
          Live integration states are degraded ({view.daemonError}) — the screen renders the last known snapshot.
        </div>
      ) : null}
      {status !== null ? (
        status.reply.ok ? (
          <div className="console-banner console-banner-ok" role="status">
            {status.act} — {status.reply.summary}. Refreshing…
          </div>
        ) : (
          <div className="console-banner console-banner-error" role="alert">
            {status.act} refused ({status.reply.code}): {status.reply.error}
          </div>
        )
      ) : null}
      <div className="int-header-bar">
        <div className="integration-tabs" aria-label="Integration categories">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`integration-tab${tab === entry.id ? " active" : ""}`}
              aria-pressed={tab === entry.id}
              onClick={() => setTab(entry.id)}
            >
              <span>{entry.label}</span>
              <span className="nav-count">{entry.count}</span>
              {entry.id === "plugins" && model.updateCount > 0 ? (
                <span className="integration-tab-update-dot" title={`${model.updateCount} update available`} aria-label={`${model.updateCount} update available`} />
              ) : null}
            </button>
          ))}
        </div>
        {tab === "plugins" ? (
          <div className="int-header-controls">
            <button
              type="button"
              className="btn ghost int-quiet-btn"
              disabled={pending}
              onClick={() => void run("Checking for plugin updates", () => pluginsCheckUpdates({}))}
            >
              Check for updates
            </button>
          </div>
        ) : null}
      </div>
      {tab === "plugins" ? (
        model.plugins.length > 0 ? (
          <div className="integration-card-grid">
            {model.plugins.map((row) => (
              <PluginCard key={`${row.id}-core-${row.core}`} row={row} pending={pending} onAct={(row, act) => setConfirming({ row, act })} />
            ))}
          </div>
        ) : (
          <div className="int-clean-empty">
            <p>No plugins discovered in the snapshot.</p>
          </div>
        )
      ) : null}
      {tab === "skills" ? (
        model.skills.length > 0 ? (
          <div className="skills-clean-list">
            {model.skills.map((row) => (
              <SkillRow key={row.id} row={row} />
            ))}
          </div>
        ) : (
          <div className="int-clean-empty">
            <p>No skill ecosystems discovered on this host.</p>
          </div>
        )
      ) : null}
      {tab === "mcps" ? (
        model.mcps.length > 0 ? (
          <div className="mcp-card-grid">
            {model.mcps.map((row) => (
              <McpCard key={row.name} row={row} />
            ))}
          </div>
        ) : (
          <div className="int-clean-empty">
            <p>No Helper MCP servers discovered.</p>
          </div>
        )
      ) : null}
      <OpenDesignCard model={model} />
      {confirming !== null ? (
        <PluginActDialog
          row={confirming.row}
          act={confirming.act}
          close={() => setConfirming(null)}
          submit={() => writeOf(confirming.row, confirming.act)}
        />
      ) : null}
    </section>
  );
}
