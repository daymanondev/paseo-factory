import { sharedTools, sharedRoles, extendTool } from "./shared.ts";
import type { Catalog } from "./shared.ts";
/** SLP schemas contain no Scrum execution identity or lifecycle. */
export const slpCatalog: Catalog = {
  tools: { ...sharedTools, lead_set_contract: extendTool(sharedTools.lead_set_contract, { mutationMode: { type: "string", enum: ["default", "tests-only"] } }) },
  roles: sharedRoles,
};
