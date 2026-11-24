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

import { realpathSync } from "node:fs";

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prepareNormalizedRoots(roots: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const raw of roots) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    for (const candidate of [trimmed, realpathSafe(trimmed)]) {
      const fwd = candidate.replace(/\\/g, "/").replace(/\/+$/, "");
      if (fwd === "" || /^[A-Za-z]:$/.test(fwd)) continue;
      candidates.add(fwd);
    }
  }
  return [...candidates].sort((a, b) => b.length - a.length);
}

function rootToPattern(fwdRoot: string): string {
  return fwdRoot.split("/").map(escapeRegExp).join("[\\\\/]");
}

function matchRootRelativePath(value: string, rootRegexes: readonly RegExp[]): string | undefined {
  for (const re of rootRegexes) {
    const m = re.exec(value);
    if (m !== null && typeof m[1] === "string" && m[1] !== "") {
      return m[1].replace(/\\/g, "/");
    }
  }
  return undefined;
}

/**
 * Pure, idempotent path normalizer stripping exact worktree / project-root
 * prefixes (including `file://` URLs and `[label](...)` Markdown links) down
 * to repo-relative forward-slashed paths without altering external URLs,
 * relative paths, or code/tool symbols.
 */
export function normalizeHandoffPaths(text: string, roots: readonly string[]): string {
  if (text === "") return text;
  const sortedRoots = prepareNormalizedRoots(roots);
  if (sortedRoots.length === 0) return text;

  const rootPatterns = sortedRoots.map(rootToPattern);
  const rootAlt = rootPatterns.join("|");
  const exactRelRegexes = rootPatterns.map(
    (pat) => new RegExp(`^(?:file:\\/\\/(?:localhost)?(?:\\/(?=[A-Za-z]:))?)?${pat}[\\\\/]+(.+)$`),
  );

  // 1. Markdown links: [label](file://<root>/<rel>) or [label](<root>/<rel>)
  let result = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (full, label: string, target: string) => {
      const relTarget = matchRootRelativePath(target, exactRelRegexes);
      if (relTarget === undefined) return full;
      const relLabel = matchRootRelativePath(label, exactRelRegexes);
      const nextLabel = relLabel !== undefined ? relLabel : label;
      return `[${nextLabel}](${relTarget})`;
    },
  );

  // 2. Bare file://<root>/<rel> URLs
  const bareFileRe = new RegExp(
    `(^|[\\s(\\[\\\`"':,=])file:\\/\\/(?:localhost)?(?:\\/(?=[A-Za-z]:))?(?:${rootAlt})[\\\\/]+([^\\s)"'\\]\\\`<>]+)`,
    "g",
  );
  result = result.replace(bareFileRe, (_full, prefix: string, rel: string) => `${prefix}${rel.replace(/\\/g, "/")}`);

  // 3. Standalone <root>/<rel> filesystem paths
  const standaloneRe = new RegExp(
    `(^|[\\s(\\[\\\`"':,=])(?:${rootAlt})[\\\\/]+([^\\s)"'\\]\\\`<>]+)`,
    "g",
  );
  result = result.replace(standaloneRe, (_full, prefix: string, rel: string) => `${prefix}${rel.replace(/\\/g, "/")}`);

  return result;
}

function sliceUtf8ToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text === "") return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes + 1);
  if (end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  const bounded = text.slice(0, end);
  let prefix = "";
  let bytes = 0;
  for (const character of bounded) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    prefix += character;
    bytes += size;
  }
  return prefix;
}

function truncateAtLineBoundary(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n...[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    const compactMarker = "...[truncated]";
    if (maxBytes <= Buffer.byteLength(compactMarker, "utf8")) {
      return sliceUtf8ToBytes(text, maxBytes);
    }
    const prefix = sliceUtf8ToBytes(text, maxBytes - Buffer.byteLength(compactMarker, "utf8"));
    return prefix + compactMarker;
  }
  const budget = maxBytes - markerBytes;
  let prefix = sliceUtf8ToBytes(text, budget);
  const lastLine = prefix.lastIndexOf("\n");
  if (lastLine > 0) prefix = prefix.slice(0, lastLine);
  return prefix + marker;
}

