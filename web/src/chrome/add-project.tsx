/**
 * The Owner's Add-Project wizard (T-12, ADR 0051) — the design's onboarding
 * flow (`design/project-add.css`'s own `.onboarding-dialog` + `.wiz-*`
 * vocabulary; its JS is mock-only and never ported) reduced to the steps the
 * RPC door can honestly serve: Choose folder → Review → Added. The design's
 * later steps (mode, models, Open Design, skills, seat start) need writes
 * not in the door and are omitted — no Start/Ensure control anywhere
 * (ADR 0017). Folder offers BOTH doors the contract allows: a typed host
 * path OR "Browse…" through `factory.project.pick.folder` (the daemon
 * host's native picker — a cancelled pick returns to the step with no
 * error, a picked one registers the folder itself and jumps straight to
 * Added with its own facts, never a redundant add). Review states honestly
 * what Add does: registers the git repo as a Factory Project (a plain
 * non-Git folder is BOOTSTRAPPED — `git init` + an empty commit, ADR 0024
 * — and nothing starts). Add sends exactly `factory.project.add {path}`;
 * refusals (`missing-directory`, `unsafe-directory`, …) render inline as
 * data; Cancel at every pre-add step sends nothing. Success lands on Added
 * with the handler's own summary/slug/bootstrapped facts and scopes the
 * console to the new Project through `onAdded(projectRoot)` — the shell's
 * snapshot re-keys on the new scope and the console lands on its Overview.
 */
import { useState } from "react";
import "../../../design/project-add.css";
import {
  projectAddViaSidecar,
  projectPickFolderViaSidecar,
  type ProjectAddInput,
  type ProjectAddReply,
  type ProjectAddSuccess,
  type ProjectPickReply,
} from "../project.ts";
import type { RpcFailure } from "../rpc.ts";

/** The wizard's three honest steps — the design's rail, reduced to the door's acts. */
type AddProjectStep = "folder" | "review" | "added";

/** The one success panel both doors render — the handler's own facts, verbatim. */
type AddOutcome = { source: "added" | "picked" } & ProjectAddSuccess;

export interface AddProjectDialogProps {
  /** The add transport (T-12) — the sidecar RPC door by default, a fixture in tests. */
  add?: (input: ProjectAddInput) => Promise<ProjectAddReply>;
  /** The native-picker transport (T-12) — the sidecar RPC door by default, a fixture in tests. */
  pick?: (prompt?: string) => Promise<ProjectPickReply>;
  /** Fired once a Project lands — the shell scopes the console to it and lands on its Overview. */
  onAdded: (projectRoot: string) => void;
  /** Every pre-add close path — Cancel, Close, the overlay; sends nothing. */
  close: () => void;
}

const STEP_LABELS: readonly { id: AddProjectStep; label: string }[] = [
  { id: "folder", label: "Folder" },
  { id: "review", label: "Review" },
  { id: "added", label: "Added" },
];

