/**
 * The console's Markdown fold (T-03) — Contract descriptions and Attempt
 * Reports render as the Markdown the Lead and the report writer actually
 * emit: headings, flat and nested `- ` bullets, paragraphs, `code` spans,
 * and **bold**. Hand-rolled React elements, never `innerHTML` — untrusted
 * ledger content can never inject markup, and no Markdown dependency joins
 * the bundle. Anything the fold does not model renders as honest plain text.
 */
import type { ReactNode } from "react";

/** Splits one line into code/bold spans — `code` first (its content is literal), then **bold**. */
function inlineSpans(text: string, keyPrefix: string): ReactNode[] {
  const spans: ReactNode[] = [];
  let rest = text;
  let index = 0;
  while (rest !== "") {
    const code = rest.indexOf("`");
    if (code === -1) {
      spans.push(...boldSpans(rest, `${keyPrefix}-${index}`));
      break;
    }
    const close = rest.indexOf("`", code + 1);
    if (close === -1) {
      spans.push(...boldSpans(rest, `${keyPrefix}-${index}`));
      break;
    }
    if (code > 0) spans.push(...boldSpans(rest.slice(0, code), `${keyPrefix}-${index}b`));
    spans.push(<code key={`${keyPrefix}-${index}c`}>{rest.slice(code + 1, close)}</code>);
    index += 1;
    rest = rest.slice(close + 1);
  }
  return spans;
}

function boldSpans(text: string, key: string): ReactNode[] {
  const parts = text.split("**");
  return parts.map((part, position) =>
    position % 2 === 1 ? <strong key={`${key}-${position}`}>{part}</strong> : <span key={`${key}-${position}`}>{part}</span>,
  );
}

interface ListItem {
  depth: number;
  spans: ReactNode[];
}

/**
 * Renders the Markdown the Factory writes — a block parser over lines:
 * `#`–`####` headings, `- ` bullets (two-space nesting), everything else
 * paragraph text. No tables, no links, no images: content outside the fold's
 * vocabulary stays readable plain text instead of half-rendered.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: ReactNode[] = [];
  let list: ListItem[] = [];
  let key = 0;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={`p-${key}`}>{paragraph}</p>);
    key += 1;
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key}`}>
        {list.map((item, position) => (
          <li key={`li-${position}`} style={item.depth > 0 ? { marginLeft: 18 } : undefined}>
            {item.spans}
          </li>
        ))}
      </ul>,
    );
    key += 1;
    list = [];
  };
  for (const line of text.split("\n")) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      const content = inlineSpans(heading[2]!, `h-${key}`);
      blocks.push(
        level === 1 ? <h3 key={`h-${key}`}>{content}</h3> : level === 2 ? <h4 key={`h-${key}`}>{content}</h4> : <h5 key={`h-${key}`}>{content}</h5>,
      );
      key += 1;
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flushParagraph();
      list.push({ depth: Math.floor(bullet[1]!.length / 2), spans: inlineSpans(bullet[2]!, `li-${key}-${list.length}`) });
      key += 1;
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(...inlineSpans(line, `p-${key}`));
    paragraph.push(" ");
    key += 1;
  }
  flushParagraph();
  flushList();
  return <div className={className === undefined || className === "" ? "console-markdown" : `console-markdown ${className}`}>{blocks}</div>;
}
