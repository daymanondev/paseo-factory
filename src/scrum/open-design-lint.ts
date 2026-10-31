import { OPEN_DESIGN_FRAMES } from './open-design-assets.ts';
import { posix } from 'node:path';
import type { Diagnostic } from './linter.ts';
import { designScreens } from './design-contract.ts';

/** References stay relative to the mockups directory, including nested frame assets. */
export function offlineAssetPath(path: string, reference: string): string | null {
  if (/^(?:#|data:|blob:)/i.test(reference)) return null;
  const clean = reference.split(/[?#]/)[0];
  if (!clean) return null;
  if (/^(?:[a-z][\w+.-]*:|\/|\\)/i.test(clean) || /\\|\0/.test(clean)) throw Error(`unsafe offline asset ${reference}`);
  const resolved = posix.normalize(posix.join(posix.dirname(path), clean));
  if (!resolved.startsWith('mockups/')) throw Error(`asset escapes mockups: ${reference}`);
  return resolved;
}

function stripCssTrivia(css: string) { return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1)[^\\])*?\1/g, '""'); }
function cssBalanced(css: string) {
  let depth = 0;
  for (const c of stripCssTrivia(css)) { if (c === '{') depth++; else if (c === '}' && --depth < 0) return false; }
  return depth === 0;
}
const visible = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, ' ').replace(/&#(?:x[\da-f]+|\d+);/gi, 'x').replace(/\s+/g, ' ').trim();

/** Inspect supported HTML string/template literals without evaluating submitted code. Preserve line offsets. */
export function artifactMarkup(source: string, javascript = false): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const templates = (script: string) => {
    let cursor = 0, result = '';
    for (const match of script.matchAll(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g)) {
      result += blank(script.slice(cursor, match.index));
      result += /<[a-z][^>]*>/i.test(match[0]) ? ' ' + match[0].slice(1, -1) + ' ' : blank(match[0]);
      cursor = match.index! + match[0].length;
    }
    return result + blank(script.slice(cursor));
  };
  return javascript ? templates(source) : source.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi, (match, tag: string, body: string) => tag?.toLowerCase() === 'script' ? blank(match.slice(0, match.indexOf('>') + 1)) + templates(body) + blank(match.slice(match.lastIndexOf('</'))) : blank(match));
}

