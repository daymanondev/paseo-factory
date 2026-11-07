/**
 * The Task Detail body (T-03) — the Contract and the Attempt ladder in the
 * prototype's wide-dialog layout (`design/styles.css` `.dialog` +
 * `.data-list`, `design/team-space.css` attempt vocabulary). Every field is
 * CONTEXT.md vocabulary folded by the view-model; the report and gate-log
 * content render inline read-only (the tailed content `factory.task.detail`
 * already carries — no second read door). Copy buttons ride the clipboard
 * helper for the gate command, the Claim SHA, and each attempt's evidence.
 * Accept is the caller's slot: list, board, and detail share one journey.
 */
import { useState } from "react";
import type { AttemptRungViewModel, TaskDetailViewModel } from "../view-model.ts";
import { copyText, type CopyText } from "../clipboard.ts";
import { Markdown } from "../markdown.tsx";

/** One Copy button with its honest feedback — `Copy` / `Copied` / `Copy failed`. */
export function CopyButton({ text, label, copy = copyText }: { text: string; label: string; copy?: CopyText }) {
  const [landed, setLanded] = useState<"idle" | "ok" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn ghost console-copy"
      onClick={() => {
        void copy(text).then((ok) => setLanded(ok ? "ok" : "failed"));
      }}
    >
      {landed === "ok" ? "Copied" : landed === "failed" ? "Copy failed" : label}
    </button>
  );
}

function DataList({ rows }: { rows: readonly { term: string; children: React.ReactNode }[] }) {
  return (
    <dl className="data-list">
      {rows.map((row) => (
        <div key={row.term}>
          <dt>{row.term}</dt>
          <dd>{row.children}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The Watch pass's answers as the rung reads them — a passenger's probabilities, never a judge. */
function WatchPass({ watch }: { watch: NonNullable<AttemptRungViewModel["watch"]> }) {
  return (
    <div className="console-attempt-pass">
      <span className={`badge ${watch.maxProbability !== null && watch.maxProbability >= 0.5 ? "amber" : ""}`}>
        Watch · {watch.outcome}
      </span>{" "}
      <span className="muted small">
        {watch.model}
        {watch.error !== null ? ` — ${watch.error}` : ""}
        {watch.maxProbability !== null ? ` · max probability ${watch.maxProbability.toFixed(2)}` : ""}
      </span>
      {watch.answers !== null && (
        <ul className="console-watch-answers">
          {Object.entries(watch.answers).map(([name, probability]) => (
            <li key={name} className="mono">
              {name}: {probability === null ? "—" : probability.toFixed(2)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EyePass({ eye }: { eye: NonNullable<AttemptRungViewModel["eye"]> }) {
  return (
    <div className="console-attempt-pass">
      <span className={`badge ${eye.outcome === "concern" ? "amber" : eye.outcome === "clear" ? "green" : ""}`}>Fresh eyes · {eye.outcome}</span>{" "}
      <span className="muted small">
        {eye.model} — {eye.finding}
      </span>
    </div>
  );
}

/** One rung of the Attempt ladder — verdict, exit, note, SHA, ↻, Watch, Fresh eyes, and the tailed evidence. */
function AttemptRung({ rung, copy }: { rung: AttemptRungViewModel; copy?: CopyText }) {
  return (
    <details className="console-attempt" data-attempt={rung.n} open={rung.verdict !== null}>
      <summary className="small">
        <span className={`badge ${rung.verdictTone === "muted" ? "" : rung.verdictTone}`}>{rung.verdictLabel}</span>{" "}
        <span className="mono muted">#{rung.n}</span>
        {rung.respawned ? <span title="A Respawn landed before this attempt's Claim"> ↻</span> : null}
        {rung.agentId !== null ? <span className="muted"> · Peer {rung.agentId.slice(0, 8)}</span> : null}
      </summary>
      <div className="console-attempt-body">
        <DataList
          rows={[
            { term: "Exit", children: <span className="mono">{rung.exit === null ? "—" : String(rung.exit)}</span> },
            ...(rung.note !== null ? [{ term: "Note", children: rung.note }] : []),
            ...(rung.sha !== null
              ? [
                  {
                    term: "Claim SHA",
                    children: (
                      <span className="od-row">
                        <code>{rung.sha}</code>
                        <CopyButton text={rung.sha} label="Copy SHA" copy={copy} />
                      </span>
                    ),
                  },
                ]
              : []),
            ...(rung.reviewState !== undefined && rung.reviewState !== "off"
              ? [{ term: "Fresh-eyes review", children: rung.reviewState }]
              : []),
          ]}
        />
        {rung.watch !== null ? <WatchPass watch={rung.watch} /> : null}
        {rung.eye !== null ? <EyePass eye={rung.eye} /> : null}
        {rung.report !== null ? (
          <div className="console-evidence">
            <div className="od-row">
              <strong className="small">Report</strong>
              <span className="spacer" />
              <CopyButton text={rung.report} label="Copy report" copy={copy} />
            </div>
            <Markdown text={rung.report} />
          </div>
        ) : null}
        {rung.gateLog !== null ? (
          <div className="console-evidence">
            <div className="od-row">
              <strong className="small">Gate log</strong>
              <span className="spacer" />
              <CopyButton text={rung.gateLog} label="Copy log" copy={copy} />
            </div>
            <pre className="mono console-pre">{rung.gateLog}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** The detail body — header badges, Contract, and the Attempt ladder. */
export function TaskDetailPanel({ detail, copy }: { detail: TaskDetailViewModel; copy?: CopyText }) {
  const contract = detail.contract;
  return (
    <div className="console-task-detail">
      <div className="od-row console-detail-badges">
        <span className={`badge ${detail.tone}`}>{detail.statusLabel}</span>
        <span className="badge">{detail.attemptCount === 0 ? "No attempts" : `${detail.attemptCount} ${detail.attemptCount === 1 ? "attempt" : "attempts"}`}</span>
        <span className={`badge ${contract.watch ? "amber" : ""}`}>Watch {contract.watch ? "on" : "off"}</span>
        <span className={`badge ${contract.freshEyes ? "amber" : ""}`}>Fresh eyes {contract.freshEyes ? "on" : "off"}</span>
      </div>
      {detail.description !== null ? <Markdown text={detail.description} /> : null}
      <h3>Contract</h3>
      <DataList
        rows={[
          {
            term: "Gate",
            children: (
              <span className="od-row">
                <code>{contract.gate}</code>
                <CopyButton text={contract.gate} label="Copy gate" copy={copy} />
              </span>
            ),
          },
          { term: "Artifact", children: contract.artifact === "" ? "—" : contract.artifact },
          { term: "Scope", children: contract.scope === null ? "unrestricted" : contract.scope.join(", ") },
          { term: "Skills", children: contract.skills === null ? "none mandated" : contract.skills.join(" · ") },
          ...(contract.base !== null ? [{ term: "Base", children: <code>{contract.base}</code> }] : []),
          { term: "Workspace", children: <code>{contract.workspace}</code> },
          { term: "Created by", children: contract.by ?? "—" },
        ]}
      />
      {contract.description !== null ? (
        <>
          <div className="rule" />
          <Markdown text={contract.description} />
        </>
      ) : null}
      <div className="rule" />
      <h3>Attempts</h3>
      {detail.rungs.length === 0 ? (
        <div className="notice">No Attempts yet — the Task is contracted and waiting for its first Claim.</div>
      ) : (
        detail.rungs.map((rung) => <AttemptRung key={rung.n} rung={rung} copy={copy} />)
      )}
    </div>
  );
}
