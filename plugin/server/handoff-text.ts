/** Plugin-owned handoff persistence bounds, shared by Lead and Peer succession. */

/**
 * The Lead handover file's metadata (v0.6.1, ADR 0057 §11 hygiene, spec story
 * 8): the outgoing Lead's agent id and the moment the plugin wrote the file,
 * recorded in an HTML-comment header so a later successor kickoff can date the
 * handover against the outgoing Lead's last activity instead of trusting an
 * undated file.
 */
export interface HandoffFileMetadata {
  leadId: string;
  writtenAt: string;
}

/** The header line the plugin prepends to `lead-handoff.md` when it writes it. */
export function renderHandoffFile(body: string, meta: HandoffFileMetadata): string {
  return `<!-- paseo-factory handoff: lead=${meta.leadId} written-at=${meta.writtenAt} -->\n\n${body}`;
}

/**
 * Splits a `lead-handoff.md` into its metadata header and body. A file the
 * feature predates (or one written by hand) has no header — `meta` is
 * undefined and the whole text is the body, which the successor kickoff treats
 * as stale-unknown, never fresh.
 */
export function parseHandoffFile(text: string): { meta: HandoffFileMetadata | undefined; body: string } {
  const match = /^<!--[^\n]*paseo-factory handoff: lead=(\S+) written-at=(\S+)[^\n]*-->\n?/.exec(text);
  if (match === null) return { meta: undefined, body: text };
  return {
    meta: { leadId: match[1] ?? "", writtenAt: match[2] ?? "" },
    body: text.slice(match[0].length).replace(/^\n+/, ""),
  };
}

export function capHandoffText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n...[truncated]";
  const budget = maxBytes - Buffer.byteLength(marker);
  let prefix = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    prefix += character;
    bytes += size;
  }
  const lastLine = prefix.lastIndexOf("\n");
  if (lastLine > 0) prefix = prefix.slice(0, lastLine);
  return prefix + marker;
}

/** Error/refusal one-liners are never continuity documents. */
export function validHandoffText(text: string | null | undefined): text is string {
  if (!text?.trim()) return false;
  const trimmed = text.trim();
  if (/outgoing (?:Lead|Peer) was interrupted during handoff extraction/i.test(trimmed)) return false;
  return trimmed.includes("\n") || !/^(?:the handoff was not written|permission denied|operation not permitted|(?:error|failed|unable)(?:\b|:)|i (?:cannot|can't|could not|couldn't|am unable to)\b)/i.test(trimmed);
}
