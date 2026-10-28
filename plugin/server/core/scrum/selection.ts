/** Registration must read execution defaults without loading any roster, harness or journal. */
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { FactoryError } from "../errors.ts";
import { safeId } from "./types.ts";
export type FactoryExecutionMode = "slp" | "scrum";
export interface ExecutionSelection {
  schemaVersion: 1;
  mode: FactoryExecutionMode;
  revision: number;
}
export function selectionPath(state: string, slug?: string): string {
  if (slug !== undefined && !safeId(slug))
    throw new FactoryError("invalid-project-slug", slug);
  return slug === undefined
    ? join(state, "execution.json")
    : join(state, "projects", slug, "execution.json");
}
export function executionIsValid(value: unknown): value is ExecutionSelection {
  const v = value as ExecutionSelection | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.schemaVersion === 1 &&
    ["slp", "scrum"].includes(v.mode) &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0
  );
}
export function readExecution(
  state: string,
  slug?: string,
): ExecutionSelection {
  const path = selectionPath(state, slug);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, mode: "slp", revision: 0 };
    throw new FactoryError("execution-config-invalid", path);
  }
  if (!executionIsValid(value))
    throw new FactoryError("execution-config-invalid", path);
  return value;
}
export function registerExecutionSelection(
  state: string,
  slug: string,
): ExecutionSelection {
  const path = selectionPath(state, slug);
  if (existsSync(path)) return readExecution(state, slug);
  const next: ExecutionSelection = {
    schemaVersion: 1,
    mode: readExecution(state).mode,
    revision: 1,
  };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(next) + "\n", { mode: 0o600 });
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return next;
}
