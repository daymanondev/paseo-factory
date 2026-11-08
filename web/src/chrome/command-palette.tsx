/**
 * The ⌘K command palette (T-14c, ADR 0051 §7) — navigation only: the three
 * command kinds the bounded outcome allows, and nothing else. (a) the eight
 * screens, folded from `NAV_ITEMS` so the palette can never drift from the
 * sidebar; (b) the Project scope — "All projects" plus each registered
 * Project from the live snapshot, through the SAME setter the
 * ProjectSwitcher rides (`onScopeProject` is the shell's `setProjectRoot`);
 * (c) the T-12 Add-Project wizard, opened by the shell's own flag. The
 * palette issues NO RPC of its own and adds no door entry — filtering,
 * arrowing, and running are pure client acts — and no Start/Ensure/Accept/
 * Rotate/any write command appears in it (ADR 0017: navigation only).
 * Keyboard law: ↑/↓ move, Enter runs and closes, Escape closes and returns
 * focus to the element that opened it, a click outside closes. Layout is the
 * design's own command/search treatment (`design/styles.css`'s
 * `.command-results`/`.command-result` rows over the console's dialog
 * overlay vocabulary; the topbar affordance is its `.search-trigger`) — the
 * prototype's `showCommands` JS is mock-only and never ported.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProjectView } from "../../../plugin/shared/view.ts";
import { NAV_ITEMS } from "./nav.ts";

/** The palette's own command rows carry their kind with them — the chip the row renders. */
type PaletteCommandKind = "Go to" | "Scope" | "Action";

interface PaletteCommand {
  id: string;
  kind: PaletteCommandKind;
  label: string;
  run: () => void;
}

export interface CommandPaletteProps {
  /** The snapshot's registered Projects — one scope command each, live. */
  projects: readonly ProjectView[];
  /** The ProjectSwitcher's own setter — `undefined` scopes to "All projects". */
  onScopeProject: (projectRoot: string | undefined) => void;
  /** Opens the shell's T-12 Add-Project wizard. */
  onAddProject: () => void;
  /** Every close path — Escape, a click outside, and after a command runs. */
  close: () => void;
}

/** Case-insensitive substring — the bounded outcome's whole ranking law. */
const commandMatches = (command: PaletteCommand, query: string): boolean =>
  `${command.kind} ${command.label}`.toLowerCase().includes(query.trim().toLowerCase());

export function CommandPalette({ projects, onScopeProject, onAddProject, close }: CommandPaletteProps) {
  const inputId = useId();
  const listId = useId();
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // The palette's commands are built, never fetched: the nav's own items, the
  // snapshot's own Projects, the shell's own wizard flag.
  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...NAV_ITEMS.map((item) => ({ id: `screen:${item.id}`, kind: "Go to" as const, label: item.label, run: item.navigate })),
      { id: "scope:all", kind: "Scope" as const, label: "All projects", run: () => onScopeProject(undefined) },
      ...projects.map((project) => ({
        id: `scope:${project.root}`,
        kind: "Scope" as const,
        label: project.name ?? project.slug,
        run: () => onScopeProject(project.root),
      })),
      { id: "action:add-project", kind: "Action" as const, label: "Add project…", run: onAddProject },
    ],
    [projects, onScopeProject, onAddProject],
  );
  const matches = useMemo(() => commands.filter((command) => commandMatches(command, filter)), [commands, filter]);
  const active = Math.min(activeIndex, matches.length - 1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The open law: remember the element that had focus when the palette opened
  // — every close path unmounts this component, and the cleanup hands focus
  // back to it (the topbar affordance, a nav button, whatever opened it).
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      if (opener !== null && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  /** Running a command always closes first — the palette never outlives its act. */
  const run = (command: PaletteCommand) => {
    close();
    command.run();
  };

  const onInputKeydown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(active + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(active - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = matches[active];
      if (command !== undefined) run(command);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="console-dialog-overlay" role="presentation" onClick={close}>
      <div
        className="dialog console-dialog console-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-body">
          <div className="field">
            <label className="sr-only" htmlFor={inputId}>
              Filter commands
            </label>
            <input
              id={inputId}
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={matches.length > 0 ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={matches.length > 0 ? `${listId}-option-${active}` : undefined}
              placeholder="Type a command…"
              autoComplete="off"
              spellCheck={false}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setActiveIndex(0); // a new filter starts at the top — the first match is the likely intent
              }}
              onKeyDown={onInputKeydown}
            />
          </div>
          {matches.length === 0 ? (
            <p className="console-palette-empty">No matching commands</p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Commands" className="command-results console-palette-results">
              {matches.map((command, index) => (
                <li
                  key={command.id}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className="command-result console-palette-row"
                  onClick={() => run(command)}
                >
                  <span className="console-palette-row-label">{command.label}</span>
                  <span className="badge console-palette-row-kind">{command.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
