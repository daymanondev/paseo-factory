import { useRef, useState } from "react";
import type { GateQueueView } from "../../shared/view.ts";

export type GateQueueCancelReply =
  | { ok: true; gateQueue: GateQueueView }
  | { ok: false; error?: string };

/**
 * Shared in-flight tracking, scope guarding, and RPC error/success callbacks
 * for Gate queue cancellation across Project panel (`shell.tsx`) and Overview (`overview-screen.tsx`).
 */
export function useGateQueueCancel(options: {
  call: (input: { queueId: string }) => Promise<GateQueueCancelReply>;
  mountedRef: { current: boolean };
  scopeKey?: unknown;
  onStart?: (id: string) => void;
  onSuccess?: (gateQueue: GateQueueView) => void;
  onFailure?: (id: string, message: string) => void;
}) {
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);
  const cancellingIdsRef = useRef<Set<string>>(new Set());
  const scopeKeyRef = useRef(options.scopeKey);
  scopeKeyRef.current = options.scopeKey;

  const cancelItem = async (id: string): Promise<void> => {
    if (cancellingIdsRef.current.has(id)) return;
    const callScope = options.scopeKey;
    cancellingIdsRef.current.add(id);
    setCancellingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    options.onStart?.(id);
    try {
      const reply = await options.call({ queueId: id });
      if (!options.mountedRef.current || scopeKeyRef.current !== callScope) return;
      if (!reply.ok) {
        options.onFailure?.(id, reply.error || "Could not cancel Gate queue item.");
        return;
      }
      options.onSuccess?.(reply.gateQueue);
    } catch (error) {
      if (!options.mountedRef.current || scopeKeyRef.current !== callScope) return;
      options.onFailure?.(id, error instanceof Error ? error.message : String(error));
    } finally {
      cancellingIdsRef.current.delete(id);
      if (options.mountedRef.current) {
        setCancellingIds((prev) => prev.filter((item) => item !== id));
      }
    }
  };

  return { cancellingIds, cancelItem };
}
