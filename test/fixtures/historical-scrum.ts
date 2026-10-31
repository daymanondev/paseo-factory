/** Persist a pre-ADR-0040 creation record to exercise historical run compatibility. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScrumRun, readRun } from '../../src/scrum/run-journal.ts';
import { scopeDir } from '../../src/scrum/config.ts';
export function createHistoricalScrumRun(input: Parameters<typeof createScrumRun>[0]) {
  const run = createScrumRun(input);
  const path = join(scopeDir(input.state, input.slug), 'scrum/runs', run.runId, 'events.jsonl');
  const event = JSON.parse(readFileSync(path, 'utf8'));
  event.payload.run.policyRevision = '0038-r1';
  writeFileSync(path, JSON.stringify(event) + '\n');
  return readRun(input.state, input.slug, run.runId);
}
