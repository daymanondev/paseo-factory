/**
 * The Overview screen — the fleet Project list rendered from the real
 * snapshot (`view.projects`), the prototype's fleet list layout reused
 * (`design/fleet.css`). Every field shown is FactoryView data — no mock
 * rows, no fabricated costs. Selecting a Project scopes the console to it
 * (the switcher's own law).
 */
import type { FactoryView, ProjectView } from "../../../plugin/shared/view.ts";

export interface OverviewScreenProps {
  view: FactoryView;
  onOpenProject: (projectRoot: string) => void;
}

const MODE_LABELS = { slp: "SLP", scrum: "Agile Scrum" } as const;

function seatSummary(project: ProjectView): string {
  const supervisor = project.supervisorId != null ? "Supervisor live" : "Supervisor vacant";
  const lead = project.leadId != null ? "Lead live" : "Lead vacant";
  return `${supervisor} · ${lead}`;
}

export function OverviewScreen({ view, onOpenProject }: OverviewScreenProps) {
  const projects = view.projects;
  return (
    <section aria-label="All projects">
      <div className="fleet-summary">
        <span>
          <strong>{String(view.kpis.needsHuman)}</strong> needs you
        </span>
        <span>
          <strong>{String(view.kpis.running)}</strong> running
        </span>
        <span>
          <strong>{String(view.kpis.readyToAccept)}</strong> ready to accept
        </span>
        <span>
          <strong>{String(view.kpis.accepted)}</strong> accepted
        </span>
        <span>
          <strong>{String(projects.length)}</strong> projects
        </span>
      </div>
      {projects.length === 0 ? (
        <div className="notice">
          No Projects registered yet. A Project registers the first time a Supervisor or Lead seat opens on it from Paseo's
          native New Chat picker — the console never starts seats (ADR 0017).
        </div>
      ) : (
        <div className="fleet-project-list">
          <div className="fleet-list-head">
            <span>Project</span>
            <span>Mode</span>
            <span>Active tasks</span>
            <span>Seats</span>
          </div>
          {projects.map((project) => (
            <div className="fleet-project-item" key={project.slug} data-project-slug={project.slug}>
              <div className="fleet-item-project">
                <span className="fleet-item-avatar" aria-hidden="true">
                  {(project.name ?? project.slug).slice(0, 2).toUpperCase()}
                </span>
                <div className="fleet-item-name">
                  <h2>
                    <button type="button" onClick={() => onOpenProject(project.root)}>
                      {project.name ?? project.slug}
                    </button>
                  </h2>
                  <div className="fleet-item-meta">
                    <span>{project.root}</span>
                    {project.missingRoot === true && (
                      <span className="badge amber" title="The Project's directory was deleted on disk">
                        Missing folder
                      </span>
                    )}
                    {project.ledgerError !== undefined && (
                      <span className="badge red" title={project.ledgerError}>
                        Ledger unreadable
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <span className="badge">{project.executionMode === undefined ? "SLP" : MODE_LABELS[project.executionMode]}</span>
              <span className="fleet-task-count">{String(project.activeTaskCount ?? 0)}</span>
              <span className="console-seat-summary">{seatSummary(project)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
