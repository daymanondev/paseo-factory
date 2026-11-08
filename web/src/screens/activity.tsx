/**
 * The Activity screen (T-11a + T-11b, ADR 0051) — the `/activity` route, folded
 * entirely from the existing snapshot: the ledger stream (newest first, the
 * deterministic UTC stamp, the kind the event's own word decides, the task
 * id, and the ledger's own detail line verbatim) with client-side kind
 * filter chips (contract / spawn / claim / gate / accepted / meter / other —
 * a view switch, never an RPC write), the scoped Project's `ledgerError` as
 * the stream's degraded notice, and the usage rollup as the design's usage
 * surface (`design/usage.css` — the four summary stats, the By model bar
 * rows, the By lane bar rows; plain CSS segment bars, never the prototype's
 * SVG-chart JS) with the honest "No usage recorded" when the snapshot
 * carries no rollup. T-11b adds the Retro half — the same design surface
 * rendering `view.retro` newest first (day, outcome, model, the proposal
 * count, each proposal R{id} with its class and text) with the honest "No
 * retros yet" empty — and the screen's ONE write: a "Run retro" button that
 * only a scoped Project offers (the unscoped view carries the muted hint,
 * never a button), behind a confirm dialog naming the Project. The confirm
 * sends exactly `factory.retro {projectRoot}` through the sidecar's NARROWED
 * door — the reply renders verbatim (a written pass names its outcome and
 * proposal count, a refusal or a failed pass renders as data), and a
 * success refreshes the snapshot so the new retro appears. Ratification
 * stays OFF this screen (`factory.retro.ratify` is outside the door — its
 * handler ensures a Supervisor seat, ADR 0017; the Owner's decision is
 * pending), and no Start/Ensure seat control exists anywhere.
 */
