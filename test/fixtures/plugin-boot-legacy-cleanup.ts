/**
 * Actual plugin-entry fixture for the v0.6.0 boot cleanup (ADR 0056, Seam 3):
 * seeds a pre-0.6.0 state directory (Scrum-mode legacy execution record with
 * an Open Design link and skill packs, Scrum lanes/profiles/switch files, a
 * Scrum run directory), boots the real plugin entry twice, and prints what is
 * left on disk after each boot. Its HOME/PASEO_HOME are disposable.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import contribute from "../../plugin/index.server.ts";

const home = process.env.PASEO_HOME!, stateDir = join(home, "plugin-state/paseo-factory");
const arm = process.env.CLEANUP_ARM as "fresh" | "crashed";

const link = {
  projectId: "checkout-redesign", projectName: "Checkout Redesign", designSystemId: null, directionId: null,
  sourceUpdatedAt: 1_700_000_000_000, syncedAt: "2026-11-08T09:05:00.000Z", digest: "f".repeat(64), screenCount: 7, files: ["index.html"],
};
const legacy = {
  schemaVersion: 1, mode: "scrum", revision: 4, skillPacks: ["expo", "science"],
  openDesignLink: link, openDesignSource: { kind: "client", requestId: "req-1", acknowledgedRequestId: "req-1" },
  openDesignCheckpointPaths: ["index.html", "open-design-link.json"],
};
const put = (relative: string, value: unknown): void => {
  const path = join(stateDir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value) + "\n");
};
const machineArtefacts = ["execution.json", "scrum-lanes.json", "scrum-profiles.json", "scrum-active-profile.json", "execution-switch.json"];
const projectArtefacts = ["execution.json", "scrum-lanes.json", "scrum-active-profile.json", "execution-switch.json", "scrum/runs/r1/events.jsonl"];

put("projects/alpha/placeholder", "x");
put("projects/beta/placeholder", "x");
for (const name of machineArtefacts) put(name, { schemaVersion: 1, mode: "scrum", revision: 1 });
for (const name of projectArtefacts) put(`projects/alpha/${name}`, name === "execution.json" ? legacy : { seeded: name });
put("projects/beta/execution.json", { schemaVersion: 1, mode: "slp", revision: 1 });
if (arm === "crashed") {
  // The previous lifetime wrote the settings record, then died before removing the legacy record.
  put("projects/alpha/project-settings.json", { schemaVersion: 1, revision: 1, skillPacks: ["expo", "science"], openDesignLink: link, openDesignSource: legacy.openDesignSource, openDesignCheckpointPaths: legacy.openDesignCheckpointPaths });
}

const server = {
  addHook: () => () => {}, on: () => () => {}, before: () => () => {}, handle: () => {},
} as unknown as Parameters<typeof contribute>[0];
const report = (label: string): void => {
  const gone = (relative: string) => !existsSync(join(stateDir, relative));
  const settings = (slug: string) => { const path = join(stateDir, "projects", slug, "project-settings.json"); return existsSync(path) ? readFileSync(path, "utf8") : null; };
  console.log(label + ":" + JSON.stringify({
    machineGone: machineArtefacts.every(gone),
    projectGone: projectArtefacts.every((name) => gone(`projects/alpha/${name}`)) && gone("projects/alpha/scrum"),
    betaLegacyGone: gone("projects/beta/execution.json"),
    alpha: settings("alpha"), beta: settings("beta"),
  }));
};
let stop = contribute(server); stop(); report("BOOT1");
stop = contribute(server); stop(); report("BOOT2");
