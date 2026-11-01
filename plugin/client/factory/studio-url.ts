/** Probe every candidate, even when there is only one. Failed probes select RPC. */
export async function resolveReachableStudioUrl(candidates: readonly string[], expectedDigest?: string): Promise<string | null> {
  const check = async (candidate: string, timeoutMs: number) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(candidate);
      const response = await fetch(`${url.origin}/healthz${url.search}`, { signal: controller.signal });
      if (!response.ok) return null;
      const payload = await response.json() as { design?: { digest?: string } };
      return !expectedDigest || payload.design?.digest === expectedDigest ? candidate : null;
    } catch { return null; } finally { clearTimeout(timer); }
  };
  if (!candidates.length) return null;
  const local = await check(candidates[0], 1000); if (local) return local;
  return (await Promise.all(candidates.slice(1).map(c => check(c, 3500)))).find(c => c !== null) ?? null;
}
