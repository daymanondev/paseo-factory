/**
 * The Agents & Models screen (T-08a) — the `/models` placeholder replaced by
 * the selected Project's READ-ONLY roster: one row per role lane (the SLP six
 * or the Scrum roster the data carries), each row's provider/model[:thinking]
 * split, its Machine-default vs Project-override source, and the live seats
 * the daemon binds to it. The saved profile library renders as chips with the
 * active one marked. The prototype's roster interaction design is reused
 * (`design/management.css`'s toolbar, the shared `roster-table` classes); its
 * JS is mock-only and never ported — every write control it carries
 * (Configure, Rotate/Revoke, Apply/Save profile, Reset) is deferred to a
 * later wave, so this screen renders no roster button at all. No Project
 * selected answers an honest empty state; a lane with no live seat renders
 * "Vacant" (the passenger lanes say why), never a fabricated agent.
 */
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/management.css";
import { modelsScreenModel, type ModelsLaneRow, type ModelsSeatChip } from "../models-view.ts";

export interface ModelsScreenProps {
  view: FactoryView;
}

/** One roster row — the prototype's `.role-cell`/`.model-cell` spelling over the fold's row. */
function LaneRow({ row }: { row: ModelsLaneRow }) {
  const external = row.model === "";
  return (
    <tr aria-label={`${row.label}: ${row.raw}, ${row.sourceLabel}`}>
      <td>
        <div className="role-cell">
          <span className="role-avatar" aria-hidden="true">
            {row.label.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{row.label}</strong>
            {row.tier !== "" ? <small>{row.tier}</small> : null}
          </div>
        </div>
      </td>
      <td className="model-cell">
        <strong>{external ? row.raw : row.model}</strong>
        <small>{external ? "External config" : row.provider}</small>
      </td>
      <td className="roster-thinking">
        {row.thinking !== null ? <span className="badge">{row.thinking}</span> : <span className="small muted">—</span>}
      </td>
      <td>
        <span className={`badge${row.source === "override" ? " cyan" : ""}`}>{row.sourceLabel}</span>
      </td>
      <td className="console-models-seats">
        {row.seats.length === 0 ? (
          <span className="small muted">{row.vacantNote ?? "Vacant"}</span>
        ) : (
          row.seats.map((seat) => <SeatBadge key={seat.agentId} seat={seat} />)
        )}
      </td>
    </tr>
  );
}

/** One live seat chip — the agent id and its presence, the Workspace graph's own vocabulary. */
function SeatBadge({ seat }: { seat: ModelsSeatChip }) {
  return (
    <span className={`badge ${seat.state.tone}`} title={seat.title ?? seat.agentId}>
      {seat.agentId} · {seat.state.label}
    </span>
  );
}

export function ModelsScreen({ view }: ModelsScreenProps) {
  const model = modelsScreenModel(view);
  if (model === null) {
    return (
      <section aria-label="Agents & Models">
        <h1>Agents &amp; Models</h1>
        <div className="notice">
          No Project selected — choose one in the Project switcher above, or open a Project from All projects. The roster renders the
          selected Project's lanes and profiles.
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Agents & Models" className="console-models">
      <div className="page-heading">
        <div>
          <h1>Agents &amp; Models</h1>
          <p className="muted">
            {model.scope} · <span>{model.rosterNote}</span>
          </p>
        </div>
      </div>
      {view.daemonError !== null ? (
        <div className="notice" role="status">
          Live seat states are degraded ({view.daemonError}) — the roster renders the last known snapshot.
        </div>
      ) : null}
      <div className="panel profile-strip console-models-profiles" role="group" aria-label="Saved profiles">
        <span className="small muted">{model.mode === "scrum" ? "Scrum Profiles" : "Lane Profiles"}</span>
        {model.profiles.length === 0 ? (
          <span className="small muted">No saved profiles</span>
        ) : (
          model.profiles.map((profile) => (
            <span key={profile.id} className={`filter${profile.active ? " active" : ""}`}>
              {profile.name}
              {profile.active ? " · active" : ""}
            </span>
          ))
        )}
        <span className="spacer" />
        {model.activeProfileModified && model.activeProfileName !== null ? (
          <span className="small muted">Modified from {model.activeProfileName}</span>
        ) : null}
        <span className="small muted">Read-only — editing arrives in a later wave</span>
      </div>
      <div className="panel table-wrap">
        <table className="roster-table console-models-roster">
          <thead>
            <tr>
              <th>Role</th>
              <th>Provider &amp; model</th>
              <th className="roster-thinking">Thinking</th>
              <th>Configuration</th>
              <th>Live seat</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <LaneRow key={row.lane} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
