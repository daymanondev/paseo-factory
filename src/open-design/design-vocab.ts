/** Open Design's design vocabulary: states, screens and token extraction. */
export const DESIGN_STATES = ['empty', 'loading', 'populated', 'error', 'offline', 'permission-denied'] as const;
export type DesignState = typeof DESIGN_STATES[number];
export type ScreenSurface = 'mobile' | 'desktop' | 'responsive';
export interface DesignScreen { surface: ScreenSurface; id: string; title?: string; body: string; line: number }
export const screenIdValid = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id);
export function designScreens(experience: string, manifest?: string): DesignScreen[] {
  const text = experience.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, '');
  const headings = [...text.matchAll(/^#{2,3}\s+Screen:\s*(\S+)(?:[ \t]+[—–-][ \t]+([^\n]+))?[^\n]*$/gm)];
  if (headings.length) return headings.map((m, i) => {
    const body = text.slice(m.index! + m[0].length, headings[i + 1]?.index ?? text.length);
    const surface = body.match(/(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}Surface\*{0,2}\s*:\s*\*{0,2}\s*(mobile|desktop|responsive)\b/i)?.[1].toLowerCase() as ScreenSurface | undefined;
    return { id: m[1], title: m[2], surface: surface ?? 'responsive', line: text.slice(0, m.index).split('\n').length, body };
  });
  if (manifest) {
    try { const data = JSON.parse(manifest); return (Array.isArray(data.screens) ? data.screens : []).map((s: { id: string; title?: string; surface?: ScreenSurface }) => ({ id: s.id, title: s.title, surface: s.surface ?? 'responsive', body: text, line: 1 })); } catch { /* Linter diagnoses absent declarations. */ }
  }
  return [];
}
export interface DesignTokens { colors: string[]; colorNames?: Record<string, string>; typography: string[]; spacing: string[]; radius: string[]; components: string[] }
/** Parse token declarations, never arbitrary prose containing category words. */
export function designTokens(text: string): DesignTokens {
  const tokens: DesignTokens = { colors: [], colorNames: {}, typography: [], spacing: [], radius: [], components: [] };
  type Category = 'colors' | 'typography' | 'spacing' | 'radius' | 'components';
  const category = (name: string): Category | undefined => ({ color: 'colors', colors: 'colors', typography: 'typography', spacing: 'spacing', radius: 'radius', radii: 'radius', rounded: 'radius', component: 'components', components: 'components' } as Record<string, Category>)[name.toLowerCase()];
  const clean = (s: string) => s.trim().replace(/^['"`]|['"`,]$/g, '');
  const add = (kind: Category, value: string) => {
    value = clean(value);
    if (!value || value.length > 160 || /^(?:none|TODO|TBD|placeholder)\b/i.test(value)) return;
    if (kind === 'colors') {
      for (const m of value.matchAll(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{3}\b/gi)) {
        if (!tokens.colors.includes(m[0])) tokens.colors.push(m[0]);
        const name = value.slice(0, m.index).match(/([\w-]+)\s*:?\s*['"]?$/)?.[1];
        if (name) tokens.colorNames![m[0]] = name;
      }
    } else if ((kind !== 'spacing' && kind !== 'radius') || /\b\d+(?:\.\d+)?(?:px|rem)\b/.test(value)) {
      if (!/letterSpacing/i.test(value) && !tokens[kind].includes(value)) tokens[kind].push(value);
    }
  };
  const front = text.match(/^---\s*\n([^]*?)\n---(?:\s*\n|$)/);
  if (front) {
    let kind: Category | undefined, role = '', fields: string[] = [], childIndent = 0;
    const flush = () => { if (kind && role && fields.length) add(kind, role + ': ' + fields.join(', ')); fields = []; role = ''; };
    for (const line of front[1].split('\n')) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const entry = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
      if (!entry) continue;
      const [, indent, key, raw] = entry;
      if (!indent) { flush(); childIndent = 0; kind = category(key); if (kind && raw) add(kind, raw); }
      else if (kind) {
        if (!childIndent || indent.length <= childIndent) { childIndent = indent.length; flush(); if (raw) add(kind, key + ': ' + clean(raw)); else role = key; }
        else if (role) fields.push(key + ': ' + clean(raw));
      }
    }
    flush();
    text = text.slice(front[0].length);
  }
  let section: Category | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      const next = category(heading[1].replace(/\s+tokens?$/i, ''));
      if (next) section = next;
      else if (section === 'components' && /^###\s/.test(line)) add('components', heading[1]);
      else section = undefined;
      continue;
    }
    const definition = line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '');
    const explicit = definition.match(/^([a-z]+)\s*[:|—-]\s*(.+)$/i);
    const kind = explicit && category(explicit[1]);
    if (kind) add(kind, explicit![2]);
    else if (section && /^(?:[-*]\s+|\|)/.test(line) && /[:|]/.test(definition)) add(section, definition);
  }
  return tokens;
}
