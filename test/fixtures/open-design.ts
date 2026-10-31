import { designFiles, states, png } from './scrum-design.ts';
import { sha256 } from '../../src/scrum/artifacts.ts';
export function openDesignFiles(): Record<string, string> {
  const html = designFiles['mockups/index.html'];
  const app = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const screens = [{ id: 'catalog', surface: 'mobile' }, { id: 'checkout', surface: 'desktop' }];
  const viewports = [...screens.map(s => ({ screen: s.id, width: s.surface === 'mobile' ? 390 : 1280, height: s.surface === 'mobile' ? 844 : 800 })), { screen: 'screens-board', width: 1280, height: 800 }].map(v => ({ ...v, scrollWidth: v.width, clientWidth: v.width, screenshot: { path: `mockups/${v.screen === 'screens-board' ? 'screens-board' : v.screen}.png`, sha256: sha256(png) } }));
  return {
    'DESIGN.md': designFiles['DESIGN.md'],
    'EXPERIENCE.md': screens.map(s => `## Screen: ${s.id}\nSurface: ${s.surface}\nJourney: checkout\nState behaviors: contextual feedback.\n`).join('\n'),
    'mockups/index.html': html.replace(/<script>[\s\S]*?<\/script>/, '<script src="app.js"></script>').replace('<button id="buy">', '<nav>Shop</nav><button id="buy">').replace('</head>', '<link rel="stylesheet" href="styles.css"></head>'),
    'mockups/app.js': app,
    'mockups/styles.css': ':root { --ink: #183153; --paper: #ffffff } body { color: var(--ink); background: var(--paper) }',
    'mockups/screens.html': '<html><head><title>Shop journeys</title><link rel="stylesheet" href="screens.css"></head><body><section>Checkout <iframe src="index.html?screen=catalog"></iframe><svg class="frame-connection"></svg></section><section>System &amp; Edge States</section><script src="screens-data.js"></script></body></html>',
    'mockups/screens.css': 'body { margin: 0 }',
    'mockups/screens-data.js': 'const journeys = ["checkout", "system"];',
    'mockups/.od-frames/layout.css': '@layer od-layout { .od-stack { display: flex; flex-direction: column } }',
    'mockups/design-manifest.json': JSON.stringify({ directionId: 'editorial-monocle', tokens: { '--ink': '#183153', '--paper': '#ffffff' }, journeyGroups: [{ id: 'checkout', title: 'Checkout', screens: ['catalog', 'checkout'] }, { id: 'system', title: 'System & Edge States', screens: ['edge'] }], screens: [...screens, { id: 'edge', surface: 'mobile' }], componentPatterns: ['radio cards'] }),
    'mockups/browser.json': JSON.stringify({ network: 'disabled', consoleErrors: [], pageErrors: [], screens, viewports, states: [...screens.map(s => ({ screen: s.id, state: 'populated', keyboard: true, passed: true })), ...states.filter(s => s !== 'populated').map(state => ({ screen: 'edge', state, keyboard: true, passed: true }))], detector: { tool: 'open-design', passed: true, nonAdvisoryCount: 0, direction: 'editorial-monocle', viewportsChecked: viewports.map(v => ({ screen: v.screen, width: v.width, height: v.height, nonAdvisoryCount: 0 })) } }),
  };
}

/** Materializeable project-relative bundle for controller/CLI integration fixtures. */
export function openDesignBundle(prefix: string, files = openDesignFiles()): Record<string, string | Buffer> {
  const bundle: Record<string, string | Buffer> = { ...files };
  const report = JSON.parse(files['mockups/browser.json']);
  for (const viewport of report.viewports) {
    const path = viewport.screenshot.path;
    bundle[path] = png;
    viewport.screenshot.path = prefix + path;
  }
  bundle['mockups/browser.json'] = JSON.stringify(report);
  return bundle;
}
