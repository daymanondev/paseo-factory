import { test } from "node:test";
import assert from "node:assert/strict";
import { lintScrumDoc } from "../src/scrum/linter.ts";

test("document lint accepts stable ID gaps and ignores references/fenced placeholders", () => {
  const files = {
    "prd.md":
      "# Outcome\nCustomers pay.\n# Out of Scope\nRefunds.\n## FR-1: pay\n## FR-3: receipt\n## NFR-2: latency\n## UJ-1: checkout\nReference FR-1 and FR-3.\n```txt\nTODO example\n```\n",
  };
  assert.deepEqual(lintScrumDoc("prd", files), []);
  assert.match(
    lintScrumDoc("prd", {
      "prd.md": files["prd.md"] + "## FR-1: duplicate\nTODO decide tax\n",
    })
      .map((d) => d.category)
      .join(),
    /duplicate.*placeholder/,
  );
});

test("architecture lint requires invariant fields without forcing gap-free IDs", () => {
  const good =
    "# Stack\npackage.json and package-lock.json provide runtime evidence.\n## AD-1: ownership\nBinds: API\nPrevents: cross-tenant access\nRule: check ownership\n## AD-4: deprecated\nBinds: storage\nPrevents: stale reads\nRule: retired; use AD-1\n";
  assert.deepEqual(
    lintScrumDoc("architecture", { "architecture.md": good }),
    [],
  );
  assert.match(
    lintScrumDoc("architecture", {
      "architecture.md": good.replace("Rule: check ownership", "no rule"),
    })
      .map((d) => d.message)
      .join(),
    /AD-1.*Rule/,
  );
});

test("backlog separates Covers references from definitions and rejects dangling mandatory coverage", () => {
  const files = {
    "prd.md": "## FR-1: checkout",
    "sprint-backlog.md":
      "## R1: checkout\nSource: FR-1\n## S-01: tracer bullet\nCovers: R1\nTests: checkout.test.ts\n",
  };
  assert.deepEqual(lintScrumDoc("backlog", files), []);
  assert.match(
    lintScrumDoc("backlog", {
      ...files,
      "sprint-backlog.md": files["sprint-backlog.md"].replace(
        "Covers: R1",
        "Covers: R2",
      ),
    })
      .map((d) => d.message)
      .join(),
    /R2/,
  );
});

test("installed lint-scrum-doc CLI has distinct valid, findings, and invocation exits", async (t) => {
  const { makeTempDir, disposeDir, repoRoot } = await import("./helpers.ts");
  const { join } = await import("node:path");
  const { writeFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const dir = makeTempDir();
  disposeDir(t, dir);
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(repoRoot, "plugin/bin/factory.mjs"), "lint-scrum-doc", ...args],
      { encoding: "utf8" },
    );
  writeFileSync(
    join(dir, "prd.md"),
    "# Outcome\nPay\n# Out of Scope\nRefund\n## FR-1: pay\n## NFR-3: latency\n## UJ-2: checkout\n",
  );
  assert.equal(cli("--kind", "prd", "--dir", dir).status, 0);
  writeFileSync(join(dir, "prd.md"), "TODO\n");
  const findings = cli("--kind", "prd", "--dir", dir);
  assert.equal(findings.status, 1);
  assert.ok(
    JSON.parse(findings.stdout).diagnostics.some(
      (d: { category: string }) => d.category === "placeholder",
    ),
  );
  assert.equal(cli("--kind", "unknown", "--dir", dir).status, 2);
  assert.equal(cli("--kind", "prd", "--dir", join(dir, "absent")).status, 2);
});

test("FR-10 cannot satisfy mandatory FR-1 coverage", () => {
  const diagnostics = lintScrumDoc("backlog", {
    "prd.md": "# FR-1: authentication required\n# FR-10: heading\n",
    "sprint-backlog.md":
      "# R1: heading\nSource: FR-10\n# S-01: heading story\nCovers: R1\nTests: heading.test.js\n",
  });
  assert.ok(diagnostics.some((d) => d.message === "FR-1 has no R mapping"));
});

