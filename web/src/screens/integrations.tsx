/**
 * The Integrations screen (T-09a, ADR 0051) — the `/integrations` route's
 * READ-ONLY answer, folded entirely from the existing snapshot: the plugin
 * roster (the Core plugin, the companion tools, the companion catalog —
 * status, version, on-demand update state), the host skill ecosystem's own
 * rows (linked vs available), and the Helper MCP roster (name, transport,
 * connection health), plus the scoped Project's Open Design link and the
 * plugins-checked-at stamp. The interaction design is the prototype's own
 * (`design/management.css` High-Contrast Clean Precision — the
 * `.int-header-bar` tabs, `.integration-card` grid, `.skill-row-clean`
 * list, `.mcp-server-card` grid, `.int-clean-empty`); its JS is mock-only
 * and never ported. Every write stays outside this wave (T-09b): no
 * Install/Manage buttons, no update buttons, no Check-updates, no dialogs —
 * the update state renders as honest text, and an unavailable daemon half
 * renders the degraded line, never a fabricated card.
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/management.css";
import { integrationsScreenModel, type IntegrationsMcpRow, type IntegrationsPluginRow, type IntegrationsSkillRow } from "../integrations-view.ts";

/** The three tabs' own ids — the prototype's vocabulary, a client-side view switch and never an RPC write. */
type IntegrationTab = "plugins" | "skills" | "mcps";

/** One plugin card — the prototype's `.integration-card` minus its configure button (T-09b). */
function PluginCard({ row }: { row: IntegrationsPluginRow }) {
  const update =
    row.updateAvailable === true
      ? `Update available${row.commitsBehind !== null ? ` · ${row.commitsBehind} commit${row.commitsBehind === 1 ? "" : "s"} behind` : ""}`
      : row.updateAvailable === false
        ? "Up to date"
        : null;
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

/** One Helper MCP card — the prototype's `.mcp-server-card` minus its probe/sync buttons (T-09b). */
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

export interface IntegrationsScreenProps {
  view: FactoryView;
}

export function IntegrationsScreen({ view }: IntegrationsScreenProps) {
  const model = integrationsScreenModel(view);
  const [tab, setTab] = useState<IntegrationTab>("plugins");
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
      </div>
      {tab === "plugins" ? (
        model.plugins.length > 0 ? (
          <div className="integration-card-grid">
            {model.plugins.map((row) => (
              <PluginCard key={`${row.id}-core-${row.core}`} row={row} />
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
    </section>
  );
}
