/** Read-only crash guard; incomplete maintenance never grants ordinary writes. */
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { historyTargetPath } from "./history-stage.ts";
export function pendingUpgradeFor(stateDir: string): string | undefined {
  const root = historyTargetPath(stateDir);
  const directory = join(dirname(root), `${basename(root)}-upgrades`);
  let names: string[];
  try { names = readdirSync(directory).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  for (const id of names.filter((name) => /^[a-f0-9-]{36}$/.test(name))) {
    let value: { version?: number; stateDir?: string; phase?: string };
    try { value = JSON.parse(readFileSync(join(directory, id, "manifest.json"), "utf8")); }
    catch { return id; }
    if (value.stateDir !== root || value.version !== 1 || !["applied", "restored"].includes(String(value.phase))) return id;
  }
  return undefined;
}
