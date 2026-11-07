/**
 * The Agents & Models screen (T-08a + T-08b) — the `/models` roster for the
 * selected Project: one row per role lane (the SLP six or the Scrum roster
 * the data carries), each row's provider/model[:thinking] split, its
 * Machine-default vs Project-override source, and the live seats the daemon
 * binds to it. The saved profile library renders as chips with the active
 * one marked. T-08b adds the three lane writes through the sidecar's
 * allowlisted door — `factory.lanes.set` (a per-row Configure dialog:
 * provider, model ID, thinking level), `factory.lanes.reset` (a destructive
 * confirm that drops the Project override), and `factory.profiles.apply`
 * (the chips, Copy-on-Apply). When the lane being changed has a LIVE bound
 * seat (the T-08a fold), the Configure journey first shows a confirm step
 * saying the live seat's model will change — Cancel sends nothing; the
 * profile chips confirm the same way — the fold carries no profile lane
 * table, so the screen cannot tell which lanes an apply changes and asks
 * first whenever ANY lane holds a live bound seat, naming them. Every
 * reply arm, including refusals, renders verbatim as data; success refreshes
 * the roster. The interaction design is the prototype's own
 * (`design/management.css` toolbar + `design/styles.css` dialog/field
 * classes); its JS is mock-only and never ported. The frozen Scrum run
 * roster stays read-only — its table is not `lanes.json`, the one table
 * these writes target. No Start Supervisor/Lead anywhere (ADR 0017), no
 * Rotate/Revoke, no profile save/delete, no batch — those are later waves.
 * No Project selected answers an honest empty state; a lane with no live
 * seat renders "Vacant" (the passenger lanes say why), never a fabricated
 * agent.
 */
import { useState } from "react";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import "../../../design/management.css";
import { modelsScreenModel, type ModelsLaneRow, type ModelsProfileChip, type ModelsSeatChip } from "../models-view.ts";
import {
  lanesResetViaSidecar,
  lanesSetViaSidecar,
  profilesApplyViaSidecar,
  type LanesResetInput,
  type LanesResetReply,
  type LanesSetInput,
  type LanesSetReply,
  type ProfilesApplyInput,
  type ProfilesApplyReply,
} from "../lanes.ts";

/** Any of the three writes' reply arms — the banner renders whichever landed, verbatim. */
type LaneWriteReply = LanesSetReply | LanesResetReply | ProfilesApplyReply;

/** The success sentence — the handler's own `modelSync` words, with the reset's removed fact ahead of it. */
function writeSentence(reply: LaneWriteReply): string {
  if (!reply.ok) return reply.error;
  return "removed" in reply ? `${reply.removed ? "removed the Project override" : "no Project override existed"} — ${reply.modelSync}` : reply.modelSync;
}

export interface ModelsScreenProps {
  view: FactoryView;
  /** The one-lane save transport — the sidecar RPC door by default, a fixture in tests. */
  lanesSet?: (input: LanesSetInput) => Promise<LanesSetReply>;
  /** The per-Project override reset transport. */
  lanesReset?: (input: LanesResetInput) => Promise<LanesResetReply>;
  /** The Copy-on-Apply profile transport. */
  profilesApply?: (input: ProfilesApplyInput) => Promise<ProfilesApplyReply>;
  /** Fired after a successful write — the shell refreshes the snapshot (and so the roster). */
  onChanged?: () => void;
}

