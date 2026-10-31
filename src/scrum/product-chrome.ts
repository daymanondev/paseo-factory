import type { Diagnostic } from './linter.ts';
import type { DesignScreen } from './design-contract.ts';

/** Preserve offsets so diagnostics point into the submitted HTML. */
export function productChromeIssues(html: string, design: string, screens: DesignScreen[]): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const add = (offset: number, category: string, message: string) => issues.push({ path: 'mockups/index.html', line: html.slice(0, offset).split('\n').length, category, message });
  const markup = html.replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, m => m.replace(/[^\n]/g, ' '));
  const decodeEntity = (n: string) => {
    const value = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return String.fromCodePoint(value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? value : 0xfffd);
  };
  const visible = markup.replace(/<[^>]+>/g, m => ' '.repeat(m.length)).replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => decodeEntity(n)).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, m => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[m.toLowerCase()]!);
  const controls = [...markup.matchAll(/<(button|option)\b[^>]*>([^]*?)<\/\1\s*>/gi)];
  const rawStates = controls.filter(m => /^(?:empty|loading|populated|error|offline|permission-denied)$/i.test(m[2].replace(/<[^>]*>/g, '').trim()));
  const switcher = markup.match(/\bdata-target-(?:state|screen)\s*=|\bid\s*=\s*["']state-(?:select|switcher)["']/i);
  if (switcher || rawStates.length >= 2) add(switcher?.index ?? rawStates[0].index!, 'debug-chrome', 'Pure product chrome: move screen/state switchers to the outer studio');
  if (!/ui-copy-allow:\s*technical-identifiers/i.test(design)) {
    const jargon = /\b(?:ADR|FR|NFR|UJ|AD)-\d+\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[a-zA-Z0-9/_:.-]+|@[a-z0-9-]+\/[a-z0-9-]+|\b[a-z]+[A-Z][a-zA-Z0-9]*\s*\(|\b[a-z]+[A-Z][a-zA-Z0-9]*\s*=\s*(?:true|false|null|\d+)|\([a-z]+[A-Z][a-zA-Z0-9]*(?:\s+[^)]+)?\)/g;
    for (const match of visible.matchAll(jargon)) add(match.index!, 'ui-copy', `Replace internal technical copy: ${match[0]}`);
    for (const match of markup.matchAll(/\b(?:aria-label|title|placeholder|value)\s*=\s*["']([^"']*)["']/gi)) {
      if (jargon.test(match[1])) add(match.index!, 'ui-copy', 'Replace internal technical copy in control label');
      jargon.lastIndex = 0;
    }
  }
  const stack: Array<{ tag: string; screen?: string; start: number; populated?: boolean }> = [];
  const populatedRegions: Array<{ html: string; screen?: string }> = [];
  const regions = new Map<string, string>();
  for (const match of markup.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      const index = stack.findLastIndex(e => e.tag === tag);
      if (index >= 0) for (const el of stack.splice(index)) {
        const region = markup.slice(el.start, match.index! + match[0].length);
        if (el.screen) regions.set(el.screen, region);
        if (el.populated) populatedRegions.push({ html: region, screen: el.screen ?? stack.findLast(e => e.screen)?.screen });
      }
    } else if (!/\/$/.test(match[0].slice(0, -1)) && !/^(?:input|img|br|hr|meta|link|source|wbr|area|base|embed|param|track|col)$/.test(tag)) {
      const screen = match[0].match(/\bdata-screen\s*=\s*["']([^"']+)["']/)?.[1];
      stack.push({ tag, screen, start: match.index!, populated: /data-populated-for|(?:id|class)\s*=\s*['"][^'"]*populated/i.test(match[0]) });
    }
  }
  let shared = markup;
  for (const region of regions.values()) shared = shared.replace(region, '');
  for (const screen of screens.filter(s => s.surface === 'mobile')) {
    const region = regions.get(screen.id) ?? (screens.length === 1 ? markup : '');
    const table = region.match(/<table\b/i);
    if (table) add(markup.indexOf(region) + table.index!, 'mobile-shell', `${screen.id}: replace mobile tables with cards or list rows`);
    if (!/<nav\b|\brole\s*=\s*["'](?:tablist|navigation)["']/i.test(region + shared)) add(0, 'mobile-shell', `${screen.id}: Mobile app shell needs navigation inside its screen`);
  }
  const replacement = html.match(/(?:populated\w*|\w*populated\w*)\.hidden\s*=\s*(?:true|[^;\n]*[!=]==?\s*['"]populated['"])|data-populated-for|class\s*=\s*['"][^'"]*populated-content/i);
  if (replacement && /state-panel-|\.hidden\s*=\s*true/.test(html)) {
    for (const screen of screens) {
      const candidates = populatedRegions.filter(r => !r.screen || r.screen === screen.id);
      if (!candidates.length && populatedRegions.length) continue;
      let persistent = (regions.get(screen.id) ?? '') + shared;
      for (const region of candidates) persistent = persistent.replace(region.html, '');
      if (!/<nav\b|\brole\s*=\s*['"](?:tablist|navigation)['"]/i.test(persistent))
        add(replacement.index!, 'state-shell', `${screen.id}: preserve the app shell and navigation; render contextual states inside the content region`);
    }
  }
  return issues;
}
