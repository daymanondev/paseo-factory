/** JSON boundary for Helper MCP state: preserve damaged stores and replace private files atomically. */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readHelperJson(path: string, strict = false): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
    return value;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot safely read existing Helper MCP state; repair the JSON or its file permissions before syncing");
    return {};
  }
}
export function writeHelperJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally { rmSync(temporary, { force: true }); }
}
