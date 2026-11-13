/**
 * A request channel owned by one contributed client (and therefore one host).
 * Workspace keys are always Project roots, including requests from Peer chats.
 * The SDK openPanel API carries no arbitrary focus payload. A sequence makes
 * repeated requests observable; consumption prevents old requests reopening.
 */
export interface SeatEditorRequest { readonly sequence: number; readonly target: string }
export function createSeatEditorRequests() {
  let sequence = 0;
  const pending = new Map<string, SeatEditorRequest>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(workspaceId: string): SeatEditorRequest | null { return pending.get(workspaceId) ?? null; },
    request(workspaceId: string, target: string): void { pending.set(workspaceId, { sequence: ++sequence, target }); notify(); },
    consume(workspaceId: string, request: SeatEditorRequest): void {
      if (pending.get(workspaceId)?.sequence !== request.sequence) return;
      pending.delete(workspaceId); notify();
    },
  };
}
export type SeatEditorRequests = ReturnType<typeof createSeatEditorRequests>;