/** Deterministic artifact lint, adapted from Open Design lintArtifact P0/P1 + Factory mobile craft. */
export function runOpenDesignLint(files: Record<string, string>): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const design = files['DESIGN.md'] ?? '';
  const screens = designScreens(files['EXPERIENCE.md'] ?? '');
  for (const [path, source] of Object.entries(files).filter(([p]) => /^mockups\/.*\.(?:html|css|js)$/.test(p))) {
    const add = (category: string, message: string, offset = 0) => issues.push({ path, line: source.slice(0, offset).split('\n').length, category, message });
    const html = source.replace(/<!--[\s\S]*?-->/g, '');
    const css = path.endsWith('.css') ? [source] : [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
    for (const block of css) if (!cssBalanced(block)) add('css-syntax', 'CSS braces must be balanced');
    const scripts = path.endsWith('.js') ? [source] : [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/\bsrc\s*=/.test(m[1]) && !/type\s*=\s*['"](?:application\/ld\+json|application\/json|importmap)['"]/.test(m[1])).map(m => m[2]);
    for (const script of scripts) {
      try { new Function(script); } catch (error) { add('js-syntax', `Invalid JavaScript: ${(error as Error).message}`); }
    }
    const references = path.endsWith('.html') ? [...html.matchAll(/\b(?:src|href|poster)\s*=\s*['"]([^'"]+)['"]/gi)].map(m => m[1]) : [];
    for (const block of css) references.push(...[...block.matchAll(/url\(\s*['"]?([^\s'"\)]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/gi)].map(m => m[1] ?? m[2]));
    for (const script of scripts) references.push(...[...script.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|new\s+URL\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]));
    for (const reference of references) {
      try { const target = offlineAssetPath(path, reference); if (target && files[target] === undefined) add('offline-asset', `Missing offline asset ${reference}`); }
      catch (error) { add('offline-asset', (error as Error).message); }
    }
    if (/\b(?:fetch\s*\(|XMLHttpRequest\b|WebSocket\b|EventSource\b)/.test(html)) add('offline', 'Use local offline data; network calls are disabled');
    // Hardware frames are vendored presentation assets, not product palette/copy.
    if (path.includes('/.od-frames/')) continue;
    let authoredCss = css.join('\n');
    for (const frame of Object.values(OPEN_DESIGN_FRAMES)) {
      for (const block of frame.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) authoredCss = authoredCss.replace(block[1], '');
    }
    const cssText = authoredCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const gradient of cssText.matchAll(/(?:linear|radial)-gradient\([^;]+/gi)) {
      if (/(?:purple|violet|#(?:a855f7|9333ea|7c3aed|6d28d9|581c87|8b5cf6|a78bfa|c4b5fd|ddd6fe|ede9fe|6366f1|4f46e5|4338ca|3730a3|312e81|818cf8|a5b4fc|c7d2fe|e0e7ff|eef2ff))\b/i.test(gradient[0])) add('purple-gradient', 'Use a flat token surface instead of a purple gradient');
      if (/(?:#(?:3b82f6|2563eb|1d4ed8|1e40af|1e3a8a|60a5fa|93c5fd|bfdbfe|0ea5e9|0284c7|0369a1|38bdf8|7dd3fc)|\bblue\b)/i.test(gradient[0]) && /(?:#(?:06b6d4|0891b2|0e7490|155e75|164e63|22d3ee|67e8f9|a5f3fc)|\bcyan\b)/i.test(gradient[0])) add('trust-gradient', 'Replace blue/cyan trust gradients with a single token surface');
    }
    const untokenized = cssText.replace(/:root\s*\{[^}]*\}/g, '');
    if (/#(?:6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7)\b/i.test(untokenized)) add('ai-default-indigo', 'Bind intentional accent colors through :root tokens');
    if ((untokenized.match(/#[\da-f]{3,8}\b/gi) ?? []).length > 12) add('raw-hex', 'Move repeated color literals into :root tokens');
    for (const rule of cssText.matchAll(/[^{}]+\{([^{}]+)\}/g)) if (/border-left\s*:\s*[^;]*(?:solid|var\()/i.test(rule[1]) && /border-radius\s*:\s*[1-9]/i.test(rule[1])) add('left-accent-card', 'Use soft tonal surfaces or structural rules instead of rounded left-accent cards');
    if (/\.scrollIntoView\s*\(/.test(html)) add('scroll-into-view', 'Scroll the product scroller with scrollTo rather than moving the host page');
    if (/<img\b[^>]*src\s*=\s*['"](?:https?:|\/\/)/i.test(html)) add('external-image', 'Bundle images locally for offline rendering');
    const markup = artifactMarkup(source, path.endsWith('.js'));
    if (/<(?:h[1-6]|button|li|span)\b[^>]*>[^<]*[\u{1f300}-\u{1faff}\u2600-\u27bf]/u.test(markup)) add('emoji-icon', 'Use inline SVG product icons');
    const copy = path.endsWith('.js') ? source : visible(markup);
    if (/\b(?:10|100)[×x]\s+(?:faster|better|easier)|\b99\.\d+%\s+uptime|\bzero[- ]downtime|\b3[×x]\s+more\s+(?:productive|efficient)/i.test(copy)) add('invented-metric', 'Replace unsupported metrics with brief-derived product copy');
    if (/\b(?:lorem ipsum|dolor sit amet|placeholder text|sample content|feature (?:one|two|three|1|2|3))\b/i.test(copy)) add('filler-copy', 'Replace filler with real domain copy');
    if (!/ui-copy-allow:\s*technical-identifiers/i.test(design) && /\b(?:FR|NFR|UJ|AD|ADR)-\d+\b/.test(visible(markup))) add('ui-copy', 'Keep spec identifiers in documentation');
    if (!/\.(?:html|js)$/.test(path)) continue;
    // A small tag stack scopes mobile rules and paragraph budgets without touching private renderer state.
    const stack: Array<{ tag: string; mobile: boolean; card: boolean }> = [];
    for (const m of markup.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)) {
      const tag = m[1].toLowerCase();
      if (m[0].startsWith('</')) { const i = stack.findLastIndex(e => e.tag === tag); if (i >= 0) stack.splice(i); continue; }
      const id = m[0].match(/data-screen\s*=\s*['"]([^'"]+)['"]/)?.[1];
      const surface = m[0].match(/data-surface\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? screens.find(s => s.id === id)?.surface;
      const mobile = surface ? surface !== 'desktop' : stack.at(-1)?.mobile ?? (screens.length > 0 && screens.every(s => s.surface !== 'desktop'));
      const card = /class\s*=\s*['"][^'"]*\b(?:card|tile|od-tile)\b/i.test(m[0]) || stack.some(e => e.card);
      if (mobile && tag === 'select' && !/ui-copy-allow:\s*native-select/i.test(design)) add('mobile-native-select', 'Use focused wizard steps, choice chips or radio cards on mobile', m.index);
      if (mobile && tag === 'table' && /<tr\b[^>]*>[\s\S]*?<t[dh]\b[^>]*>[\s\S]*?<t[dh]\b/i.test(markup.slice(m.index, markup.indexOf('</table>', m.index) + 8))) add('mobile-table', 'Replace multi-column mobile tables with cards or list rows', m.index);
      if (card && tag === 'p') { const end = markup.indexOf('</p>', m.index); if (end >= 0 && visible(markup.slice(m.index! + m[0].length, end)).length > 280) add('copy-budget', 'Card paragraphs must stay within 280 visible characters', m.index); }
      if (!/^(?:input|img|br|hr|meta|link|source|wbr|area|base|embed|param|track|col)$/.test(tag) && !m[0].endsWith('/>')) stack.push({ tag, mobile, card });
    }
  }
  return issues;
}
