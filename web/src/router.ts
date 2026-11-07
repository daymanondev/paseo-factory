/**
 * The console's URL routing — the Open Design prototype's screens at stable
 * paths (`/tasks`, `/inbox`, …) so a reload keeps the screen (the
 * prototype's boot-redirect defect, fixed by construction: the sidecar's SPA
 * fallback serves the app on every path and the path names the screen).
 * Hand-rolled history routing: eight static routes carry no dependency.
 *
 * T-03: the query string is part of the route — `/tasks?view=board&filter=
 * ready_to_accept&task=T-03` keeps the board's view choice, filter chip, and
 * open Task Detail across a reload (the bounded outcome's own persistence
 * law: the URL is the memory, never a local pref that a second machine never
 * sees). `navigate` accepts any path that may carry `?query`; the same
 * NAVIGATE_EVENT notifies the hook.
 */
import { useEffect, useState } from "react";

export type ScreenId = "overview" | "flow" | "tasks" | "activity" | "models" | "integrations" | "settings" | "inbox";

export interface Screen {
  id: ScreenId;
  /** The left-nav label, the prototype's vocabulary. */
  label: string;
  path: string;
  /** The rendered heading — the titled placeholder screens carry it too. */
  heading: string;
}

export const SCREENS: readonly Screen[] = [
  { id: "overview", label: "All projects", path: "/", heading: "All projects" },
  { id: "flow", label: "Workspace", path: "/flow", heading: "Workspace" },
  { id: "tasks", label: "Tasks", path: "/tasks", heading: "Tasks" },
  { id: "activity", label: "Activity", path: "/activity", heading: "Activity" },
  { id: "models", label: "Agents & Models", path: "/models", heading: "Agents & Models" },
  { id: "integrations", label: "Integrations", path: "/integrations", heading: "Integrations" },
  { id: "settings", label: "Settings", path: "/settings", heading: "Settings" },
  { id: "inbox", label: "Inbox", path: "/inbox", heading: "Needs you" },
] as const;

export function screenForPath(pathname: string): Screen {
  const match = SCREENS.find((screen) => screen.path === (pathname === "" ? "/" : pathname));
  return match ?? SCREENS[0];
}

/** The screen plus the query it was opened with — both survive the reload. */
export interface Route {
  screen: Screen;
  query: URLSearchParams;
}

export function routeForLocation(location: { pathname: string; search: string }): Route {
  return { screen: screenForPath(location.pathname), query: new URLSearchParams(location.search) };
}

/** pushState plus a notification event — jsdom fires no popstate on programmatic navigation. */
const NAVIGATE_EVENT = "factory-console:navigate";

export function navigate(path: string): void {
  // Same-path navigation still counts when the query changed — the URL is the
  // board's memory (view, filter, open detail), so every change must notify.
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeForLocation(window.location));
  useEffect(() => {
    const sync = () => setRoute(routeForLocation(window.location));
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);
  return route;
}
