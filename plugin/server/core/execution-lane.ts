import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

/**
 * The Project ingress lock (ADR 0056): SLP directive and Contract admission for
 * one Project run strictly one after another, in submission order. A job that
 * re-enters its own Project's lane runs inline. The lock carries no execution
 * mode — SLP is the only way the Factory runs.
 */
const projectJobs = new Map<string, Promise<unknown>>();
const executionContext = new AsyncLocalStorage<{
  key: string;
  live: boolean;
}>();
export async function withExecutionLane<T>(
  state: string,
  slug: string,
  job: () => Promise<T>,
): Promise<T> {
  const key = join(state, slug),
    context = executionContext.getStore();
  if (context?.key === key && context.live) return job();
  const previous = projectJobs.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const lease = { key, live: true };
      try {
        return await executionContext.run(lease, job);
      } finally {
        lease.live = false;
      }
    });
  projectJobs.set(key, next);
  try {
    return await next;
  } finally {
    if (projectJobs.get(key) === next) projectJobs.delete(key);
  }
}