export function AddProjectDialog({
  add = projectAddViaSidecar,
  pick = projectPickFolderViaSidecar,
  onAdded,
  close,
}: AddProjectDialogProps) {
  const [step, setStep] = useState<AddProjectStep>("folder");
  const [path, setPath] = useState("");
  const [phase, setPhase] = useState<"editing" | "working">("editing");
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  const [refusal, setRefusal] = useState<RpcFailure | null>(null);
  const trimmed = path.trim();

  /** The one landing both success arms share — the facts render, the console scopes. */
  const land = (source: "added" | "picked", success: ProjectAddSuccess) => {
    setOutcome({ source, ...success });
    setRefusal(null);
    setStep("added");
    onAdded(success.projectRoot);
  };

  const runAdd = async () => {
    setPhase("working");
    const reply = await add({ path: trimmed });
    setPhase("editing");
    if (reply.ok) land("added", reply);
    else setRefusal(reply);
  };

  const runPick = async () => {
    setPhase("working");
    const reply = await pick("Choose the project folder to add to Factory");
    setPhase("editing");
    if (!reply.ok) {
      setRefusal(reply);
      return;
    }
    if (reply.cancelled) {
      // The Owner closed the native dialog — back to the folder step, no error.
      setRefusal(null);
      return;
    }
    land("picked", reply);
  };

  const stepIndex = (id: AddProjectStep): number => STEP_LABELS.findIndex((entry) => entry.id === id);
  const busy = phase === "working";

  return (
    <div className="console-dialog-overlay" role="presentation" onClick={busy ? undefined : close}>
      <div
        className="dialog onboarding-dialog console-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add project"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2 id="add-project-title">Add project</h2>
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            Close
          </button>
        </div>
        <div className="dialog-body">
          <div className="wiz-stage">
            <div className="wiz-top-bar">
              <span className="wiz-brand-pill">factory · new project</span>
              <div className="wiz-steps-rail" aria-hidden="true">
                {STEP_LABELS.map((entry, index) => (
                  <span
                    key={entry.id}
                    className={`wiz-step-dot${step === entry.id ? " active" : ""}${stepIndex(step) > index ? " done" : ""}`}
                  >
                    <b>{stepIndex(step) > index ? "✓" : index + 1}</b> {entry.label}
                  </span>
                ))}
              </div>
            </div>
            {step === "folder" ? (
              <>
                <div className="wiz-hero">
                  <div className="wiz-hero-left">
                    <span className="wiz-cute-badge" aria-hidden="true">
                      +
                    </span>
                    <div>
                      <h3 className="wiz-hero-title">Choose a project folder</h3>
                      <p className="wiz-hero-sub">Type a path on this machine, or browse with the daemon host's native picker.</p>
                    </div>
                  </div>
                </div>
                <div className="wiz-folder-bar">
                  <div className="wiz-path-box">
                    <input
                      aria-label="Project folder path"
                      value={path}
                      placeholder="/Users/owner/code/my-project"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setPath(event.target.value)}
                    />
                  </div>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => void runPick()}>
                    Browse…
                  </button>
                </div>
                {refusal !== null && outcome === null ? (
                  <p className="small red" role="alert">
                    Browse refused ({refusal.code}): {refusal.error}
                  </p>
                ) : null}
              </>
            ) : step === "review" ? (
              <>
                <div className="wiz-hero">
                  <div className="wiz-hero-left">
                    <span className="wiz-cute-badge" aria-hidden="true">
                      ↗
                    </span>
                    <div>
                      <h3 className="wiz-hero-title">Review the folder</h3>
                      <p className="wiz-hero-sub">Adding registers the Project — nothing starts.</p>
                    </div>
                  </div>
                </div>
                <div className="wiz-detect-panel">
                  <div className="wiz-detect-row">
                    <div className="wiz-proj-id">
                      <span className="wiz-proj-icon" aria-hidden="true">
                        {(trimmed.split("/").filter(Boolean).pop() ?? "?").slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <strong>{trimmed.split("/").filter(Boolean).pop() ?? "the folder"}</strong>
                        <span className="wiz-proj-path">{trimmed}</span>
                      </div>
                    </div>
                  </div>
                  <p className="wiz-hero-sub">
                    Adding registers this git repository as a Factory Project. A plain folder that is not a git repo yet is bootstrapped
                    automatically (git init + an empty initial commit); a folder inside the Factory home refuses as unsafe. No seat starts
                    here — the console never starts seats (ADR 0017).
                  </p>
                </div>
                {refusal !== null && outcome === null ? (
                  <p className="small red" role="alert">
                    Add refused ({refusal.code}): {refusal.error}
                  </p>
                ) : null}
              </>
            ) : outcome !== null ? (
              <>
                <div className="wiz-hero">
                  <div className="wiz-hero-left">
                    <span className="wiz-cute-badge" aria-hidden="true">✓</span>
                    <div>
                      <h3 className="wiz-hero-title">Project added</h3>
                      <p className="wiz-hero-sub" role="status">
                        {outcome.summary}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="wiz-detect-panel">
                  <dl className="data-list">
                    <div>
                      <dt>Project</dt>
                      <dd>
                        <strong>{outcome.project.name ?? outcome.slug}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>Slug</dt>
                      <dd className="mono">{outcome.slug}</dd>
                    </div>
                    <div>
                      <dt>Root</dt>
                      <dd className="mono">{outcome.projectRoot}</dd>
                    </div>
                    <div>
                      <dt>Git</dt>
                      <dd>{outcome.bootstrapped ? "Bootstrapped — initialized with an empty commit" : "Existing repository registered as-is"}</dd>
                    </div>
                  </dl>
                  <p className="wiz-hero-sub">
                    The console is now scoped to this Project{outcome.source === "picked" ? " (the picker registered it directly)" : ""} —
                    its Overview is behind this dialog.
                  </p>
                </div>
              </>
            ) : null}
          </div>
          <div className="wiz-footer">
            <div className="wiz-footer-left">
              {step === "added" ? (
                <span className="wiz-hero-sub">Registered — nothing is running.</span>
              ) : (
                <button type="button" className="btn ghost" onClick={close} disabled={busy}>
                  Cancel
                </button>
              )}
            </div>
            <div className="wiz-footer-right">
              {step === "folder" ? (
                <button type="button" className="btn wiz-btn-next" disabled={busy || trimmed === ""} onClick={() => setStep("review")}>
                  Continue
                </button>
              ) : step === "review" ? (
                <>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep("folder")}>
                    Back
                  </button>
                  <button type="button" className="btn wiz-btn-next" disabled={busy} onClick={() => void runAdd()}>
                    {busy ? "Adding…" : "Add project"}
                  </button>
                </>
              ) : (
                <button type="button" className="btn wiz-btn-next" onClick={close}>
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
