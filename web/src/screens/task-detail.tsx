/**
 * The Task Detail body (T-03) — the Contract and the Attempt ladder in the
 * prototype's wide-dialog layout (`design/styles.css` `.dialog` +
 * `.data-list`, `design/team-space.css` attempt vocabulary). Every field is
 * CONTEXT.md vocabulary folded by the view-model; the report and gate-log
 * content render inline read-only (the tailed content `factory.task.detail`
 * already carries — no second read door). Copy buttons ride the clipboard
 * helper for the gate command, the Claim SHA, and each attempt's evidence.
 * Accept is the caller's slot: list, board, and detail share one journey.
 *
 * T-04: each rung with an `agentId` carries a Transcript disclosure — the
 * Attempt's native Agent timeline tail (`factory.agent.transcript`, loaded
 * lazily on open, rendered as React elements never innerHTML: user and
 * assistant messages readable, tool calls compact and collapsible, a
 * Refresh button, and loading/refusal/unavailable as honest data).
 */
import { useEffect, useState } from "react";
import type { AgentTranscriptEntry } from "../../../plugin/shared/rpc.ts";
import type { AttemptRungViewModel, TaskDetailViewModel } from "../view-model.ts";
import { copyText, type CopyText } from "../clipboard.ts";
import { agentTranscriptViaSidecar, type AgentTranscriptReply } from "../transcript.ts";
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

// ---- the Agent transcript disclosure (T-04) ------------------------------------------------

/** The transport slot the disclosure reads through — the sidecar's by default, tests inject a fake. */
export type LoadAgentTranscript = (input: { agent: string }) => Promise<AgentTranscriptReply>;

type TranscriptState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "refused"; code: string; error: string }
  | { phase: "unavailable"; reason: string }
  | { phase: "loaded"; entries: AgentTranscriptEntry[] };

/** One reduced timeline entry as native React elements — never innerHTML. The Agent Drawer's Transcript tab renders the same rows (T-07b). */
export function TranscriptRow({ entry }: { entry: AgentTranscriptEntry }) {
  if (entry.role === "tool") {
    return (
      <li className="console-tr-entry console-tr-tool">
        <details>
          <summary className="mono small">{entry.tool ?? "tool"}</summary>
          {entry.summary !== null ? <pre className="mono console-pre">{entry.summary}</pre> : null}
        </details>
      </li>
    );
  }
  if (entry.role === "user" || entry.role === "assistant") {
    return (
      <li className={`console-tr-entry console-tr-${entry.role}`}>
        <span className="console-tr-role">{entry.role === "user" ? "User" : "Agent"}</span>
        <div className="console-tr-text">{entry.text ?? ""}</div>
      </li>
    );
  }
  return (
    <li className="console-tr-entry console-tr-system">
      <span className="mono small muted">{entry.summary ?? entry.kind}</span>
    </li>
  );
}

/**
 * The rung's Transcript disclosure: a controlled toggle (jsdom never toggles
 * a native `<summary>` click, so the toggle is a button with
 * `aria-expanded`) that loads the agent's timeline tail lazily on FIRST open
 * and on every Refresh — never before. Every state renders as data: loading,
 * the refusal's code and sentence, the unavailable reason, or the tail
 * itself, newest last (the daemon's tail page in ascending seq order).
 */
export function TranscriptDisclosure({ agentId, load = agentTranscriptViaSidecar }: { agentId: string; load?: LoadAgentTranscript }) {
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<TranscriptState>({ phase: "idle" });
  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ phase: "loading" });
    void load({ agent: agentId }).then((reply) => {
      if (!live) return;
      setState(
        !reply.ok
          ? { phase: "refused", code: reply.code, error: reply.error }
          : "entries" in reply
            ? { phase: "loaded", entries: reply.entries }
            : { phase: "unavailable", reason: reply.reason },
      );
    });
    return () => {
      live = false;
    };
  }, [agentId, open, reloadKey, load]);
  return (
    <div className="console-transcript">
      <div className="od-row">
        <button type="button" className="btn ghost console-transcript-toggle" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          Transcript
        </button>
        {open ? (
          <button type="button" className="btn ghost console-transcript-refresh" onClick={() => setReloadKey((key) => key + 1)}>
            Refresh
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="console-transcript-body">
          {state.phase === "idle" || state.phase === "loading" ? <div className="notice">Loading the Agent transcript…</div> : null}
          {state.phase === "refused" ? (
            <div className="console-banner console-banner-error" role="alert">
              The transcript refused ({state.code}): {state.error}
            </div>
          ) : null}
          {state.phase === "unavailable" ? <div className="notice">{state.reason}</div> : null}
          {state.phase === "loaded" ? (
            state.entries.length === 0 ? (
              <div className="notice">The Agent transcript is empty.</div>
            ) : (
              <ol className="console-tr-list">
                {state.entries.map((entry) => (
                  <TranscriptRow key={`${entry.seq}-${entry.kind}`} entry={entry} />
                ))}
              </ol>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One rung of the Attempt ladder — verdict, exit, note, SHA, ↻, Watch, Fresh eyes, and the tailed evidence. */
function AttemptRung({ rung, copy, loadTranscript }: { rung: AttemptRungViewModel; copy?: CopyText; loadTranscript?: LoadAgentTranscript }) {
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
        {rung.agentId !== null ? <TranscriptDisclosure agentId={rung.agentId} load={loadTranscript} /> : null}
      </div>
    </details>
  );
}

/** The detail body — header badges, Contract, and the Attempt ladder. */
export function TaskDetailPanel({ detail, copy, loadTranscript }: { detail: TaskDetailViewModel; copy?: CopyText; loadTranscript?: LoadAgentTranscript }) {
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
        detail.rungs.map((rung) => <AttemptRung key={rung.n} rung={rung} copy={copy} loadTranscript={loadTranscript} />)
      )}
    </div>
  );
}
