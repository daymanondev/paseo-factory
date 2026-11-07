/** The left nav's eight screens — the prototype's vocabulary, wired to URL routes. */
import { navigate, SCREENS, type Screen } from "../router.ts";

export interface NavItem {
  id: Screen["id"];
  label: string;
  navigate: () => void;
}

export const NAV_ITEMS: readonly NavItem[] = SCREENS.map((screen) => ({
  id: screen.id,
  label: screen.label,
  navigate: () => navigate(screen.path),
}));
