import { test } from "node:test";
import assert from "node:assert/strict";
import { planLegacyIdentity } from "../src/history-identity.ts";
import { parseLedgerJsonl } from "../src/ledger-validation.ts";
import { planHistoryImport } from "../src/history-import.ts";
import { parseLedgerJsonl as copiedParse } from "../plugin/server/core/ledger-validation.ts";

const row = { seq: 1, ts: "2026-10-23T00:00:00.000Z", event: "retro_written", model: "fixture", outcome: "failed", durationMs: 1, error: "unavailable" };
const local = planLegacyIdentity("", { writerId: "local" }).events.map((event) => JSON.stringify(event) + "\n").join("");

for (const ts of ["not-a-time", "2026-10-23T00:00:00", "2026-10-23T01:00:00+01:00", "2026-02-30T00:00:00Z", "2026-10-23T25:00:00Z", ""]) {
  test(`invalid time ${JSON.stringify(ts)} remains readable legacy bytes but cannot become identified evidence`, () => {
    const original = JSON.stringify({ ...row, ts }) + "\n";
    assert.equal(parseLedgerJsonl(original).events?.[0]?.ts, ts, "historical legacy reader compatibility is unchanged");
    const upgrade = planLegacyIdentity(original, { writerId: "new-writer" });
    assert.equal(upgrade.ok, false);
    assert.match(upgrade.conflicts.join("\n"), /timestamp/);
    const prepared = planLegacyIdentity(JSON.stringify(row) + "\n", { writerId: "source" });
    const events = prepared.events.map((event) => event.event === "retro_written" ? { ...event, ts } : event);
    const source = events.map((event) => JSON.stringify(event) + "\n").join("");
    for (const read of [parseLedgerJsonl, copiedParse]) assert.match(read(source).corrupt ?? "", /timestamp/);
    const imported = planHistoryImport({ existingLines: local, sources: [{ nodeId: "source-holder", lines: source }] });
    assert.equal(imported.status, "conflicted");
    assert.equal(imported.sources[0]?.lines, source);
    assert.deepEqual(Buffer.from(imported.sources[0]!.bytes), Buffer.from(source));
    assert.equal(imported.lines, local);
    assert.deepEqual(imported.additions, []);
  });
}

for (const ts of ["2026-10-23T00:00:00Z", "2026-10-23T00:00:00.123Z", "2026-10-23T00:00:00.123456Z", "2026-10-23T00:00:00+00:00", "2000-02-29T12:34:56Z"]) {
  test(`recorded UTC time ${ts} survives explicit identity preparation and import verbatim`, () => {
    const raw = JSON.stringify({ ...row, ts }) + "\n";
    const prepared = planLegacyIdentity(raw, { writerId: "source" });
    assert.equal(prepared.ok, true);
    const source = prepared.events.map((event) => JSON.stringify(event) + "\n").join("");
    const imported = planHistoryImport({ existingLines: local, sources: [{ nodeId: "source-holder", lines: source }] });
    assert.equal(imported.status, "ready");
    assert.equal(imported.additions[0]?.ts, ts);
  });
}
