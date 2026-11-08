/**
 * The Activity screen (T-11a, ADR 0051) — the `/activity` route, folded
 * entirely from the existing snapshot: the ledger stream (newest first, the
 * deterministic UTC stamp, the kind the event's own word decides, the task
 * id, and the ledger's own detail line verbatim) with client-side kind
 * filter chips (contract / spawn / claim / gate / accepted / meter / other —
 * a view switch, never an RPC write), the scoped Project's `ledgerError` as
 * the stream's degraded notice, and the usage rollup as the design's usage
 * surface (`design/usage.css` — the four summary stats, the By model bar
 * rows, the By lane bar rows; plain CSS segment bars, never the prototype's
 * SVG-chart JS) with the honest "No usage recorded" when the snapshot
 * carries no rollup. The screen renders NO write buttons: the retro pass
 * (`factory.retro`) and its ratification land in T-11b, live push streaming
 * in a later wave, and no Start/Ensure seat control exists anywhere
 * (ADR 0017).
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/usage.css";
import {
  activityKindChips,
  activityScreenModel,
  filterLedgerRows,
  type ActivityKindFilter,
  type ActivityLedgerRow,
  type ActivityUsagePanel,
  type ActivityUsageRow,
} from "../activity-view.ts";

/** The kind chip's own tone — `accepted` green and the dispatch/meter words amber, the rest plain. */
const KIND_BADGE_TONE: Record<ActivityLedgerRow["kind"], string> = {
  contract: "",
  spawn: "amber",
  claim: "",
  gate: "",
  accepted: "green",
  meter: "amber",
  other: "",
};

/** One stream row — the design's `.ledger-row` with the console's four-column grid (time · kind · task · detail). */
function LedgerRowView({ row, showProject }: { row: ActivityLedgerRow; showProject: boolean }) {
  const tone = KIND_BADGE_TONE[row.kind];
  const attributed = showProject && row.projectSlug !== null;
  return (
    <div className="ledger-row console-activity-row" aria-label={`${row.timeLabel} ${row.kind} ${row.task ?? "workspace"} ${row.detail}`}>
      <span className="muted" title={`seq #${row.seq}${row.projectSlug === null ? "" : ` · ${row.projectSlug}`}`}>
        {row.timeLabel}
      </span>
      <span>
        <span className={`badge${tone === "" ? "" : ` ${tone}`}`}>{row.kindLabel}</span>
      </span>
      <span className="cyan">{row.task ?? "workspace"}</span>
      <span>
        {row.detail}
        {attributed ? <span className="muted console-activity-project"> · {row.projectSlug}</span> : null}
      </span>
    </div>
  );
}

/** One usage bar row — the design's `.usage-model-row` with a plain CSS segment bar for the prototype's SVG. */
function UsageBarRow({ row }: { row: ActivityUsageRow }) {
  return (
    <div
      className="usage-model-row console-activity-usage-row"
      aria-label={`${row.label}: ${row.totalLabel} tokens${row.costLabel === null ? "" : ` · ${row.costLabel} · ${row.sub}`}`}
    >
      <span className="usage-model-identity">
        <strong>{row.label}</strong>
        <small>{row.sub}</small>
      </span>
      <span className="usage-model-chart console-activity-chart" aria-hidden="true">
        <span className="console-activity-seg console-activity-seg-input" style={{ width: `${row.inputShare}%` }} />
        <span className="console-activity-seg console-activity-seg-output" style={{ width: `${row.outputShare}%` }} />
      </span>
      <span className="usage-model-total" title={`${row.totalTokens.toLocaleString("en-US")} recorded tokens`}>
        {row.totalLabel}
      </span>
    </div>
  );
}