test("only explicit sources inside R definitions map PRD coverage", () => {
  const files = {
    "prd.md": "# FR-1: auth\n# FR-10: heading\n",
    "sprint-backlog.md":
      "FR-1 is still undecided.\n# R1: heading\nSource: FR-10\n# S-01: heading story\nCovers: R1\nTests: heading.test.js\nSource: FR-1\n",
  };
  assert.ok(
    lintScrumDoc("backlog", files).some(
      (d) => d.message === "FR-1 has no R mapping",
    ),
  );
  files["sprint-backlog.md"] =
    "# R1: auth\nSource: FR-1\nDeferred: Owner explicitly postponed authentication to next wave.\n# R2: heading\nSources: FR-10\n# S-01: heading story\nCovers: R2\nTests: heading.test.js\n";
  assert.deepEqual(lintScrumDoc("backlog", files), []);
});

test('UX lint requires declared screens, concrete tokens and routed six-state mockups', async () => {
  const { designFiles } = await import('./fixtures/scrum-design.ts');
  assert.deepEqual(lintScrumDoc('ux', designFiles), []);
  for (const [path, content, category] of [
    ['DESIGN.md', 'color typography spacing component', 'design-token'],
    ['EXPERIENCE.md', designFiles['EXPERIENCE.md'].replace('## Screen: checkout', '## Screen: Bad_ID'), 'screen'],
    ['EXPERIENCE.md', designFiles['EXPERIENCE.md'].replace('offline: keyboard accessible offline', 'unavailable'), 'state-cell'],
    ['mockups/index.html', '<html><head><title>Shop</title></head><body><button>Buy</button></body></html>', 'routing'],
  ]) {
    assert.ok(lintScrumDoc('ux', { ...designFiles, [path]: content }).some(d => d.category === category), `${path}: ${category}`);
  }
});

test('Dev UI evidence gate rejects missing detector, states and viewports', async () => {
  const { designFiles, states } = await import('./fixtures/scrum-design.ts');
  const report = { network: 'disabled', consoleErrors: [], viewports: ['catalog', 'checkout'].flatMap(screen => [{ screen, width: 1280, height: 800 }, { screen, width: 390, height: 844 }]), states: ['catalog', 'checkout'].flatMap(screen => states.map(state => ({ screen, state, keyboard: true, passed: true }))), detector: { tool: 'impeccable', passed: true, nonAdvisoryCount: 0, viewportsChecked: [{ width: 1280, height: 800, nonAdvisoryCount: 0 }, { width: 390, height: 844, nonAdvisoryCount: 0 }] } };
  const lint = (value: unknown) => lintScrumDoc('ui', { 'EXPERIENCE.md': designFiles['EXPERIENCE.md'], 'browser.json': JSON.stringify(value) });
  assert.deepEqual(lint(report), []);
  assert.ok(lint({ ...report, detector: undefined }).some(d => /detector/.test(d.message)));
  assert.ok(lint({ ...report, states: report.states.slice(1) }).some(d => /empty/.test(d.message)));
  assert.ok(lint({ ...report, viewports: report.viewports.filter(v => v.width === 1280) }).some(d => /Mobile/.test(d.message)));
});

test('UI evidence follows each declared screen surface', async () => {
  const { designFiles, states } = await import('./fixtures/scrum-design.ts');
  const experience = designFiles['EXPERIENCE.md'].replace('## Screen: catalog', '## Screen: catalog\n- **Surface:** mobile').replace('## Screen: checkout', '## Screen: checkout\nSurface: desktop');
  const report = { network: 'disabled', consoleErrors: [], viewports: [{ screen: 'catalog', width: 390, height: 844 }, { screen: 'checkout', width: 1280, height: 800 }], states: ['catalog', 'checkout'].flatMap(screen => states.map(state => ({ screen, state, keyboard: true, passed: true }))), detector: { tool: 'impeccable', passed: true, nonAdvisoryCount: 0, viewportsChecked: [{ width: 390, height: 844, nonAdvisoryCount: 0 }, { width: 1280, height: 800, nonAdvisoryCount: 0 }] } };
  const lint = () => lintScrumDoc('ui', { 'EXPERIENCE.md': experience, 'browser.json': JSON.stringify(report) });
  assert.deepEqual(lint(), []);
  report.viewports.pop();
  assert.ok(lint().some(d => /checkout.*Desktop/.test(d.message)));
});

