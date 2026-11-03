/** Plugin-owned handoff persistence bounds, shared by Lead and Peer succession. */
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
