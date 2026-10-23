import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponseOrder, historyFeedback, actionFeedback } from "../plugin/client/factory/vault-feedback.ts";

test("Vault feedback distinguishes pending/conflicted admission from successful transport and application", () => {
  const pending = { id: "one", target: "/state/ledger.jsonl", status: "pending" as const, diagnostics: [] };
  assert.equal(historyFeedback([pending])?.tone, "statusWarning");
  assert.match(historyFeedback([pending])!.text, /pending.*writer/i);
  assert.equal(actionFeedback({ summary: "Transport finished", historyImports: [pending] }).tone, "statusWarning");
  assert.equal(historyFeedback([{ ...pending, status: "applied" }])?.tone, "statusSuccess");
  const conflicted = historyFeedback([{ ...pending, status: "conflicted", conflicts: [{ reason: "unverified Workspace" }] }]);
  assert.equal(conflicted?.tone, "statusWarning"); assert.match(conflicted!.text, /unverified Workspace/);
  assert.equal(historyFeedback(undefined), null);
});

test("delayed pending poll/action responses cannot overwrite newer applied admission", async () => {
  const order = createResponseOrder();
  let resolve!: (value: string) => void;
  const slow = new Promise<string>((done) => { resolve = done; });
  const older = order.begin();
  let visible = "pending";
  const delayed = slow.then((value) => { if (order.current(older)) visible = value; });
  const newer = order.begin();
  if (order.current(newer)) visible = "applied";
  resolve("pending"); await delayed;
  assert.equal(visible, "applied");
  order.invalidate(); assert.equal(order.current(newer), false);
});

test("associated-file refusal remains a warning even when history is absent or already applied", () => {
  const materialization = { status: "refused" as const, diagnostics: ["use the Owner Vault RPC to materialize local files"] };
  for (const historyImports of [undefined, [{ id: "admitted", target: "/state/ledger.jsonl", status: "applied" as const, diagnostics: [] }]]) {
    const feedback = actionFeedback({ summary: "history fetched", materialization, historyImports });
    assert.equal(feedback.tone, "statusWarning");
    assert.match(feedback.text, /Owner Vault RPC/);
  }
});