/** The usage half — the design's usage surface, or the honest "No usage recorded" empty. */
function UsagePanel({ usage }: { usage: ActivityUsagePanel | null }) {
  if (usage === null) {
    return (
      <div className="usage-surface console-activity-usage">
        <div className="usage-section-head">
          <h2>Token &amp; cost usage</h2>
        </div>
        <div className="usage-empty">
          <h2>No usage recorded</h2>
          <p>Usage appears here when the selected Project&rsquo;s sessions report tokens — choose a Project in the switcher for its rollup.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="usage-surface console-activity-usage">
      <div className="usage-section-head">
        <h2>Token &amp; cost usage</h2>
        <span className="usage-section-meta">
          {usage.totals.sessionCount} session{usage.totals.sessionCount === 1 ? "" : "s"} · {usage.totals.turns.toLocaleString("en-US")} turns · cache-hit{" "}
          {usage.totals.cacheHitLabel} · updated {usage.updatedAtLabel}
          {usage.backfilled ? " · history backfilled" : ""}
        </span>
      </div>
      <dl className="usage-summary">
        <div className="usage-stat">
          <dt>Total tokens</dt>
          <dd>{usage.totals.totalLabel}</dd>
        </div>
        <div className="usage-stat usage-stat-input">
          <dt>
            Input<small>Includes cached</small>
          </dt>
          <dd>{usage.totals.inputLabel}</dd>
        </div>
        <div className="usage-stat usage-stat-output">
          <dt>Output</dt>
          <dd>{usage.totals.outputLabel}</dd>
        </div>
        <div className="usage-stat">
          <dt>Cost</dt>
          <dd>{usage.totals.costLabel === null ? "—" : usage.totals.costLabel}</dd>
        </div>
      </dl>
      <section aria-labelledby="console-activity-by-model">
        <div className="usage-section-head">
          <h2 id="console-activity-by-model">By model</h2>
          <div className="usage-legend">
            <span>
              <i className="usage-key-input" aria-hidden="true" />
              Input
            </span>
            <span>
              <i className="usage-key-output" aria-hidden="true" />
              Output
            </span>
          </div>
        </div>
        {usage.byModel.length > 0 ? (
          <div className="usage-model-list">
            {usage.byModel.map((row) => (
              <UsageBarRow key={row.id} row={row} />
            ))}
          </div>
        ) : (
          <div className="console-activity-usage-empty muted">No model rows in the rollup.</div>
        )}
      </section>
      <section className="usage-agent-section" aria-labelledby="console-activity-by-lane">
        <div className="usage-section-head">
          <h2 id="console-activity-by-lane">By lane</h2>
        </div>
        {usage.bySeat.length > 0 ? (
          <div className="usage-model-list">
            {usage.bySeat.map((row) => (
              <UsageBarRow key={row.id} row={row} />
            ))}
          </div>
        ) : (
          <div className="console-activity-usage-empty muted">No lane rows in the rollup.</div>
        )}
      </section>
      <p className="usage-reporting-note">
        <span>Tokens and costs come from the Project&rsquo;s recorded session rollup — “—” means no session reported dollars. Shares use recorded tokens.</span>
      </p>
    </div>
  );
}

export interface ActivityScreenProps {
  view: FactoryView;
}

export function ActivityScreen({ view }: ActivityScreenProps) {
  const model = activityScreenModel(view);
  const [filter, setFilter] = useState<ActivityKindFilter>("all");
  const rows = filterLedgerRows(model.ledger, filter);
  const chips = activityKindChips(model);
  return (
    <section className="console-activity" aria-label="Activity">
      <div className="page-heading">
        <div>
          <h1>Activity</h1>
          <p className="muted">
            {model.scope} · {model.kindCounts.all} event{model.kindCounts.all === 1 ? "" : "s"} · newest first
          </p>
        </div>
      </div>
      {model.daemonError !== null ? (
        <div className="notice" role="status">
          Live activity states are degraded ({model.daemonError}) — the screen renders the last known snapshot.
        </div>
      ) : null}
      {model.ledgerError !== null ? (
        <div className="notice" role="status">
          The Project ledger could not be opened ({model.ledgerError}) — the stream renders empty until it reads again.
        </div>
      ) : null}
      <div className="toolbar">
        <span className="small muted">
          Showing {rows.length} of {model.kindCounts.all} entries
        </span>
        <div className="filters" role="group" aria-label="Event kinds">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`filter${filter === chip.id ? " active" : ""}`}
              aria-pressed={filter === chip.id}
              disabled={chip.id !== "all" && chip.count === 0}
              onClick={() => setFilter(chip.id)}
            >
              {chip.label} <span>{chip.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="panel content-card" aria-label="Ledger stream">
        {rows.length > 0 ? (
          rows.map((row) => <LedgerRowView key={`${row.projectSlug ?? "project"}#${row.seq}`} row={row} showProject={view.project === null} />)
        ) : (
          <div className="empty">
            <h3>No ledger events in this scope</h3>
            <p>The stream lights up when the Factory writes its first line{filter === "all" ? "" : " — try another kind chip"}.</p>
          </div>
        )}
      </div>
      <UsagePanel usage={model.usage} />
    </section>
  );
}
