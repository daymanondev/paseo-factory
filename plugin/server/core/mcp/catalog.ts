import { readExecution } from "../scrum/selection.ts";
import { slpCatalog } from "./slp.ts";
import { scrumCatalog } from "./scrum.ts";
export function selectCatalog(mode: "slp" | "scrum") {
  return { slp: slpCatalog, scrum: scrumCatalog }[mode];
}

export function resolveMode(state: string, slug?: string, explicit?: string): "slp" | "scrum" {
  const mode = explicit ?? readExecution(state, slug).mode;
  if (mode !== "slp" && mode !== "scrum") throw new Error(`invalid execution mode: ${mode}`);
  return mode;
}
