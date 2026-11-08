/**
 * The Web Console shell (ADR 0051) — the Open Design prototype's app chrome
 * as a real app: the eight-screen left nav with URL routing, the Project
 * switcher fed by the live `FactoryView` snapshot, and the adaptive poll.
 * The Overview renders the real Project list; the Tasks screen renders the
 * scoped Task list with the first real write journey (T-02); the Inbox
 * (T-05) renders the cross-Project fold — needs-human, red, pending Scrum
 * Owner requests, ready-to-accept — and T-06 makes its Scrum half
 * resolvable inline (answer, decide, grant) through the sidecar's narrowed
 * `factory.scrum.command` door; the count badge beside its nav item is the
 * CROSS-Project count on every screen (its fold rides the badge's own
 * unscoped snapshot, never the screen's scoped one — the T-05 carry-over
 * fix); the Workspace (T-07a) renders the selected Project's read-only
 * authority graph — the SLP chain or the Scrum pipeline strip — from the
 * same scoped snapshot; the Agents & Models screen (T-08a + T-08b) renders
 * the selected Project's roster — one row per lane, default vs override,
 * the live seats, the profile chips — and carries the three lane writes
 * (`factory.lanes.set` per-row Configure, `factory.lanes.reset`,
 * `factory.profiles.apply`) through the sidecar's allowlisted door, with a
 * live-seat confirm before a seated lane changes; the Integrations screen
 * (T-09a) renders the read-only plugin/skill/MCP roster, the Open Design
 * link, and the plugins-checked-at stamp from the same snapshot; the
 * Settings screen (T-10a + T-10e) renders the Private Vault card and the
 * scoped Project's identity from the same snapshot, carrying the Owner's
 * vault writes (T-10b..d) and the scoped Project's Danger Zone (T-10e — a
 * successful delete clears the selection and returns the console to the
 * unscoped Overview); the Activity screen (T-11a + T-11b) renders the
 * read-only ledger stream with its client-side kind filter chips, the usage
 * rollup, and the retro timeline (newest first, each retro's R1..Rn
 * proposals) from the same snapshot — and carries the scoped Run retro write
 * through the sidecar's narrowed `factory.retro` door (its ratification
 * stays outside: no Ratify control anywhere); and the Owner's Add-Project
 * wizard (T-12) opens from the topbar beside the switcher and from the
 * Overview's empty state — a stepped dialog (folder → review → added)
 * carrying `factory.project.add` and `factory.project.pick.folder` through
 * the door, whose success scopes the console to the new Project and lands
 * on its Overview — every screen of the eight is
 * real now; the placeholder remains only as a future screen's titled
 * fallback. The ⌘K command palette (T-14c) rides above every screen —
 * navigation only: the eight nav screens, the Project scope through the
 * switcher's own setter, and the wizard, with no RPC of its own — and the
 * chord stays inert while any dialog (the palette included) holds the
 * console. No Start Supervisor / Start Lead controls anywhere (ADR 0017
 * preserved).
 */
import { useEffect, useState } from "react";
import type { FactoryView } from "../../plugin/shared/view.ts";
import { NAV_ITEMS } from "./chrome/nav.ts";
import { useRoute, navigate } from "./router.ts";
import { AddProjectDialog } from "./chrome/add-project.tsx";
import { CommandPalette } from "./chrome/command-palette.tsx";
import { ProjectSwitcher } from "./chrome/project-switcher.tsx";
import { projectAddViaSidecar, projectPickFolderViaSidecar, type ProjectAddInput, type ProjectAddReply, type ProjectPickReply } from "./project.ts";
import { acceptViaSidecar, type AcceptReply } from "./accept.ts";
import { taskDetailViaSidecar, type TaskDetailReply } from "./detail.ts";
import { inboxViaSidecar, type InboxReply } from "./inbox.ts";
import { scrumCommandViaSidecar, type ScrumCommandInput, type ScrumCommandReply } from "./scrum.ts";
import { OverviewScreen } from "./screens/overview.tsx";
import { PlaceholderScreen } from "./screens/placeholder.tsx";
import { ActivityScreen } from "./screens/activity.tsx";
import { FlowScreen } from "./screens/flow.tsx";
import { ModelsScreen } from "./screens/models.tsx";
import { IntegrationsScreen } from "./screens/integrations.tsx";
import { SettingsScreen } from "./screens/settings.tsx";
import { TasksScreen } from "./screens/tasks.tsx";
import { InboxScreen } from "./screens/inbox.tsx";
import { inboxModel, type InboxGather } from "./view-model.ts";
import { loadSnapshotViaSidecar, snapshotIsBusy, useSnapshot, type SnapshotReply } from "./useSnapshot.ts";

