/**
 * The Project switcher — fed by the live snapshot's `projects` list (the RN
 * header's Project Selector law): "All projects" is the unscoped global
 * view, a Project's root scopes the snapshot to its own Factory. Mode badges
 * (`SLP` / `Agile Scrum`) ride each entry (ADR 0033's vocabulary).
 */
import type { FactoryView, ProjectView } from "../../../plugin/shared/view.ts";

export interface ProjectSwitcherProps {
  view: FactoryView | null;
  selectedRoot: string | undefined;
  onSelect: (projectRoot: string | undefined) => void;
}

const modeLabel = (project: ProjectView) => (project.executionMode === "scrum" ? "Agile Scrum" : "SLP");

export function ProjectSwitcher({ view, selectedRoot, onSelect }: ProjectSwitcherProps) {
  const projects = view?.projects ?? [];
  const selected = projects.find((project) => project.root === selectedRoot);
  return (
    <label className="console-project-switcher">
      <span className="sr-only">Project</span>
      <select
        value={selectedRoot ?? ""}
        onChange={(event) => onSelect(event.target.value === "" ? undefined : event.target.value)}
        disabled={projects.length === 0}
      >
        <option value="">All projects{projects.length > 0 ? ` (${projects.length})` : ""}</option>
        {projects.map((project) => (
          <option key={project.slug} value={project.root}>
            {project.name ?? project.slug} · {modeLabel(project)}
          </option>
        ))}
      </select>
    </label>
  );
}
