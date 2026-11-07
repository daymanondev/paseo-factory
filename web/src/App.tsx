/**
 * The Web Console shell (ADR 0051) — the Open Design prototype's app chrome
 * as a real app: the eight-screen left nav with URL routing, the Project
 * switcher fed by the live `FactoryView` snapshot, and the adaptive poll.
 * The Overview renders the real Project list; the Tasks screen renders the
 * scoped Task list with the first real write journey (T-02); the Inbox
 * (T-05) renders the cross-Project fold — needs-human, red, pending Scrum
 * Owner requests, ready-to-accept — with the count badge beside its nav
 * item; the other screens are titled placeholders landing in their own
 * waves. No Start Supervisor / Start Lead controls anywhere (ADR 0017
 * preserved).
 */
import { useEffect, useState } from "react";
import type { FactoryView } from "../../plugin/shared/view.ts";
import { NAV_ITEMS } from "./chrome/nav.ts";
import { useRoute } from "./router.ts";
import { ProjectSwitcher } from "./chrome/project-switcher.tsx";
import { acceptViaSidecar, type AcceptReply } from "./accept.ts";
import { taskDetailViaSidecar, type TaskDetailReply } from "./detail.ts";
import { inboxViaSidecar, type InboxReply } from "./inbox.ts";
import { OverviewScreen } from "./screens/overview.tsx";
import { PlaceholderScreen } from "./screens/placeholder.tsx";
import { TasksScreen } from "./screens/tasks.tsx";
import { InboxScreen } from "./screens/inbox.tsx";
import { inboxModel, type InboxGather } from "./view-model.ts";
import { loadSnapshotViaSidecar, snapshotIsBusy, useSnapshot, type SnapshotReply } from "./useSnapshot.ts";

export interface AppProps {
  /** The snapshot transport — the sidecar RPC door by default, a fixture in tests. */
  loadSnapshot?: (input: { projectRoot?: string }) => Promise<SnapshotReply>;
  /** The accept transport — the sidecar RPC door by default, a fixture in tests. */
  acceptTask?: (input: { task: string; attempt: number }) => Promise<AcceptReply>;
  /** The Task Detail transport — the sidecar RPC door by default, a fixture in tests. */
  loadTaskDetail?: (input: { task: string }) => Promise<TaskDetailReply>;
  /** The inbox gather transport — the sidecar RPC door by default, a fixture in tests. */
  loadInbox?: () => Promise<InboxReply>;
}

export function App({
  loadSnapshot = loadSnapshotViaSidecar,
  acceptTask = acceptViaSidecar,
  loadTaskDetail = taskDetailViaSidecar,
  loadInbox = inboxViaSidecar,
}: AppProps) {
  const { screen } = useRoute();
  /** The selected Project's root — `undefined` is the unscoped "All projects" view. */
  const [projectRoot, setProjectRoot] = useState<string | undefined>(undefined);
  // The Inbox is the cross-Project fold ("across ALL Projects", T-05) — while
  // it is the open screen the shell loads the UNSCOPED snapshot, whatever the
  // switcher holds; leaving the screen re-applies the selection. The badge and
  // the list fold the SAME view, so they can never disagree.
  const scopeRoot = screen.id === "inbox" ? undefined : projectRoot;
  const snapshot = useSnapshot(() => loadSnapshot(scopeRoot === undefined ? {} : { projectRoot: scopeRoot }), scopeRoot ?? "");
  const view = snapshot.value;
  const busy = view !== null && snapshotIsBusy(view);
  // The Scrum half of the inbox — re-read whenever a fresh snapshot lands (its
  // `generatedAt` is minted per read), so an Accept's immediate refresh drops
  // the count on the very next render.
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
  const inbox = view !== null ? inboxModel(view, gather) : null;
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
          <ProjectSwitcher view={view} selectedRoot={projectRoot} onSelect={setProjectRoot} />
        </header>
        {snapshot.error !== null && (
          <div className="console-banner console-banner-error" role="alert">
            Console connection degraded ({snapshot.error.code}): {snapshot.error.message} — showing the last good snapshot.
          </div>
        )}
        <main id="main" className="page" tabIndex={-1}>
          {view !== null && screen.id === "overview" && <OverviewScreen view={view} onOpenProject={setProjectRoot} />}
          {view !== null && screen.id === "tasks" && (
            <TasksScreen view={view} acceptTask={acceptTask} onAccepted={() => snapshot.refresh()} loadTaskDetail={loadTaskDetail} />
          )}
          {view !== null && screen.id === "inbox" && inbox !== null && (
            <InboxScreen model={inbox} acceptTask={acceptTask} onAccepted={() => snapshot.refresh()} onOpenProject={setProjectRoot} />
          )}
          {/* The route names the screen even while the first snapshot is in
              flight or unreachable — a reload of /tasks lands on Tasks, not a
              blank page (the placeholder screens' own T-01 law, kept). */}
          {view === null && (screen.id === "tasks" || screen.id === "inbox") && (
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
          {view === null && snapshot.error !== null && screen.id !== "tasks" && screen.id !== "inbox" && (
            <div className="notice">The Factory snapshot is unreachable — is the daemon's factory plugin running? ({snapshot.error.message})</div>
          )}
          {screen.id !== "overview" && screen.id !== "tasks" && screen.id !== "inbox" && <PlaceholderScreen screen={screen} view={view} />}
        </main>
      </div>
    </div>
  );
}
