/**
 * The sidecar's JSON RPC door — the Web Console's one transport (ADR 0051
 * §1). `factory.*` contracts ride POST `/rpc` against the same in-process
 * handlers the RN client's registrations call; refusals are data (the
 * `Failure` union), never exceptions.
 */
export type RpcFailure = { ok: false; code: string; error: string };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function invokeRpc<T>(
  method: string,
  params: unknown,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<{ ok: true; result: T } | RpcFailure> {
  try {
    const response = await fetchImpl("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    if (!response.ok) return { ok: false, code: `http_${response.status}`, error: `the console sidecar answered HTTP ${response.status}` };
    const payload = (await response.json()) as { ok: true; result: T } | RpcFailure;
    return payload;
  } catch (error) {
    return { ok: false, code: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
}