/** One roster row — the prototype's `.role-cell`/`.model-cell` spelling over the fold's row. */
function LaneRow({ row, writable, pending, onConfigure }: { row: ModelsLaneRow; writable: boolean; pending: boolean; onConfigure: (row: ModelsLaneRow) => void }) {
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
      <td className="console-models-actions">
        {writable ? (
          <button type="button" className="btn ghost" aria-label={`Configure ${row.label} lane`} disabled={pending} onClick={() => onConfigure(row)}>
            Configure
          </button>
        ) : null}
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

// ---- the Configure dialog (T-08b) ------------------------------------------------------------------

/** The thinking levels the design's own select offers — "" is the provider default (no `:thinking` suffix). */
const THINKING_LEVELS: readonly { value: string; label: string }[] = [
  { value: "", label: "Provider default" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

/** Rebuilds the lane value from the dialog's three fields — the `provider/model[:thinking]` law the door validates. */
function laneValue(provider: string, model: string, thinking: string): string {
  const head = model.trim() === "" ? provider.trim() : `${provider.trim()}/${model.trim()}`;
  return thinking === "" ? head : `${head}:${thinking}`;
}

/**
 * The Configure journey — the prototype's `configureLane` modal as a real
 * write: provider, model ID, thinking level, Cancel/Save lane. A lane with a
 * LIVE bound seat first passes a confirm step (the prototype's
 * "Confirm live seat impact") that says the live seat's model will change —
 * its Cancel returns to the form and sends nothing. The reply renders at the
 * screen's banner; a refusal keeps the form for another try, a success
 * closes the dialog (the roster refreshes behind it).
 */
function LaneEditDialog({
  row,
  submit,
  close,
}: {
  row: ModelsLaneRow;
  submit: (value: string) => Promise<LanesSetReply>;
  close: () => void;
}) {
  const [provider, setProvider] = useState(row.provider);
  const [model, setModel] = useState(row.model);
  const [thinking, setThinking] = useState(row.thinking ?? "");
  const [phase, setPhase] = useState<"form" | "confirm" | "saving">("form");
  // The row's own thinking spelling stays selectable when it is not one of the design's levels.
  const levels = row.thinking !== null && !THINKING_LEVELS.some((level) => level.value === row.thinking)
    ? [...THINKING_LEVELS, { value: row.thinking, label: row.thinking }]
    : THINKING_LEVELS;
  const value = laneValue(provider, model, thinking);
  const valid = value.trim() !== "";
  const seatLane = row.lane === "supervisor" || row.lane === "lead";

  const save = async () => {
    setPhase("saving");
    const reply = await submit(value);
    if (reply.ok) close();
    else setPhase("form");
  };

  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : close}>
      <div className="dialog console-dialog" role="dialog" aria-modal="true" aria-label={`Configure ${row.label} lane`} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Configure {row.label} Lane</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          {phase === "form" ? (
            <>
              <p>
                Edit the lane's provider, model ID, and thinking level — the value is saved as provider/model[:thinking].{" "}
                {row.seats.length > 0 ? "This lane has a live bound seat; saving asks first." : "The change applies to this Project's own lanes override."}
              </p>
              <div className="field">
                <label htmlFor="lane-provider">Provider</label>
                <input id="lane-provider" value={provider} onChange={(event) => setProvider(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="lane-model">Model ID</label>
                <input id="lane-model" value={model} placeholder="e.g. glm-5.3" onChange={(event) => setModel(event.target.value)} />
                <small>You may also enter a custom model ID; an empty model keeps a one-word external config such as eye.json whole.</small>
                {!valid ? (
                  <span className="error" role="alert">
                    Enter a provider or a model ID before saving.
                  </span>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="lane-thinking">Thinking level</label>
                <select id="lane-thinking" value={thinking} onChange={(event) => setThinking(event.target.value)}>
                  {levels.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
                <small>Available reasoning levels depend on the selected provider and model.</small>
              </div>
              <div className="dialog-actions">
                <button type="button" className="btn ghost" onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!valid}
                  onClick={() => (row.seats.length > 0 ? setPhase("confirm") : void save())}
                >
                  Save lane
                </button>
              </div>
            </>
          ) : null}
          {phase === "confirm" ? (
            <>
              <p>
                <strong>
                  {row.label}: {row.raw} → {value}
                </strong>
              </p>
              <div className="notice" role="status">
                {seatLane ? (
                  <>
                    The live seat's model will change ({row.seats.map((seat) => `${seat.agentId} · ${seat.state.label}`).join(", ")}). The same provider family
                    updates the seat in place, preserving its session; a different family retires it — the next dispatch spawns a fresh seat.
                  </>
                ) : (
                  <>
                    The live agents on this lane ({row.seats.map((seat) => `${seat.agentId} · ${seat.state.label}`).join(", ")}) keep their current session — the
                    new model applies to the next spawned agent.
                  </>
                )}
              </div>
              <div className="dialog-actions">
                <button type="button" className="btn ghost" onClick={() => setPhase("form")}>
                  Cancel
                </button>
                <button type="button" className="btn primary" onClick={() => void save()}>
                  Confirm &amp; Apply
                </button>
              </div>
            </>
          ) : null}
          {phase === "saving" ? <p className="small muted" role="status">Saving…</p> : null}
        </div>
      </div>
    </div>
  );
}

// ---- the Reset dialog (T-08b) ----------------------------------------------------------------------

/**
 * The Reset confirm — the prototype's destructive dialog: restoring the
 * machine defaults removes the Project's own `lanes.json` override. Seat
 * lanes with a live bound seat say the transition law follows (in-place
 * update or retire). Cancel sends nothing.
 */
function LaneResetDialog({
  scope,
  seatNote,
  submit,
  close,
}: {
  scope: string;
  /** The honest seat-impact sentence — null when no seat lane carries a live bound seat. */
  seatNote: string | null;
  submit: () => Promise<LanesResetReply>;
  close: () => void;
}) {
  const [phase, setPhase] = useState<"confirm" | "saving">("confirm");
  const reset = async () => {
    setPhase("saving");
    const reply = await submit();
    if (reply.ok) close();
    else setPhase("confirm");
  };
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : close}>
      <div className="dialog console-dialog" role="dialog" aria-modal="true" aria-label="Reset lane configuration?" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Reset lane configuration?</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <p>
            Restore the machine table defaults for {scope} — the Project's own lane override is removed, every lane inherits the machine table again.
          </p>
          {seatNote !== null ? (
            <div className="notice" role="status">
              {seatNote}
            </div>
          ) : null}
          {phase === "confirm" ? (
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn danger" onClick={() => void reset()}>
                Reset lanes
              </button>
            </div>
          ) : (
            <p className="small muted" role="status">
              Resetting…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- the Apply confirm (T-08b fix-up) ----------------------------------------------------------------

/**
 * The Apply confirm — the profile chips' live-seat step. The fold carries no
 * profile lane table, so the screen cannot tell which lanes an apply changes:
 * whenever ANY lane holds a live bound seat, the apply asks first. The step
 * names every seated lane's live seats, says their model will change, and
 * carries each lane kind's own transition law (in-place update or retire for
 * the seat lanes, next-spawn for the rest). Cancel sends nothing; Confirm &
 * Apply sends exactly `{profileId, projectRoot}`.
 */
function ProfileApplyDialog({
  profile,
  seatedRows,
  submit,
  close,
}: {
  profile: ModelsProfileChip;
  /** Every roster row carrying a live bound seat — the apply's honest blast radius under the fold. */
  seatedRows: readonly ModelsLaneRow[];
  submit: () => Promise<ProfilesApplyReply>;
  close: () => void;
}) {
  const [phase, setPhase] = useState<"confirm" | "saving">("confirm");
  const apply = async () => {
    setPhase("saving");
    const reply = await submit();
    if (reply.ok) close();
    else setPhase("confirm");
  };
  return (
    <div className="console-dialog-overlay" role="presentation" onClick={phase === "saving" ? undefined : close}>
      <div className="dialog console-dialog" role="dialog" aria-modal="true" aria-label={`Apply profile ${profile.name}?`} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Apply profile {profile.name}?</strong>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={close} disabled={phase === "saving"}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <p>Apply the saved profile to this Project — its lane table is copied over the Project's lanes (Copy-on-Apply).</p>
          <div className="notice" role="status">
            <p>
              <strong>Live bound seats — their model will change:</strong>
            </p>
            {seatedRows.map((row) => (
              <p key={row.lane}>
                <strong>{row.label}</strong> — {row.seats.map((seat) => `${seat.agentId} · ${seat.state.label}`).join(", ")}.{" "}
                {row.lane === "supervisor" || row.lane === "lead"
                  ? "The same provider family updates the seat in place, preserving its session; a different family retires it — the next dispatch spawns a fresh seat."
                  : "The live agents keep their current session — the new model applies to the next spawned agent."}
              </p>
            ))}
          </div>
          {phase === "confirm" ? (
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={() => void apply()}>
                Confirm &amp; Apply
              </button>
            </div>
          ) : (
            <p className="small muted" role="status">
              Applying…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- the screen ------------------------------------------------------------------------------------

export function ModelsScreen({
  view,
  lanesSet = lanesSetViaSidecar,
  lanesReset = lanesResetViaSidecar,
  profilesApply = profilesApplyViaSidecar,
  onChanged = () => {},
}: ModelsScreenProps) {
  const model = modelsScreenModel(view);
  const [editing, setEditing] = useState<ModelsLaneRow | null>(null);
  const [resetting, setResetting] = useState(false);
  const [applying, setApplying] = useState<ModelsProfileChip | null>(null);
  const [pending, setPending] = useState(false);
  /** The last write's reply — both arms render verbatim; the dialog acts close on success. */
  const [status, setStatus] = useState<{ act: string; reply: LaneWriteReply } | null>(null);

  if (model === null) {
    return (
      <section aria-label="Agents & Models">
        <h1>Agents &amp; Models</h1>
        <div className="notice">
          No Project selected — choose one in the Project switcher above, or open a Project from All projects. The roster renders the selected Project's lanes and
          profiles.
        </div>
      </section>
    );
  }

  const writable = model.writable && model.projectRoot !== "";
  const run = async <R extends LaneWriteReply>(act: string, write: () => Promise<R>): Promise<R> => {
    setPending(true);
    const reply = await write();
    setPending(false);
    setStatus({ act, reply });
    if (reply.ok) onChanged();
    return reply;
  };

  // The live-seat confirm's own facts, from the fold: the seat lanes carrying bound seats.
  const seatedSeatLanes = model.rows.filter((row) => (row.lane === "supervisor" || row.lane === "lead") && row.seats.length > 0);
  const seatNote =
    seatedSeatLanes.length === 0
      ? null
      : `${seatedSeatLanes.map((row) => row.label).join(" and ")} ${seatedSeatLanes.length === 1 ? "has a" : "have a"} live bound seat — the same provider family updates it in place; a different family retires it for a fresh seat.`;

  // The apply confirm's own facts: the fold carries no profile lane table, so
  // the screen cannot tell which lanes a profile changes — every roster row
  // with a live bound seat is the apply's honest blast radius, and ANY of
  // them makes the apply ask first.
  const seatedRows = model.rows.filter((row) => row.seats.length > 0);

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
      {status !== null ? (
        status.reply.ok ? (
          <div className="console-banner console-banner-ok" role="status">
            {status.act} — {writeSentence(status.reply)}. Refreshing…
          </div>
        ) : (
          <div className="console-banner console-banner-error" role="alert">
            {status.act} refused ({status.reply.code}): {status.reply.error}
          </div>
        )
      ) : null}
      <div className="panel profile-strip console-models-profiles" role="group" aria-label="Saved profiles">
        <span className="small muted">{model.mode === "scrum" ? "Scrum Profiles" : "Lane Profiles"}</span>
        {model.profiles.length === 0 ? (
          <span className="small muted">No saved profiles</span>
        ) : (
          model.profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={`filter${profile.active ? " active" : ""}`}
              aria-label={`Apply profile ${profile.name}`}
              disabled={!writable || pending}
              onClick={() => {
                // The fold cannot tell which lanes this profile changes — a
                // roster with ANY live bound seat asks first; a vacant one applies now.
                if (seatedRows.length > 0) setApplying(profile);
                else void run(`Applying profile ${profile.name}`, () => profilesApply({ profileId: profile.id, projectRoot: model.projectRoot }));
              }}
            >
              {profile.name}
              {profile.active ? " · active" : ""}
            </button>
          ))
        )}
        <span className="spacer" />
        {model.activeProfileModified && model.activeProfileName !== null ? (
          <span className="small muted">Modified from {model.activeProfileName}</span>
        ) : null}
        {writable ? (
          <button
            type="button"
            className="btn ghost"
            disabled={pending || !view.hasProjectLaneOverride}
            title={view.hasProjectLaneOverride ? "Remove the Project's lane override — it inherits the machine table again" : "No Project override to reset"}
            onClick={() => setResetting(true)}
          >
            Reset to Machine Default
          </button>
        ) : (
          <span className="small muted">Run roster frozen — read-only</span>
        )}
      </div>
      {writable ? <div className="notice">Lane changes are copied to this Project. Live seat changes require confirmation.</div> : null}
      <div className="panel table-wrap">
        <table className="roster-table console-models-roster">
          <thead>
            <tr>
              <th>Role</th>
              <th>Provider &amp; model</th>
              <th className="roster-thinking">Thinking</th>
              <th>Configuration</th>
              <th>Live seat</th>
              <th className="console-models-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <LaneRow key={row.lane} row={row} writable={writable} pending={pending} onConfigure={setEditing} />
            ))}
          </tbody>
        </table>
      </div>
      {editing !== null && writable ? (
        <LaneEditDialog
          row={editing}
          close={() => setEditing(null)}
          submit={(value) =>
            run(`Saving the ${editing.label} lane`, () => lanesSet({ lane: editing.lane, value, projectRoot: model.projectRoot }))
          }
        />
      ) : null}
      {resetting && writable ? (
        <LaneResetDialog
          scope={model.scope}
          seatNote={seatNote}
          close={() => setResetting(false)}
          submit={() => run("Resetting lanes", () => lanesReset({ projectRoot: model.projectRoot }))}
        />
      ) : null}
      {applying !== null && writable ? (
        <ProfileApplyDialog
          profile={applying}
          seatedRows={seatedRows}
          close={() => setApplying(null)}
          submit={() => run(`Applying profile ${applying.name}`, () => profilesApply({ profileId: applying.id, projectRoot: model.projectRoot }))}
        />
      ) : null}
    </section>
  );
}
