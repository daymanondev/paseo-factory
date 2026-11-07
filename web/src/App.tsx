/**
 * The Web Console shell (ADR 0051) — the Open Design prototype's app chrome
 * as a real app: the eight-screen left nav with URL routing, the Project
 * switcher fed by the live `FactoryView` snapshot, and the adaptive poll.
 * The Overview renders the real Project list; the other seven screens are
 * titled placeholders landing in their own waves (T-03+). No Start
 * Supervisor / Start Lead controls anywhere (ADR 0017 preserved).
 */
import { useState } from "react";
import type { FactoryView } from "../../plugin/shared/view.ts";
import { NAV_ITEMS } from "./chrome/nav.ts";
import { useRoute } from "./router.ts";
import { ProjectSwitcher } from "./chrome/project-switcher.tsx";
import { OverviewScreen } from "./screens/overview.tsx";
import { PlaceholderScreen } from "./screens/placeholder.tsx";
import { loadSnapshotViaSidecar, snapshotIsBusy, useSnapshot, type SnapshotReply } from "./useSnapshot.ts";

export interface AppProps {
  /** The snapshot transport — the sidecar RPC door by default, a fixture in tests. */
  loadSnapshot?: (input: { projectRoot?: string }) => Promise<SnapshotReply>;
}

export function App({ loadSnapshot = loadSnapshotViaSidecar }: AppProps) {
  const screen = useRoute();
  /** The selected Project's root — `undefined` is the unscoped "All projects" view. */
  const [projectRoot, setProjectRoot] = useState<string | undefined>(undefined);
  const snapshot = useSnapshot(() => loadSnapshot(projectRoot === undefined ? {} : { projectRoot }), projectRoot ?? "");
  const view = snapshot.value;
  const busy = view !== null && snapshotIsBusy(view);
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
          {view === null && snapshot.error === null && screen.id === "overview" && <div className="notice">Loading the Factory snapshot…</div>}
          {view === null && snapshot.error !== null && (
            <div className="notice">The Factory snapshot is unreachable — is the daemon's factory plugin running? ({snapshot.error.message})</div>
          )}
          {view !== null && screen.id === "overview" && <OverviewScreen view={view} onOpenProject={setProjectRoot} />}
          {screen.id !== "overview" && <PlaceholderScreen screen={screen} view={view} />}
        </main>
      </div>
    </div>
  );
}