import { useState } from "react";
import type { FactoryView, ProjectView } from "../../../plugin/shared/view.ts";
import "../../../design/usage.css";
import { retroViaSidecar, type RetroRunInput, type RetroRunReply } from "../retro.ts";
import {
  activityKindChips,
  activityScreenModel,
  filterLedgerRows,
  type ActivityKindFilter,
  type ActivityLedgerRow,
  type ActivityRetroRow,
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

/** One usage bar row — the design's `.usage-model-row` with a plain CSS segment bar for the prototype's SVG. */
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

/** One rendered retro — its own day, outcome, model, and count, with the R1..Rn proposals beneath. */
function RetroRowView({ row }: { row: ActivityRetroRow }) {
  return (
    <div className="console-activity-retro-row" aria-label={`${row.day} retro ${row.outcome} ${row.model} ${row.proposalCountLabel}`}>
      <div className="console-activity-retro-head">
        <strong>{row.day}</strong>
        <span className={`badge${row.outcome === "written" ? " green" : row.outcome === "failed" ? " red" : ""}`}>{row.outcome}</span>
        <span className="muted mono">{row.model}</span>
        <span className="muted">{row.proposalCountLabel}</span>
      </div>
      {row.proposals.length > 0 ? (
        <div className="console-activity-retro-proposals">
          {row.proposals.map((proposal) => (
            <div key={proposal.label} className="console-activity-retro-proposal">
              <span className="badge cyan">{proposal.label}</span>
              <span className="badge">{proposal.cls}</span>
              <span>{proposal.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="console-activity-retro-none small muted">{row.outcome === "written" ? "The pass proposed nothing — an honest empty read of the corpus." : "No proposals — the pass wrote no file."}</p>
      )}
    </div>
  );
}

// ---- the Run retro confirm (T-11b) ------------------------------------------------------------------

/**
 * The one confirm the Run retro button passes through — it names the scoped
 * Project, states what the pass honestly does (reads the Project's whole
 * recorded history, proposes at most 2 improvements, nothing is law until
 * ratified), and carries the retro lane the pass will run. Cancel, Close,
 * and the overlay send nothing; the confirm button sends exactly
 * `{projectRoot}` through the narrowed `factory.retro` door. The reply
 * renders at the screen's banner — a refusal or a failed pass keeps the
 * dialog for another try, a written pass closes it (the snapshot refreshes
 * behind it so the new retro appears).
 */
function RetroRunDialog({
  project,
  lane,
  submit,
  close,
}: {
  project: ProjectView;
  /** The retro lane the pass will run — the snapshot's own resolved lane for this scope. */
  lane: string;
  submit: () => Promise<RetroRunReply>;
  close: () => void;
}) {
  const [phase, setPhase] = useState<"confirm" | "saving">("confirm");
  const run = async () => {
    setPhase("saving");
    const reply = await submit();
    // Only a WRITTEN pass closes the dialog — a failed pass or a refusal
    // reverts to the confirm step for another try (the reply itself renders
    // at the screen's banner either way).
    if (reply.ok && reply.outcome === "written") close();
    else setPhase("confirm");
  };
  const name = project.name ?? project.slug;
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : close}>
      <div className="dialog console-dialog" role="dialog" aria-modal="true" aria-label={`Run a retro for ${name}?`} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Run a retro for {name}?</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <p>
            The retro pass reads {name}&rsquo;s whole recorded history — the ledger, the reports, and the red gate logs — and proposes at most 2 improvements. Nothing here is law until you ratify it; the factory never applies its own proposals.
          </p>
          <dl className="data-list">
            <div>
              <dt>Project</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>Root</dt>
              <dd className="mono">{project.root}</dd>
            </div>
            <div>
              <dt>Retro lane</dt>
              <dd className="mono">{lane}</dd>
            </div>
          </dl>
          {phase === "confirm" ? (
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={() => void run()}>
                Run retro
              </button>
            </div>
          ) : (
            <p className="small muted" role="status">
              Running the retro…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export interface ActivityScreenProps {
  view: FactoryView;
  /** The retro run transport (T-11b) — the sidecar's narrowed RPC door by default, a fixture in tests. */
  runRetro?: (input: RetroRunInput) => Promise<RetroRunReply>;
  /** Fired after a run the handler answered — the shell refreshes the snapshot so the new retro appears. */
  onChanged?: () => void;
}

export function ActivityScreen({ view, runRetro = retroViaSidecar, onChanged = () => {} }: ActivityScreenProps) {
  const model = activityScreenModel(view);
  const [filter, setFilter] = useState<ActivityKindFilter>("all");
  const rows = filterLedgerRows(model.ledger, filter);
  const chips = activityKindChips(model);
  /** The Run retro confirm — open only while the dialog shows; null is closed. */
  const [confirming, setConfirming] = useState(false);
  /** The last run's reply — both arms render verbatim at the banner. */
  const [status, setStatus] = useState<RetroRunReply | null>(null);
  const run = async (): Promise<RetroRunReply> => {
    const reply = await runRetro({ projectRoot: view.project!.root });
    setStatus(reply);
    if (reply.ok) onChanged();
    return reply;
  };
  const countWord = (count: number | null) => `${count ?? 0} proposal${(count ?? 0) === 1 ? "" : "s"}`;
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
      {status !== null ? (
        status.ok && status.outcome === "written" ? (
          <div className="console-banner console-banner-ok" role="status">
            Running retro — retro written · {countWord(status.proposalCount)} → {status.proposalsPath ?? "?"}
            {status.error === null ? "" : ` · ${status.error}`}. Refreshing…
          </div>
        ) : status.ok ? (
          <div className="console-banner console-banner-error" role="alert">
            Running retro — retro failed — {status.error ?? "no reason"}
          </div>
        ) : (
          <div className="console-banner console-banner-error" role="alert">
            Running retro refused ({status.code}): {status.error}
          </div>
        )
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
      <div className="usage-surface console-activity-retro" aria-label="Retro timeline">
        <div className="usage-section-head">
          <h2>Retro</h2>
          {view.project !== null ? (
            <button type="button" className="btn primary console-activity-retro-run" onClick={() => setConfirming(true)}>
              Run retro
            </button>
          ) : (
            <span className="usage-section-meta">Select a project to run a retro</span>
          )}
        </div>
        {model.retro.rows.length > 0 ? (
          <div className="console-activity-retro-list">
            {model.retro.rows.map((row) => (
              <RetroRowView key={row.seq} row={row} />
            ))}
          </div>
        ) : (
          <div className="usage-empty">
            <h2>No retros yet</h2>
            <p>Each run reads the Project&rsquo;s whole recorded history and proposes at most 2 improvements{view.project !== null ? " — run one with the button above" : ""}.</p>
          </div>
        )}
      </div>
      {confirming && view.project !== null ? (
        <RetroRunDialog project={view.project} lane={view.lanes.retro} close={() => setConfirming(false)} submit={run} />
      ) : null}
    </section>
  );
}