export interface AppProps {
  /** The snapshot transport — the sidecar RPC door by default, a fixture in tests. */
  loadSnapshot?: (input: { projectRoot?: string }) => Promise<SnapshotReply>;
  /** The accept transport — the sidecar RPC door by default, a fixture in tests. */
  acceptTask?: (input: { task: string; attempt: number }) => Promise<AcceptReply>;
  /** The Scrum Owner command transport (T-06) — the sidecar's narrowed door by default, a fixture in tests. */
  scrumCommand?: (input: ScrumCommandInput) => Promise<ScrumCommandReply>;
  /** The Task Detail transport — the sidecar RPC door by default, a fixture in tests. */
  loadTaskDetail?: (input: { task: string }) => Promise<TaskDetailReply>;
  /** The inbox gather transport — the sidecar RPC door by default, a fixture in tests. */
  loadInbox?: () => Promise<InboxReply>;
  /** The Add-Project add transport (T-12) — the sidecar RPC door by default, a fixture in tests. */
  projectAdd?: (input: ProjectAddInput) => Promise<ProjectAddReply>;
  /** The Add-Project native-picker transport (T-12) — the sidecar RPC door by default, a fixture in tests. */
  pickFolder?: (prompt?: string) => Promise<ProjectPickReply>;
}

export function App({
  loadSnapshot = loadSnapshotViaSidecar,
  acceptTask = acceptViaSidecar,
  scrumCommand = scrumCommandViaSidecar,
  loadTaskDetail = taskDetailViaSidecar,
  loadInbox = inboxViaSidecar,
  projectAdd = projectAddViaSidecar,
  pickFolder = projectPickFolderViaSidecar,
}: AppProps) {
  const { screen } = useRoute();
  /** The selected Project's root — `undefined` is the unscoped "All projects" view. */
  const [projectRoot, setProjectRoot] = useState<string | undefined>(undefined);
  // The Inbox is the cross-Project fold ("across ALL Projects", T-05) — while
  // it is the open screen the shell loads the UNSCOPED snapshot, whatever the
  // switcher holds; leaving the screen re-applies the selection.
  const scopeRoot = screen.id === "inbox" ? undefined : projectRoot;
  const snapshot = useSnapshot(() => loadSnapshot(scopeRoot === undefined ? {} : { projectRoot: scopeRoot }), scopeRoot ?? "");
  const view = snapshot.value;
  // The badge's own unscoped snapshot (the T-05 carry-over fix): the nav badge
  // counts the CROSS-Project inbox on EVERY screen, never the scoped
  // selection's. While the screen itself is unscoped the fold rides the SAME
  // view — the badge and the list can never disagree — so this poll earns its
  // keep only on a scoped screen.
  const badgeSnapshot = useSnapshot(() => loadSnapshot({}), "inbox-badge");
  const badgeView = scopeRoot === undefined ? view : (badgeSnapshot.value ?? view);
  const busy = view !== null && snapshotIsBusy(view);
  // The Scrum half of the inbox — re-read whenever a fresh snapshot lands (its
  // `generatedAt` is minted per read), so an Accept's or an Owner act's
  // immediate refresh drops the count on the very next render.
  const generatedAt = view?.generatedAt ?? "";
  const [gather, setGather] = useState<InboxGather | null>(null);
  useEffect(() => {
    if (generatedAt === "") return; // no snapshot yet — nothing to key the re-read to
    let live = true;
    void loadInbox().then((reply) => {
      if (!live) return;
      setGather(reply.ok ? { projects: reply.projects, refusals: reply.refusals, error: null } : { projects: [], refusals: [], error: `(${reply.code}) ${reply.error}` });
    });
    return () => {
      live = false;
    };
  }, [generatedAt, loadInbox]);
  const inbox = badgeView !== null ? inboxModel(badgeView, gather) : null;
  // The Owner's Add-Project wizard (T-12) — one open flag shared by its two
  // entry points (the topbar beside the switcher, the Overview empty state).
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // The ⌘K command palette (T-14c) — one open flag shared by the chord and
  // the topbar affordance.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The chord opens the palette anywhere in the console (macOS ⌘K, elsewhere
  // Ctrl+K — the design's own global law), but never barges past a dialog
  // that already holds the console: while any dialog is open — another
  // screen's modal, the wizard, the drawer, or the palette itself — the
  // chord does nothing (no re-open, no reset of a typed filter).
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (document.querySelector('[role="dialog"]') !== null) return;
      setPaletteOpen(true);
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, []);
  return (
    <div className="app" id="app">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand" aria-hidden="true">
          <span className="brand-name">factory</span>
        </div>
        <nav className="nav-group" aria-label="Console screens">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${screen.id === item.id ? " active" : ""}`}
              aria-current={screen.id === item.id ? "page" : undefined}
              onClick={() => item.navigate()}
            >
              <span>{item.label}</span>
              {item.id === "inbox" && inbox !== null ? (
                <span className={`nav-count${inbox.count > 0 ? " attention" : ""}`} hidden={inbox.count === 0}>
                  {inbox.count}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="console-clock" data-busy={busy ? "busy" : "idle"} title={busy ? "Active work — polling every 5s" : "Quiet — polling every 30s"}>
            {busy ? "watching · 5s" : "quiet · 30s"}
          </span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <strong id="breadcrumb">{screen.heading}</strong>
          </div>
          <span className="spacer" />
          {/* T-14c: the palette's visible affordance — the design's own
              `.search-trigger` vocabulary, chord hint and all. */}
          <button type="button" className="search-trigger console-palette-trigger" onClick={() => setPaletteOpen(true)}>
            <span>Search commands…</span>
            <kbd aria-hidden="true">⌘K</kbd>
          </button>
          {/* T-12: the wizard's always-offered entry point, beside the switcher. */}
          <button type="button" className="btn ghost console-add-project" onClick={() => setAddProjectOpen(true)}>
            Add project
          </button>
          <ProjectSwitcher view={view} selectedRoot={projectRoot} onSelect={setProjectRoot} />
        </header>
        {snapshot.error !== null && (
          <div className="console-banner console-banner-error" role="alert">
            Console connection degraded ({snapshot.error.code}): {snapshot.error.message} — showing the last good snapshot.
          </div>
        )}
        <main id="main" className="page" tabIndex={-1}>
          {view !== null && screen.id === "overview" && <OverviewScreen view={view} onOpenProject={setProjectRoot} onAddProject={() => setAddProjectOpen(true)} />}
          {view !== null && screen.id === "activity" && <ActivityScreen view={view} onChanged={() => snapshot.refresh()} />}
          {view !== null && screen.id === "flow" && <FlowScreen view={view} />}
          {view !== null && screen.id === "models" && <ModelsScreen view={view} onChanged={() => snapshot.refresh()} />}
          {view !== null && screen.id === "integrations" && <IntegrationsScreen view={view} onChanged={() => snapshot.refresh()} />}
          {view !== null && screen.id === "settings" && (
            <SettingsScreen
              view={view}
              onChanged={() => snapshot.refresh()}
              // T-10e: a successful delete leaves nothing to scope — clear the
              // switcher's selection and land the console on the unscoped Overview.
              onProjectDeleted={() => {
                setProjectRoot(undefined);
                navigate("/");
              }}
            />
          )}
          {view !== null && screen.id === "tasks" && (
            <TasksScreen view={view} acceptTask={acceptTask} onAccepted={() => snapshot.refresh()} loadTaskDetail={loadTaskDetail} />
          )}
          {view !== null && screen.id === "inbox" && inbox !== null && (
            <InboxScreen model={inbox} acceptTask={acceptTask} scrumCommand={scrumCommand} onResolved={() => snapshot.refresh()} onAccepted={() => snapshot.refresh()} onOpenProject={setProjectRoot} />
          )}
          {/* The route names the screen even while the first snapshot is in
              flight or unreachable — a reload of /tasks lands on Tasks, not a
              blank page (the placeholder screens' own T-01 law, kept). */}
          {view === null && (screen.id === "tasks" || screen.id === "inbox" || screen.id === "flow" || screen.id === "models" || screen.id === "integrations" || screen.id === "settings" || screen.id === "activity") && (
            <section aria-label={screen.heading}>
              <h1>{screen.heading}</h1>
              {snapshot.error === null ? (
                <div className="notice">Loading the Factory snapshot…</div>
              ) : (
                <div className="notice">
                  The Factory snapshot is unreachable — is the daemon's factory plugin running? ({snapshot.error.message})
                </div>
              )}
            </section>
          )}
          {view === null && snapshot.error === null && screen.id === "overview" && (
            <div className="notice">Loading the Factory snapshot…</div>
          )}
          {view === null && snapshot.error !== null && screen.id !== "tasks" && screen.id !== "inbox" && screen.id !== "flow" && screen.id !== "models" && screen.id !== "integrations" && screen.id !== "settings" && screen.id !== "activity" && (
            <div className="notice">The Factory snapshot is unreachable — is the daemon's factory plugin running? ({snapshot.error.message})</div>
          )}
          {screen.id !== "overview" && screen.id !== "flow" && screen.id !== "models" && screen.id !== "tasks" && screen.id !== "inbox" && screen.id !== "integrations" && screen.id !== "settings" && screen.id !== "activity" && <PlaceholderScreen screen={screen} view={view} />}
        </main>
      </div>
      {/* T-12: the Add-Project wizard — success scopes the console to the new
          Project (the snapshot re-keys on the new scope) and lands on its
          Overview, the same hand-back law a successful delete inverts. */}
      {addProjectOpen ? (
        <AddProjectDialog
          add={projectAdd}
          pick={pickFolder}
          close={() => setAddProjectOpen(false)}
          onAdded={(projectRoot) => {
            setProjectRoot(projectRoot);
            navigate("/");
          }}
        />
      ) : null}
      {/* T-14c: the command palette — navigation only, fed by the nav's own
          items, the snapshot's own Projects, and the wizard's own flag. */}
      {paletteOpen ? (
        <CommandPalette
          projects={view?.projects ?? []}
          onScopeProject={setProjectRoot}
          onAddProject={() => setAddProjectOpen(true)}
          close={() => setPaletteOpen(false)}
        />
      ) : null}
    </div>
  );
}
