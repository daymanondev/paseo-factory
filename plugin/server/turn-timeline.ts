/** Structural SDK boundary: these options and identities are optional on older hosts. */
export interface TurnTimelineEntry {
  seqEnd?: number;
  turnId?: string;
  item?: { type?: string; text?: string };
  type?: string;
  text?: string;
}

export interface TurnTimelineSource {
  refetch(options?: {
    direction?: "tail";
    limit?: number;
    wholeTurns?: boolean;
  }): Promise<{ entries?: TurnTimelineEntry[]; error?: string | null }>;
}

/** Read the completed turn without mistaking a later turn's reply for its handoff. */
export async function refetchTurnTimeline(source: TurnTimelineSource, turnId: string | null = null): Promise<TurnTimelineEntry[]> {
  if (turnId !== null) {
    try {
      const page = await source.refetch({ direction: "tail", limit: 1, wholeTurns: true });
      const entries = page.entries ?? [];
      // The SDK may silently omit wholeTurns for a host without the capability.
      // Responses have no acknowledgement. A one-item page is ambiguous (often
      // just turn_completed), so conservatively retry the legacy 20-item tail.
      if (!page.error && entries.length > 1 && entries.some(entry => entry.turnId === turnId)) {
        return entries.filter(entry => entry.turnId === turnId);
      }
    } catch { /* An older daemon may reject the new option outright. */ }
  }
  const page = await source.refetch({ direction: "tail", limit: 20 });
  const entries = page.error ? [] : page.entries ?? [];
  // Pre-identity daemons can only provide an unfiltered legacy tail. Once any
  // identity is present, never admit an unrelated or untagged reply.
  return turnId !== null && entries.some(entry => entry.turnId !== undefined)
    ? entries.filter(entry => entry.turnId === turnId)
    : entries;
}
