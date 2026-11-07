/**
 * The console's URL routing — the Open Design prototype's screens at stable
 * paths (`/tasks`, `/inbox`, …) so a reload keeps the screen (the
 * prototype's boot-redirect defect, fixed by construction: the sidecar's SPA
 * fallback serves the app on every path and the path names the screen).
 * Hand-rolled history routing: eight static routes carry no dependency.
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

/** pushState plus a notification event — jsdom fires no popstate on programmatic navigation. */
const NAVIGATE_EVENT = "factory-console:navigate";

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function useRoute(): Screen {
  const [screen, setScreen] = useState<Screen>(() => screenForPath(window.location.pathname));
  useEffect(() => {
    const sync = () => setScreen(screenForPath(window.location.pathname));
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);
  return screen;
}
