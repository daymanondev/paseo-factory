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