test('UX lint protects product chrome, copy, mobile anatomy and contextual states', async () => {
  const { designFiles } = await import('./fixtures/scrum-design.ts');
  const files = { ...designFiles, 'EXPERIENCE.md': designFiles['EXPERIENCE.md'].replace('## Screen: catalog', '## Screen: catalog\nSurface: mobile'), 'mockups/index.html': designFiles['mockups/index.html'].replace('<button id="buy">', '<nav aria-label="Tabs">Home</nav><button id="buy">') };
  assert.deepEqual(lintScrumDoc('ux', files), []);
  for (const [markup, category] of [
    ['<select id="state-select"><option>empty</option><option>loading</option></select>', 'debug-chrome'],
    ['<p>ADR-0003 PUT /api/rubric @goal-planner/shared candidateOptedIn = true evaluateIntakeAssessment() (tasksPerWeek)</p>', 'ui-copy'],
    ['<table><tr><td>One</td><td>Two</td></tr></table>', 'mobile-shell'],

  ]) {
    const html = files['mockups/index.html'].replace('<button id="buy">', markup + '\n<button id="buy">');
    const issues = lintScrumDoc('ux', { ...files, 'mockups/index.html': html });
    assert.ok(issues.some(d => d.category === category && d.path === 'mockups/index.html' && d.line > 0), category);
  }
  const fullReplacement = files['mockups/index.html'].replace('<nav aria-label="Tabs">Home</nav>', '<div data-populated-for="catalog"><nav>Home</nav></div><div id="state-panel-catalog"></div><script>populatedWrap.hidden = true</script>');
  assert.ok(lintScrumDoc('ux', { ...files, 'mockups/index.html': fullReplacement }).some(d => d.category === 'state-shell'));
  assert.ok(lintScrumDoc('ux', { ...files, 'mockups/index.html': fullReplacement.replace('<button class="pay-cta">', '<nav>Checkout</nav><button class="pay-cta">') }).some(d => d.category === 'state-shell'));
  const contextual = files['mockups/index.html'].replace('<button id="buy">', '<div data-populated-for="catalog">Products</div><div id="state-panel-catalog">Loading products</div><button id="buy">');
  assert.deepEqual(lintScrumDoc('ux', { ...files, 'mockups/index.html': contextual }), []);
  const sharedNav = files['mockups/index.html'].replace('<nav aria-label="Tabs">Home</nav>', '').replace('<body>', '<body><nav>Home</nav>');
  assert.deepEqual(lintScrumDoc('ux', { ...files, 'mockups/index.html': sharedNav }), []);
  const technical = files['mockups/index.html'].replace('Buy</button>', 'ADR-0003 PUT /api/rubric</button>');
  assert.ok(!lintScrumDoc('ux', { ...files, 'DESIGN.md': files['DESIGN.md'] + '\nui-copy-allow: technical-identifiers', 'mockups/index.html': technical }).some(d => d.category === 'ui-copy'));
  assert.ok(!lintScrumDoc('ux', { ...files, 'mockups/index.html': files['mockups/index.html'].replace('</body>', '<!-- ADR-0003 --><script>const internal="FR-14";</script></body>') }).some(d => d.category === 'ui-copy'));
});

