import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveImportManifest, type ImportManifest } from "../plugin/server/core/history-stage.ts";
import { historyImportsViaSidecar } from "../web/src/history.ts";
import { historyImportsModel } from "../web/src/settings-view.ts";
import { makeConsoleFixture } from "./console-fixture.ts";
import { makeTempDir } from "./helpers.ts";

/**
 * The recurrence guard RG-1 (T-14a): ONE test drives the Settings screen's
 * read-only History imports section through the console's REAL transport —
 * `web/src/history.ts` `historyImportsViaSidecar`, the exact function the
 * browser bundle calls — against a REAL started sidecar over a REAL Factory
 * fixture whose history import state is seeded in the fixture home through
 * the core's own durable manifest writer (`saveImportManifest`): the honest
 * empty first (the reader scans the import directories on every call), then
 * three root rows (applied with its counts, conflicted with its reason, and
 * a staged row held on its vault materialization) plus one registered
 * Project's own row, exactly the shapes `allStatus()` reads across the root
 * Factory and its Projects. The reply's rows ride verbatim and the screen's fold
 * (`historyImportsModel`) carries them honestly. The sibling writes stay
 * OUTSIDE the door: `factory.history.import` and `factory.history.upgrade`
 * answer 404 `unknown_method` (a later wave, pending Owner review).
 */

/** One seeded manifest — written through the real durable writer, never a raw file dump. */
function seedImport(target: string, id: string, over: Partial<ImportManifest> & Pick<ImportManifest, "status" | "diagnostics">): void {
  saveImportManifest({
    version: 1,
    id,
    target,
    sources: [],
    createdAt: "2026-11-08T09:00:00.000Z",
    ...over,
  });
}

test("RG-1: the console's real transport reads the seeded history imports — and the sibling writes stay outside the door", async (t) => {
  const homeRoot = makeTempDir();
  const fixture = makeConsoleFixture(homeRoot);
  const stateDir = fixture.stateDir;
  t.after(async () => {
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const started = await fixture.start();
  assert.ok(started.ok, started.ok ? "" : started.reason);
  t.after(async () => {
    await started.sidecar.close();
  });
  const fetchAt = fixture.atSidecar(started.sidecar);

  // (a) The honest empty first — a home with no imports reads the empty list
  // through the real transport (the reader scans the import directories on
  // every call, so the rows seeded below land without a restart).
  const empty = await historyImportsViaSidecar({}, fetchAt);
  assert.equal(empty.ok, true, empty.ok ? "" : empty.error);
  assert.ok(empty.ok);
  assert.deepEqual(empty.imports, [], "a home with no history imports reads the honest empty");

  // The seeded state — every status the schema spells, in the reader's own
  // sorted order (the id is the sort key): an applied root import with its
  // counts, a conflicted one with its reason, and a staged one held on its
  // vault materialization (the writer's drain skips exactly these three).
  const rootLedger = join(stateDir, "ledger.jsonl");
  seedImport(rootLedger, "1a".repeat(32), {
    status: "applied",
    added: 12,
    duplicates: 3,
    diagnostics: ["history admitted by the live writer"],
  });
  seedImport(rootLedger, "2b".repeat(32), {
    status: "conflicted",
    conflicts: [{ reason: "duplicate event ids", sourceId: "node-b" }],
    diagnostics: ["import refused: 1 conflict(s)"],
  });
  seedImport(rootLedger, "3c".repeat(32), {
    status: "staged",
    diagnostics: ["snapshot fetched and staged; Ledger owner admission pending"],
    materialization: { status: "pending", diagnostics: ["vault materialization waits on the writer"] },
  });

  // A registered Project's own import — the per-Project half of `allStatus()`.
  const projectSlug = "patigame";
  const projectState = join(stateDir, "projects", projectSlug);
  mkdirSync(projectState, { recursive: true });
  writeFileSync(join(projectState, "project.json"), `${JSON.stringify({ slug: projectSlug, root: join(homeRoot, projectSlug) })}\n`);
  const projectLedger = join(projectState, "ledger.jsonl");
  seedImport(projectLedger, "4d".repeat(32), {
    status: "applied",
    added: 5,
    diagnostics: ["history admitted by the live writer"],
  });

  // (b) The real web client reads the seeded rows — every status, count, and
  // diagnostic verbatim, root rows first then the Project's own.
  const reply = await historyImportsViaSidecar({}, fetchAt);
  assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
  assert.ok(reply.ok);
  assert.deepEqual(
    reply.imports.map((row) => ({ id: row.id.slice(0, 2), status: row.status, target: row.target, added: row.added ?? null, duplicates: row.duplicates ?? null })),
    [
      { id: "1a", status: "applied", target: rootLedger, added: 12, duplicates: 3 },
      { id: "2b", status: "conflicted", target: rootLedger, added: null, duplicates: null },
      { id: "3c", status: "staged", target: rootLedger, added: null, duplicates: null },
      { id: "4d", status: "applied", target: projectLedger, added: 5, duplicates: null },
    ],
    "the door answers the seeded rows verbatim across the root Factory and the Project",
  );
  assert.deepEqual(reply.imports[1]!.conflicts, [{ reason: "duplicate event ids", sourceId: "node-b" }], "the conflict reasons ride verbatim");
  assert.deepEqual(reply.imports[2]!.materialization, { status: "pending", diagnostics: ["vault materialization waits on the writer"] }, "the materialization hold rides verbatim");
  assert.deepEqual(reply.imports[0]!.diagnostics, ["history admitted by the live writer"], "the writer's diagnostics ride verbatim");

  // (c) The screen's fold carries the rows honestly — the short ids, the
  // per-Project/node labels, and the counts the writer counted.
  const model = historyImportsModel(reply.imports);
  assert.deepEqual(
    model.rows.map((row) => ({ shortId: row.shortId.slice(0, 2), statusLabel: row.statusLabel, targetLabel: row.targetLabel, added: row.added, duplicates: row.duplicates })),
    [
      { shortId: "1a", statusLabel: "applied", targetLabel: "root Factory", added: 12, duplicates: 3 },
      { shortId: "2b", statusLabel: "conflicted", targetLabel: "root Factory", added: null, duplicates: null },
      { shortId: "3c", statusLabel: "staged", targetLabel: "root Factory", added: null, duplicates: null },
      { shortId: "4d", statusLabel: "applied", targetLabel: projectSlug, added: 5, duplicates: null },
    ],
    "the fold renders every row's honest facts",
  );

  // (d) The sibling writes stay OUTSIDE the door — both answer 404
  // `unknown_method`, and the refusal sentence names the read that IS in.
  for (const method of ["factory.history.import", "factory.history.upgrade"]) {
    const refusal = await fetchAt("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: {} }),
    });
    assert.equal(refusal.status, 404, `${method} stays outside the door`);
    const payload = (await refusal.json()) as { ok: boolean; code?: string; error?: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "unknown_method");
    assert.match(payload.error ?? "", /factory\.history\.imports/, "the sentence names the history read the door does serve");
  }
});