function trimSectionToBudget(sectionText: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(sectionText, "utf8") <= maxBytes) return sectionText;
  const firstNewline = sectionText.indexOf("\n");
  if (firstNewline === -1) {
    return truncateAtLineBoundary(sectionText, maxBytes);
  }
  const heading = sectionText.slice(0, firstNewline);
  const marker = "\n...[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headingBytes = Buffer.byteLength(heading, "utf8");
  if (headingBytes + markerBytes > maxBytes) {
    return truncateAtLineBoundary(sectionText, maxBytes);
  }
  const body = sectionText.slice(firstNewline + 1);
  const bodyLines = body.split("\n");
  let kept = heading;
  let usedBytes = headingBytes;
  let keptAnyBodyLine = false;
  for (const line of bodyLines) {
    const addition = `\n${line}`;
    const addBytes = Buffer.byteLength(addition, "utf8");
    if (usedBytes + addBytes + markerBytes > maxBytes) break;
    kept += addition;
    usedBytes += addBytes;
    keptAnyBodyLine = true;
  }
  if (!keptAnyBodyLine) {
    const remainingForBody = maxBytes - headingBytes - markerBytes - 1;
    if (remainingForBody > 0) {
      const slicedBody = sliceUtf8ToBytes(bodyLines[0] ?? "", remainingForBody);
      if (slicedBody !== "") {
        kept += `\n${slicedBody}`;
      }
    }
  }
  return kept + marker;
}

export function capHandoffText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  if (maxBytes <= 128) return truncateAtLineBoundary(text, maxBytes);

  const lines = text.split("\n");
  const headingIndices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{1,2}\s+/.test(lines[i]!)) headingIndices.push(i);
  }
  if (headingIndices.length === 0) {
    return truncateAtLineBoundary(text, maxBytes);
  }

  let preamble: string | undefined =
    headingIndices[0]! > 0 ? lines.slice(0, headingIndices[0]!).join("\n") : undefined;
  const sections: string[] = [];
  for (let k = 0; k < headingIndices.length; k += 1) {
    const start = headingIndices[k]!;
    const end = k + 1 < headingIndices.length ? headingIndices[k + 1]! : lines.length;
    sections.push(lines.slice(start, end).join("\n"));
  }

  const floor = Math.min(512, Math.floor(maxBytes / (Math.max(1, sections.length) * 2)));
  const currentTotalBytes = (): number => {
    const parts = preamble !== undefined ? [preamble, ...sections] : sections;
    return Buffer.byteLength(parts.join("\n"), "utf8");
  };

  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const total = currentTotalBytes();
    if (total <= maxBytes) break;
    const excess = total - maxBytes;
    const secBytes = Buffer.byteLength(sections[i]!, "utf8");
    if (secBytes <= floor) continue;
    const targetBytes = Math.max(floor, secBytes - excess);
    sections[i] = trimSectionToBudget(sections[i]!, targetBytes);
  }

  if (preamble !== undefined) {
    const total = currentTotalBytes();
    if (total > maxBytes) {
      const excess = total - maxBytes;
      const preambleBytes = Buffer.byteLength(preamble, "utf8");
      if (preambleBytes > floor) {
        preamble = truncateAtLineBoundary(preamble, Math.max(floor, preambleBytes - excess));
      }
    }
  }

  const joined = (preamble !== undefined ? [preamble, ...sections] : sections).join("\n");
  if (Buffer.byteLength(joined, "utf8") <= maxBytes) return joined;
  return truncateAtLineBoundary(joined, maxBytes);
}

/** Error/refusal one-liners are never continuity documents. */
export function validHandoffText(text: string | null | undefined): text is string {
  if (!text?.trim()) return false;
  const trimmed = text.trim();
  if (/outgoing (?:Lead|Peer) was interrupted during handoff extraction/i.test(trimmed)) return false;
  return trimmed.includes("\n") || !/^(?:the handoff was not written|permission denied|operation not permitted|(?:error|failed|unable)(?:\b|:)|i (?:cannot|can't|could not|couldn't|am unable to)\b)/i.test(trimmed);
}
