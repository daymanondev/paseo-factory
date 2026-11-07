/**
 * The sidecar's JSON RPC door — the Web Console's one transport (ADR 0051
 * §1). `factory.*` contracts ride POST `/rpc` against the same in-process
 * handlers the RN client's registrations call; refusals are data (the
 * `Failure` union), never exceptions.
 *
 * The envelope law: the console consumes each RPC's shared output schema
 * (`plugin/shared/rpc.ts`) exactly as the sidecar returns it — `S` is the
 * success arm of that output union (e.g. `{ view: FactoryView }` for
 * `factory.snapshot`), carried verbatim, never re-wrapped behind an ad-hoc
 * `result` key. Transport-level failures (HTTP non-2xx, unreachable) and
 * the sidecar's own refusal bodies both resolve as `Failure`-shaped data.
 */
export type RpcFailure = { ok: false; code: string; error: string };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function invokeRpc<S extends object>(
  method: string,
  params: unknown,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<({ ok: true } & S) | RpcFailure> {
  try {
    const response = await fetchImpl("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    if (!response.ok) {
      // A refusal body the sidecar wrote (unknown method, bad request) passes
      // through verbatim — its `Failure` shape carries the truer code.
      try {
        const refusal = (await response.json()) as RpcFailure;
        if (refusal?.ok === false && typeof refusal.code === "string" && typeof refusal.error === "string") return refusal;
      } catch {
        // not JSON — degrade to the status-coded refusal below
      }
      return { ok: false, code: `http_${response.status}`, error: `the console sidecar answered HTTP ${response.status}` };
    }
    return (await response.json()) as ({ ok: true } & S) | RpcFailure;
  } catch (error) {
    return { ok: false, code: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
}
