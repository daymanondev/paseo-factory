/** Select one execution adapter at ingress; mode-local modules never implement the other mode. */
import type { Factory } from "./core/factory.ts";
import { FactoryError } from "./core/errors.ts";
import { readExecution } from "./core/scrum/config.ts";
import { assertExecutionReady } from "./core/scrum/execution.ts";
import { resolveProject } from "./core/project.ts";
import { prepareScrumContract } from "./scrum-contract.ts";
import { bindScrumDirective } from "./scrum-directive.ts";
const slp = {
  bind(_factory: Factory, _root: string, _slug: string, request: Parameters<typeof bindScrumDirective>[3]): ReturnType<typeof bindScrumDirective> {
    if (request.runId || request.scrum) throw new FactoryError("execution-mode-mismatch", "SLP directive cannot carry a Scrum run");
    return {};
  },
  prepare(_factory: Factory, request: Parameters<typeof prepareScrumContract>[1]): ReturnType<typeof prepareScrumContract> {
    if (request.runId || request.role || request.artifactRefs) throw new FactoryError("execution-mode-mismatch", "specialist fields require a Scrum Project");
    return {};
  },
};
function adapter(factory: Factory, slug: string) {
  assertExecutionReady(factory.stateDir, slug);
  return { slp, scrum: { bind: bindScrumDirective, prepare: prepareScrumContract } }[readExecution(factory.stateDir, slug).mode];
}
export function bindProjectDirective(...args: Parameters<typeof bindScrumDirective>) {
  return adapter(args[0], args[2]).bind(...args);
}
export function prepareProjectContract(...args: Parameters<typeof prepareScrumContract>) {
  const project = resolveProject(args[1].workspace);
  return project.ok ? adapter(args[0], project.slug).prepare(...args) : {};
}
