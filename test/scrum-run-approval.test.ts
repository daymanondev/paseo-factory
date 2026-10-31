import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, disposeDir } from "./helpers.ts";
import { ensureScrumConfig } from "../src/scrum/config.ts";
import {
  createScrumRun,
  commandRun,
  readRun,
} from "../src/scrum/run-journal.ts";

test("durable requests preserve frozen roster and consumed fix rounds across replay", (t) => {
  const state = makeTempDir();
  disposeDir(t, state);
  const run = createScrumRun({
    state,
    slug: "p",
    runId: "r1",
    initiativeId: "feature",
    config: ensureScrumConfig(state),
    configRevision: 1,
    track: "small",
    rationale: "bounded existing behavior",
    requestId: "create",
  });
  const first = commandRun(state, "p", "r1", {
    requestId: "round1",
    expectedRevision: run.revision,
    type: "fix_reserved",
    task: "fix-1",
  });
  const duplicate = commandRun(state, "p", "r1", {
    requestId: "round1",
    expectedRevision: run.revision,
    type: "fix_reserved",
    task: "fix-1",
  });
  assert.equal(duplicate.fixRounds, 1);
  assert.equal(first.revision, duplicate.revision);
  commandRun(state, "p", "r1", {
    requestId: "round2",
    expectedRevision: first.revision,
    type: "fix_reserved",
    task: "fix-2",
  });
  const replayed = readRun(state, "p", "r1");
  assert.equal(replayed.fixRounds, 2);
  assert.throws(
    () =>
      commandRun(state, "p", "r1", {
        requestId: "round3",
        expectedRevision: replayed.revision,
        type: "fix_reserved",
        task: "fix-3",
      }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "qa-fix-budget-exhausted" && error.message.includes("2/2"),
  );
  assert.throws(
    () =>
      commandRun(state, "p", "r1", {
        requestId: "stale",
        expectedRevision: 1,
        type: "phase_changed",
        phase: "qa",
        reason: "audit",
      }),
    /run-revision-conflict/,
  );
});

test("UI decisions pin exact revisions, reject self-approval, survive restart, and require semantic readiness", async (t) => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { gitCommitAll, gitCommitChanges } = await import("./helpers.ts");
  const { artifactAt, designDigest } = await import(
    "../src/scrum/artifacts.ts"
  );
  const { assertDevReady, decideDesign } = await import(
    "../src/scrum/approval.ts"
  );
  const { renderPreview } = await import("../src/scrum/preview.ts");
  const repo = makeTempDir();
  disposeDir(t, repo);
  const state = makeTempDir();
  disposeDir(t, state);
  const prefix = ".scratch/ui";
  const ownedPaths = [
    `${prefix}/DESIGN.md`,
    `${prefix}/EXPERIENCE.md`,
    `${prefix}/mockups/index.html`,
    `${prefix}/mockups/browser.json`,
    `${prefix}/mockups/screen.png`,
  ];
  mkdirSync(join(repo, prefix, "mockups"), { recursive: true });
  writeFileSync(
    join(repo, ownedPaths[0]),
    "color blue; typography system; spacing 8; component button\n",
  );
  writeFileSync(join(repo, ownedPaths[1]), "all six states\n");
  writeFileSync(
    join(repo, ownedPaths[2]),
    "<html><head><title>Checkout</title></head><body><button>Pay</button></body></html>",
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(join(repo, ownedPaths[4]), png);
  const { sha256 } = await import("../src/scrum/artifacts.ts");
  writeFileSync(
    join(repo, ownedPaths[3]),
    JSON.stringify({
      network: "disabled",
      consoleErrors: [],
      viewports: [
        {
          width: 800,
          height: 600,
          screenshot: { path: ownedPaths[4], sha256: sha256(png) },
        },
      ],
      states: [
        "empty",
        "loading",
        "populated",
        "error",
        "offline",
        "permission-denied",
      ].map((state) => ({
        screen: "checkout",
        state,
        keyboard: true,
        passed: true,
      })),
    }),
  );
  const sha = gitCommitAll(repo);
  let run = createScrumRun({
    state,
    slug: "p",
    runId: "ui-run",
    initiativeId: "ui",
    config: ensureScrumConfig(state),
    configRevision: 1,
    track: "ui",
    rationale: "changed checkout flow",
    requestId: "create",
    ownedPaths,
  });
  const refs = ownedPaths
    .filter((path) => path !== ownedPaths[3])
    .map((path) => artifactAt(repo, sha, path));
  run = commandRun(state, "p", run.runId, {
    requestId: "design1",
    expectedRevision: run.revision,
    type: "design_review_requested",
    design: {
      revision: 1,
      digest: designDigest(refs),
      refs,
      browserEvidence: [artifactAt(repo, sha, ownedPaths[3])],
    },
  });
  const decision = {
    state,
    slug: "p",
    runId: run.runId,
    root: repo,
    actor: "owner",
    explicitOwnerInstruction: true,
    requestId: "approval1",
    expectedRevision: run.revision,
    revision: 1,
    digest: designDigest(refs),
    decision: "approved" as const,
    rationale: "checked checkout preview",
  };
  assert.throws(
    () => decideDesign({ ...decision, authority: "lead" }),
    /Owner/,
  );
  run = decideDesign({ ...decision, authority: "owner" });
  assert.throws(
    () => assertDevReady(repo, readRun(state, "p", run.runId)),
    /resolve contradictions/,
  );
  run = commandRun(state, "p", run.runId, {
    requestId: "contradiction",
    expectedRevision: run.revision,
    type: "readiness_recorded",
    readiness: {
      refs,
      contradictions: ["UX permits offline writes; API forbids them"],
      unsafeAssumptions: [],
      missingCoverage: [],
      rationale: "reconcile UX and Architect in a new Task",
    },
  });
  assert.throws(() => assertDevReady(repo, run), /blocked/);
  run = commandRun(state, "p", run.runId, {
    requestId: "ready",
    expectedRevision: run.revision,
    type: "readiness_recorded",
    readiness: {
      refs,
      contradictions: [],
      unsafeAssumptions: [],
      missingCoverage: [],
      rationale: "read-only offline UX reconciled",
    },
  });
  assert.doesNotThrow(() => assertDevReady(repo, run));
  assert.match(renderPreview(repo, run).html, /connect-src 'none'/);
  run = decideDesign({
    ...decision,
    authority: "supervisor",
    requestId: "changes",
    expectedRevision: run.revision,
    decision: "changes_requested",
    rationale: "Owner asks for clearer payment copy",
  });
  assert.throws(() => assertDevReady(repo, run));
  writeFileSync(
    join(repo, ownedPaths[2]),
    "<html><head><title>Checkout r2</title></head><body><button>Pay invoice</button></body></html>",
  );
  const second = gitCommitChanges(repo, "new UX revision Task");
  const refs2 = ownedPaths
    .filter((path) => path !== ownedPaths[3])
    .map((path) => artifactAt(repo, second, path));
  run = commandRun(state, "p", run.runId, {
    requestId: "design2",
    expectedRevision: run.revision,
    type: "design_review_requested",
    design: {
      revision: 2,
      digest: designDigest(refs2),
      refs: refs2,
      browserEvidence: [artifactAt(repo, second, ownedPaths[3])],
    },
  });
  assert.throws(
    () =>
      decideDesign({
        ...decision,
        authority: "owner",
        requestId: "stale-approve",
        expectedRevision: run.revision,
      }),
    /superseded/,
  );
  assert.equal(readRun(state, "p", run.runId).design?.revision, 2);
  assert.equal(readRun(state, "p", run.runId).design?.decision, undefined);
});

test("duplicate run admission keeps the original frozen config after future roster edits", async (t) => {
  const { createFactory } = await import("../src/factory.ts");
  const { saveScrumConfig } = await import("../src/scrum/config.ts");
  const { scrumOperation } = await import("../src/scrum/controller.ts");
  const { gitCommitAll } = await import("./helpers.ts");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const state = makeTempDir();
  disposeDir(t, state);
  const root = makeTempDir();
  disposeDir(t, root);
  writeFileSync(join(root, "README.md"), "fixture");
  gitCommitAll(root);
  const { switchExecution } = await import("../src/scrum/execution.ts");
  const factory = createFactory({ stateDir: state });
  await switchExecution({
    state,
    slug: "p",
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  const ctx = {
    factory,
    root,
    slug: "p",
    authority: "owner" as const,
    actor: "owner",
    activeAgents: [],
    pendingDirectives: false,
  };
  const request = {
    operation: "run.create",
    runId: "one",
    requestId: "admit",
    payload: {
      initiativeId: "unused",
      track: "small",
      rationale: "small work",
      ownedPaths: [],
    },
  };
  const first = scrumOperation(request, ctx) as ReturnType<typeof readRun>;
  const config = ensureScrumConfig(state, "p");
  saveScrumConfig(
    state,
    {
      ...config,
      requireUiApproval: false,
      lanes: { ...config.lanes, dev: "pi/future" },
    },
    "p",
  );
  const duplicate = scrumOperation(request, ctx) as ReturnType<typeof readRun>;
  assert.equal(
    duplicate.config.requireUiApproval,
    first.config.requireUiApproval,
  );
  assert.equal(duplicate.config.lanes.dev, first.config.lanes.dev);
  assert.equal(duplicate.revision, first.revision);
});

test("controller requires complete design digests and journals a frozen-policy waiver without unlocking unsafe readiness", async (t) => {
  const { createFactory } = await import("../src/factory.ts");
  const { scrumOperation } = await import("../src/scrum/controller.ts");
  const { artifactAt, designDigest, sha256 } = await import(
    "../src/scrum/artifacts.ts"
  );
  const { assertDevReady } = await import("../src/scrum/approval.ts");
  const { gitCommitAll } = await import("./helpers.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const state = makeTempDir();
  disposeDir(t, state);
  const root = makeTempDir();
  disposeDir(t, root);
  const prefix = ".scratch/ui-policy";
  const paths = [
    "DESIGN.md",
    "EXPERIENCE.md",
    "mockups/index.html",
    "mockups/screen.png",
    "mockups/browser.json",
  ].map((p) => `${prefix}/${p}`);
  mkdirSync(join(root, prefix, "mockups"), { recursive: true });
  for (const path of paths.slice(0, 4))
    writeFileSync(
      join(root, path),
      path.endsWith(".html")
        ? "<html><head><title>UI</title></head><body><button>Calculate</button></body></html>"
        : path.endsWith(".png") ? (await import("./fixtures/scrum-design.ts")).png : "fixture bytes",
    );
  writeFileSync(
    join(root, paths[4]),
    JSON.stringify({
      network: "disabled",
      consoleErrors: [],
      viewports: [
        {
          width: 800,
          height: 600,
          screenshot: { path: paths[3], sha256: sha256((await import("./fixtures/scrum-design.ts")).png) },
        },
      ],
      states: [
        "empty",
        "loading",
        "populated",
        "error",
        "offline",
        "permission-denied",
      ].map((state) => ({
        screen: "calculator",
        state,
        keyboard: true,
        passed: true,
      })),
    }),
  );
  const { switchExecution } = await import("../src/scrum/execution.ts");
  await switchExecution({
    state,
    slug: "p",
    mode: "scrum",
    blockers: [],
    rotate: async () => {},
  });
  const sha = gitCommitAll(root),
    config = { ...ensureScrumConfig(state), requireUiApproval: false };
  let run = createScrumRun({
    state,
    slug: "p",
    runId: "policy",
    initiativeId: "ui-policy",
    config,
    configRevision: 1,
    track: "ui",
    rationale: "fixture",
    requestId: "create",
    ownedPaths: paths,
  });
  const factory = createFactory({ stateDir: state });
  run = commandRun(state, "p", run.runId, {
    requestId: "reserve",
    expectedRevision: run.revision,
    type: "task_reserved",
    task: "ux-policy",
    role: "ux",
    required: true,
  });
  const contract = factory.setContract({
    task: "ux-policy",
    workspace: root,
    gate: "true",
    execution: {
      mode: "scrum",
      runId: run.runId,
      role: "ux",
      policyRevision: run.policyRevision,
      configRevision: run.configRevision,
      artifactRefs: [],
    },
  });
  run = commandRun(state, "p", run.runId, {
    requestId: "bind",
    expectedRevision: run.revision,
    type: "task_bound",
    task: contract.task,
    epoch: contract.seq,
  });
  const claim = await factory.claim({ task: contract.task, sha });
  await factory.accept({ task: contract.task, attempt: claim.attempt });
  const refs = paths.slice(0, 4).map((path) => artifactAt(root, sha, path)),
    browserEvidence = [artifactAt(root, sha, paths[4])];
  const ctx = {
    factory,
    slug: "p",
    root,
    authority: "lead" as const,
    actor: "lead",
    activeAgents: [],
    pendingDirectives: false,
  };
  const subset = [refs[2]];
  assert.throws(
    () =>
      scrumOperation(
        {
          operation: "run.command",
          runId: run.runId,
          requestId: "subset",
          expectedRevision: run.revision,
          payload: {
            type: "design_review_requested",
            design: {
              revision: 1,
              digest: designDigest(subset),
              refs: subset,
              browserEvidence,
            },
          },
        },
        ctx,
      ),
    /complete design|DESIGN/,
  );
  run = scrumOperation(
    {
      operation: "run.command",
      runId: run.runId,
      requestId: "full",
      expectedRevision: run.revision,
      payload: {
        type: "design_review_requested",
        design: {
          revision: 1,
          digest: designDigest(refs),
          refs,
          browserEvidence,
        },
      },
    },
    ctx,
  ) as typeof run;
  assert.equal(run.design?.decision, "waived");
  assert.match(run.design?.actor ?? "", /^policy:/);
  assert.throws(() => assertDevReady(root, run), /resolve contradictions/);
});

test('design gate rejects a declared screen without mobile evidence and accepts the complete matrix', async t => {
  const { designFixture } = await import('./fixtures/scrum-design.ts');
  const { gitCommitChanges } = await import('./helpers.ts');
  const { writeFileSync } = await import('node:fs');
  const { artifactAt } = await import('../src/scrum/artifacts.ts');
  const { verifyBrowserEvidence } = await import('../src/scrum/approval.ts');
  const f = await designFixture(t);
  for (const mutate of [
    (r: typeof f.report) => { r.viewports = r.viewports.filter(v => !(v.screen === 'checkout' && v.name === 'mobile')); },
    (r: typeof f.report) => { r.states = r.states.filter(s => !(s.screen === 'checkout' && s.state === 'offline')); },
    (r: typeof f.report) => { r.detector.nonAdvisoryCount = 1; },
    (r: typeof f.report) => { r.detector.viewportsChecked.pop(); },
  ]) {
    const report = structuredClone(f.report); mutate(report);
    writeFileSync(`${f.root}/.scratch/studio/mockups/browser.json`, JSON.stringify(report));
    const sha = gitCommitChanges(f.root, 'invalid evidence');
    const invalid = { ...f.design, browserEvidence: [artifactAt(f.root, sha, '.scratch/studio/mockups/browser.json')] };
    assert.throws(() => verifyBrowserEvidence(f.root, invalid), { code: 'browser-evidence-invalid' });
  }
  writeFileSync(`${f.root}/.scratch/studio/mockups/browser.json`, JSON.stringify(f.report));
  gitCommitChanges(f.root, 'restore accepted evidence');
  // The accepted, committed original is still the evidence for submission.
  const accepted = f.submit() as ReturnType<typeof readRun>;
  assert.equal(accepted.phase, 'awaiting-ui-approval');
});

test('loopback studio serves pinned artboards and records origin-protected structured Owner feedback', async t => {
  const { designFixture, png } = await import('./fixtures/scrum-design.ts');
  const { scrumOperation } = await import('../src/scrum/controller.ts');
  const f = await designFixture(t);
  f.submit();
  const preview = await scrumOperation({ operation: 'preview.url', runId: f.run.runId, requestId: 'preview' }, f.ctx) as { url: string; urls?: string[] };
  assert.ok(Array.isArray(preview.urls) && preview.urls.includes(preview.url));
  const url = new URL(preview.url), token = url.searchParams.get('token');
  assert.match(token ?? '', /^[a-f0-9]{64}$/);
  const route = (path: string) => new URL(path + (path.includes('?') ? '&' : '?') + `token=${token}`, url);
  assert.equal((await fetch(url.origin)).status, 403);
  const stateRes = await fetch(route('/api/state'));
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.headers.get('access-control-allow-origin'), '*');
  const html = await (await fetch(url)).text();
  for (const title of ['Artboard Canvas', 'Design System Kit', 'Interactive Inspect &amp; Pin Feedback', 'Auto (By Surface)', 'Review &amp; Decision', 'Interact', 'Inspect & Pin', '9:41', 'pointer-events:none']) assert.ok(html.includes(title));
  const mockup = await fetch(route('/mockup?screen=checkout&state=error'));
  assert.match(mockup.headers.get('content-security-policy') ?? '', /connect-src 'none'/);
  const mockupHtml = await mockup.text();
  assert.match(mockupHtml, /scrum:element-picked/);
  const { runInNewContext } = await import('node:vm');
  const listeners: Record<string, Array<(event?: { data: unknown; source: unknown }) => void>> = {};
  const root = { dataset: {} as Record<string, string>, style: {} };
  const parent = {};
  const window = { parent, addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn), dispatchEvent: (event: { data: unknown; source: unknown }) => { for (const fn of listeners.message ?? []) fn(event); } };
  runInNewContext([...mockupHtml.matchAll(/<script>([^]*?)<\/script>/g)].at(-1)![1], { window, parent, document: { documentElement: root, addEventListener: window.addEventListener }, MessageEvent: class { constructor(_type: string, data: object) { Object.assign(this, data); } } });
  const routes: unknown[] = [];
  listeners.message.push(e => routes.push(e!.data));
  for (const type of ['DOMContentLoaded', 'load']) for (const fn of listeners[type]) fn();
  assert.deepEqual(root.dataset, { screen: 'checkout', state: 'error', viewport: 'desktop' });
  assert.deepEqual(JSON.parse(JSON.stringify(routes)), Array(2).fill({ type: 'scrum:set-state', screen: 'checkout', state: 'error', viewport: 'desktop' }));
  const asset = await fetch(route('/asset?path=.scratch%2Fstudio%2Fmockups%2Fcheckout-mobile.png'));
  assert.match(asset.headers.get('content-type') ?? '', /image\/png/);
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
  assert.equal((await fetch(route('/asset?path=package.json'))).status, 404);
  const payload = { revision: 1, digest: f.design.digest, decision: 'changes_requested', rationale: 'Fix checkout contrast', findings: [{ screen: 'checkout', state: 'populated', viewport: 'mobile', selector: 'button.pay-cta', status: 'revise', note: 'Low contrast' }], screenStatuses: { catalog: 'approved', checkout: 'revise' } };
  const post = (origin: string) => fetch(route('/api/decision'), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await post('https://evil.example')).status, 403);
  const response = await post(url.origin);
  assert.equal(response.status, 200, await response.clone().text());
  const run = readRun(f.state, 'p', f.run.runId);
  assert.equal(run.design?.decision, 'changes_requested');
  assert.deepEqual(run.design?.findings, payload.findings);
  assert.deepEqual(run.design?.screenStatuses, payload.screenStatuses);
  assert.equal((await post(url.origin)).status, 409, 'a stale tab cannot replace the submitted decision');
});

test('controller blocks incomplete multi-screen evidence before Owner review', async t => {
  const { designFixture } = await import('./fixtures/scrum-design.ts');
  for (const mutate of [
    (r: import('../src/scrum/design-contract.ts').BrowserEvidenceReport) => { r.viewports = r.viewports.filter(v => v.screen !== 'checkout' || v.name !== 'mobile'); },
    (r: import('../src/scrum/design-contract.ts').BrowserEvidenceReport) => { r.states = r.states.filter(s => s.screen !== 'checkout' || s.state !== 'offline'); },
    (r: import('../src/scrum/design-contract.ts').BrowserEvidenceReport) => { r.detector!.passed = false; },
  ]) {
    const f = await designFixture(t, mutate);
    assert.throws(f.submit, { code: 'browser-evidence-invalid' });
    assert.equal(readRun(f.state, 'p', f.run.runId).design, undefined);
  }
});


test('legacy multi-screen reports cannot use the single-screen compatibility exception', async t => {
  const { designFixture } = await import('./fixtures/scrum-design.ts');
  const f = await designFixture(t, report => {
    delete report.screens; delete report.detector;
    report.viewports = [{ ...report.viewports[0], width: 800, height: 600 }];
  }, { 'EXPERIENCE.md': 'Legacy screen prose without explicit headings.' });
  assert.throws(f.submit, { code: 'browser-evidence-invalid' });
});

test('studio injects its DOM picker into valid mockups with optional body tags omitted', async t => {
  const { designFixture, designFiles } = await import('./fixtures/scrum-design.ts');
  const { scrumOperation } = await import('../src/scrum/controller.ts');
  const f = await designFixture(t, undefined, { 'mockups/index.html': designFiles['mockups/index.html'].replace(/<\/?body>/g, '') });
  f.submit();
  const preview = await scrumOperation({ operation: 'preview.url', runId: f.run.runId, requestId: 'bodyless' }, f.ctx) as { url: string };
  const url = new URL(preview.url); url.pathname = '/mockup';
  const response = await fetch(url);
  assert.match(await response.text(), /scrum:element-picked/);
});

test('surface-scoped design submission exposes structured tokens and rejects debug chrome', async t => {
  const { designFixture, designFiles } = await import('./fixtures/scrum-design.ts');
  const { scrumOperation } = await import('../src/scrum/controller.ts');
  const files = {
    'EXPERIENCE.md': designFiles['EXPERIENCE.md'].replace('## Screen: catalog', '## Screen: catalog\n- **Surface:** mobile').replace('## Screen: checkout', '## Screen: checkout\nSurface: desktop'),
    'DESIGN.md': '---\ncolors:\n    ink: "#183153"\n    paper: "#ffffff"\ntypography:\n    body:\n      fontFamily: Georgia\n      fontSize: 16px\n      lineHeight: 1.5\nspacing:\n    xs: "4px"\n    sm: "8px"\nrounded:\n    card: "12px"\ncomponents:\n    button: "Ink background, paper text"\n---\nAn expectation gap inside a workspace is not a spacing token.\n',
    'mockups/index.html': designFiles['mockups/index.html'].replace('<button id="buy">', '<nav>Home</nav><button id="buy">'),
  };
  const f = await designFixture(t, r => { r.viewports = r.viewports.filter(v => v.screen === 'catalog' ? v.width === 390 : v.width === 1280); }, files);
  assert.equal((f.submit() as ReturnType<typeof readRun>).phase, 'awaiting-ui-approval');
  const preview = await scrumOperation({ operation: 'preview.url', runId: f.run.runId, requestId: 'surface-preview' }, f.ctx) as { url: string };
  const url = new URL(preview.url); url.pathname = '/api/state';
  const model = await (await fetch(url)).json() as { screens: Array<{ surface: string }>; tokens: { colors: string[]; spacing: string[]; radius: string[]; typography: string[]; components: string[] } };
  assert.deepEqual(model.screens.map(s => s.surface), ['mobile', 'desktop']);
  assert.deepEqual(model.tokens.colors, ['#183153', '#ffffff']);
  assert.deepEqual(model.tokens.spacing, ['xs: 4px', 'sm: 8px']);
  assert.deepEqual(model.tokens.radius, ['card: 12px']);
  assert.match(model.tokens.typography.join(), /body.*Georgia.*16px/);
  assert.deepEqual(model.tokens.components, ['button: Ink background, paper text']);
  const bad = await designFixture(t, undefined, { ...files, 'mockups/index.html': files['mockups/index.html'].replace('<nav>', '<button data-target-state="empty">empty</button><nav>') });
  assert.throws(bad.submit, /debug-chrome/);
});