test('UX and evidence lint return diagnostics for malformed submitted values', async () => {
  const { designFiles, states } = await import('./fixtures/scrum-design.ts');
  assert.doesNotThrow(() => lintScrumDoc('ux', { ...designFiles, 'mockups/index.html': designFiles['mockups/index.html'].replace('Buy</button>', 'Buy &#99999999999;</button>') }));
  const report = { network: 'disabled', consoleErrors: [], viewports: [{ screen: 'catalog', width: 390, height: 844 }], states: states.map(state => ({ screen: 'catalog', state, keyboard: true, passed: true })), detector: { tool: 'impeccable', passed: true, nonAdvisoryCount: 0, viewportsChecked: {} } };
  const diagnostics = lintScrumDoc('ui', { 'EXPERIENCE.md': '## Screen: catalog\nSurface: mobile', 'browser.json': JSON.stringify(report) });
  assert.ok(diagnostics.some(d => d.category === 'browser-evidence' && /detector/.test(d.message)));
  assert.ok(!diagnostics.some(d => d.category === 'json'));
});

test('Open Design UX gate accepts dual surfaces and shared edge states with external offline assets', async () => {
  const { openDesignFiles } = await import('./fixtures/open-design.ts');
  const files = openDesignFiles();
  assert.deepEqual(lintScrumDoc('ux', files), []);
  assert.deepEqual(lintScrumDoc('ui', { ...files, 'browser.json': files['mockups/browser.json'] }), []);
});

test('Open Design gates reject craft defects, invalid code and unresolved offline assets', async () => {
  const { openDesignFiles } = await import('./fixtures/open-design.ts');
  const files = openDesignFiles();
  for (const [path, text, category] of [
    ['mockups/styles.css', '.hero { background: linear-gradient(90deg, #a855f7, white) }', 'purple-gradient'],
    ['mockups/styles.css', '.cta { color: #6366f1 }', 'ai-default-indigo'],
    ['mockups/styles.css', '.card { border-left: 4px solid red; border-radius: 8px }', 'left-accent-card'],
    ['mockups/styles.css', 'body { color: red;', 'css-syntax'],
    ['mockups/app.js', 'const broken = ;', 'js-syntax'],
    ['mockups/screens.css', 'body { background: url(missing.png) }', 'offline-asset'],
    ['mockups/index.html', '<button>🚀 Launch</button>', 'emoji-icon'],
    ['mockups/index.html', '<main data-screen="catalog"><select><option>Choose</option></select></main>', 'mobile-native-select'],
    ['mockups/index.html', '<article class="card"><p>' + 'Helpful product copy. '.repeat(20) + '</p></article>', 'copy-budget'],
  ]) {
    const diagnostics = lintScrumDoc('ux', { ...files, [path]: files[path] + text });
    assert.ok(diagnostics.some(d => d.category === category), `${category}: ${JSON.stringify(diagnostics)}`);
  }
  const report = JSON.parse(files['mockups/browser.json']);
  report.viewports[0].scrollWidth = 450;
  assert.ok(lintScrumDoc('ux', { ...files, 'mockups/browser.json': JSON.stringify(report) }).some(d => /overflow/.test(d.message)));
  report.viewports = report.viewports.filter((v: {screen: string}) => v.screen !== 'screens-board');
  assert.ok(lintScrumDoc('ux', { ...files, 'mockups/browser.json': JSON.stringify(report) }).some(d => /screens-board/.test(d.message)));
});

