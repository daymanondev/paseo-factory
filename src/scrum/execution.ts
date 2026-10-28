import { join } from "node:path";
import { FactoryError } from "../errors.ts";
import {
  atomicJson,
  ensureScrumConfig,
  readExecution,
  readOptionalJson,
  scopeDir,
  scrumMutation,
} from "./config.ts";
import type { ExecutionSelection, FactoryExecutionMode } from "./config.ts";
export interface SwitchIntent {
  previous: ExecutionSelection;
  target: ExecutionSelection;
  status: "pending" | "complete";
}
export function readSwitchIntent(
  state: string,
  slug: string,
): SwitchIntent | undefined {
  return readOptionalJson(
    join(scopeDir(state, slug), "execution-switch.json"),
  ) as SwitchIntent | undefined;
}
export function assertExecutionReady(state: string, slug: string): void {
  if (readSwitchIntent(state, slug)?.status === "pending")
    throw new FactoryError(
      "execution-transition-pending",
      "execution-transition-pending: resume the interrupted mode switch before dispatch",
    );
}
const active = new Set<string>();
export async function switchExecution(input: {
  state: string;
  slug: string;
  mode: FactoryExecutionMode;
  blockers: string[];
  rotate: (target: ExecutionSelection) => Promise<void>;
}): Promise<ExecutionSelection> {
  const { state, slug, mode } = input;
  if (!["slp", "scrum"].includes(mode))
    throw new FactoryError("invalid-execution-mode", String(mode));
  const key = join(state, slug);
  if (active.has(key))
    throw new FactoryError("execution-mode-busy", "seat transition in flight");
  if (input.blockers.length)
    throw new FactoryError("execution-mode-busy", input.blockers.join(", "));
  active.add(key);
  try {
    const intent = scrumMutation(state, () => {
      const pending = readSwitchIntent(state, slug);
      if (pending?.status === "pending") {
        if (pending.target.mode !== mode)
          throw new FactoryError(
            "execution-transition-pending",
            `resume switch to ${pending.target.mode} first`,
          );
        return pending;
      }
      const previous = readExecution(state, slug);
      if (previous.mode === mode) return undefined;
      if (mode === "scrum") ensureScrumConfig(state, slug);
      const intent: SwitchIntent = {
        previous,
        target: { schemaVersion: 1, mode, revision: previous.revision + 1 },
        status: "pending",
      };
      atomicJson(join(scopeDir(state, slug), "execution-switch.json"), intent);
      atomicJson(join(scopeDir(state, slug), "execution.json"), intent.target);
      return intent;
    });
    if (intent === undefined) return readExecution(state, slug);
    await input.rotate(intent.target);
    scrumMutation(state, () =>
      atomicJson(join(scopeDir(state, slug), "execution-switch.json"), {
        ...intent,
        status: "complete",
      }),
    );
    return intent.target;
  } finally {
    active.delete(key);
  }
}

/** Shared Project ingress lock: mode transition and directive admission cannot overtake each other. */
const projectJobs = new Map<string, Promise<unknown>>();
export async function withExecutionLane<T>(
  state: string,
  slug: string,
  job: () => Promise<T>,
): Promise<T> {
  const key = join(state, slug),
    previous = projectJobs.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(job);
  projectJobs.set(key, next);
  try {
    return await next;
  } finally {
    if (projectJobs.get(key) === next) projectJobs.delete(key);
  }
}
