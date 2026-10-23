import type { VaultStatusView } from "../../shared/view.ts";
export { createResponseOrder } from "../kit/response-order.ts";

type Import = NonNullable<VaultStatusView["historyImports"]>[number];
export type VaultFeedback = { text: string; tone: "statusSuccess" | "statusWarning" | "statusDanger" };

/** Durable admission outcomes take precedence over transport completion. */
export function historyFeedback(imports?: readonly Import[]): VaultFeedback | null {
  if (imports === undefined || imports.length === 0) return null;
  const conflicts = imports.filter((item) => item.status === "conflicted");
  const pending = imports.filter((item) => item.status === "pending" || item.status === "staged");
  if (conflicts.length > 0) {
    const reason = conflicts.flatMap((item) => item.conflicts?.map((conflict) => conflict.reason) ?? item.diagnostics)[0];
    return { text: `History: ${conflicts.length} conflicted; originals retained${reason ? ` — ${reason}` : ""}${pending.length > 0 ? `; ${pending.length} pending` : ""}`, tone: "statusWarning" };
  }
  if (pending.length > 0) {
    const held = pending.find((item) => item.materialization !== undefined && item.materialization.status !== "applied");
    const detail = held?.materialization?.diagnostics[0];
    return { text: `History: ${pending.length} pending writer admission${detail ? ` — ${detail}` : ""}`, tone: "statusWarning" };
  }
  return { text: `History: ${imports.length} applied`, tone: "statusSuccess" };
}

export function actionFeedback(reply: { summary?: string; materialization?: Import["materialization"]; historyImports?: readonly Import[]; vault?: { historyImports?: readonly Import[] } }): VaultFeedback {
  const history = historyFeedback(reply.historyImports ?? reply.vault?.historyImports);
  const refused = reply.materialization !== undefined && reply.materialization.status !== "applied";
  const materialization = refused ? `Vault files ${reply.materialization!.status}: ${reply.materialization!.diagnostics.join("; ")}` : undefined;
  return { text: [reply.summary, history?.text, materialization].filter(Boolean).join("; "), tone: refused ? "statusWarning" : history?.tone ?? "statusSuccess" };
}