test('installed Open Design CLI stages hardware shells and validates offline dual-surface evidence', async t => {
  const { makeTempDir, disposeDir, repoRoot } = await import('./helpers.ts');
  const { join } = await import('node:path');
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { openDesignFiles } = await import('./fixtures/open-design.ts');
  const { png } = await import('./fixtures/scrum-design.ts');
  const root = makeTempDir(); disposeDir(t, root);
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(repoRoot, 'plugin/bin/factory.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  const files = openDesignFiles();
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  for (const v of JSON.parse(files['mockups/browser.json']).viewports) writeFileSync(join(root, v.screenshot.path), png);
  const stage = cli('open-design', 'stage', '--dir', join(root, 'mockups'));
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(readFileSync(join(root, 'mockups/.od-frames/iphone.html'), 'utf8'), /phone-content/);
  const lint = cli('lint-scrum-doc', '--kind', 'ux', '--dir', root);
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  writeFileSync(join(root, 'mockups/catalog.png'), 'corrupt');
  const invalid = cli('lint-scrum-doc', '--kind', 'ux', '--dir', root);
  assert.equal(invalid.status, 1, invalid.stdout);
  assert.match(invalid.stdout, /screenshot/);
});

test('Open Design CLI discovers optional host catalogs and syncs a scratch folder through orchestratorWorkspace', async t => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { makeTempDir, disposeDir, repoRoot } = await import('./helpers.ts');
  const { join } = await import('node:path');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const root = makeTempDir(); disposeDir(t, root);
  const resources = join(root, 'open-design'), system = join(resources, 'design-systems/test-brand');
  mkdirSync(system, {recursive:true});writeFileSync(join(system, 'tokens.css'), ':root{}');writeFileSync(join(system, 'DESIGN.md'), '# Test brand');
  for (let i=0;i<150;i++) { const dir=join(resources,'design-systems','brand-'+String(i).padStart(3,'0'));mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'tokens.css'),':root{}');writeFileSync(join(dir,'DESIGN.md'),'# Brand'); }
  let body: unknown;
  const server = createServer(async (req,res) => {const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.url,'/api/import/folder');res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const address = server.address();assert.ok(address&&typeof address!=='string');
  const cli = (action:string) => new Promise<{code:number|null;output:string}>((resolve,reject)=>{const p=spawn(process.execPath,[join(repoRoot,'plugin/bin/factory.mjs'),'open-design',action,'--dir',root],{env:{...process.env,OPEN_DESIGN_RESOURCE_ROOT:resources,OPEN_DESIGN_DAEMON_URL:`http://127.0.0.1:${address.port}`}});let output='';p.stdout.on('data',c=>output+=c);p.stderr.on('data',c=>output+=c);p.on('error',reject);p.on('exit',code=>resolve({code,output}));});
  const inspect=await cli('inspect');assert.equal(inspect.code,0,inspect.output);assert.equal(JSON.parse(inspect.output).designSystems.length,151);assert.ok(JSON.parse(inspect.output).designSystems.some((s:{id:string})=>s.id==='test-brand'));
  const sync=await cli('sync');assert.equal(sync.code,0,sync.output);
  assert.deepEqual(body,{baseDir:root,orchestratorWorkspace:{kind:'scratch',writeback:'external',sourceLabel:'Paseo Factory',sourceRef:root}});
});

test('Open Design gates inspect runtime templates and accept externally rendered screens and controls', async () => {
  const { openDesignFiles } = await import('./fixtures/open-design.ts');
  const files = openDesignFiles();
  files['mockups/index.html'] = '<html><head><title>Shop</title><link rel="stylesheet" href="styles.css"></head><body><script src="app.js"></script></body></html>';
  files['mockups/app.js'] += '\ndocument.body.innerHTML = `<main data-screen="catalog"><nav>Shop</nav><button>Buy</button></main><main data-screen="checkout"><button>Pay</button></main>`;';
  assert.deepEqual(lintScrumDoc('ux', files, {requireOpenDesignOnly:true}), []);
  const desktop = { ...files, 'mockups/app.js': files['mockups/app.js'] + `\ndocument.querySelector('[data-screen="checkout"]').insertAdjacentHTML('beforeend', '<select><option>Sort</option></select>');` };
  assert.ok(!lintScrumDoc('ux', desktop, {requireOpenDesignOnly:true}).some(d=>d.category==='mobile-native-select'));
  files['mockups/app.js'] += `\ndocument.querySelector('[data-screen="catalog"]').insertAdjacentHTML('beforeend', '<select><option>Choose</option></select><article class="card"><p>FR-100 ` + 'Long product explanation. '.repeat(24) + `</p></article>');`;
  const issues = lintScrumDoc('ux', files, {requireOpenDesignOnly:true});
  for (const category of ['mobile-native-select','ui-copy','copy-budget']) assert.ok(issues.some(d=>d.category===category), category);
});
