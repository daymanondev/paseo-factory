/**
 * The client kit's shared controls: the Btn variant hierarchy and the
 * underline Tabs, rendered through the static-markup harness. Pressable
 * styles are functions, so the harness exposes the idle (unpressed, unhovered)
 * one as `data-idle-style`; label colours are plain Text styles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadClientModule, testTheme } from "./client-markup.ts";
import { sidebarOverviewBadgePlan, workspaceRowBadgePlan } from "../plugin/client/kit/directory.ts";
import type { ProjectDirectoryEntry } from "../plugin/shared/view.ts";

const theme = testTheme as never;
const c = testTheme.colors;

const kit = await loadClientModule("plugin/client/kit/pill.tsx");
const tabs = await loadClientModule("plugin/client/kit/tabs.tsx");

const btn = (props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement(kit.Btn, { theme, label: "Go", onPress: () => {}, testID: "b", ...props }));
const labelColour = (html: string): string | undefined => new RegExp(`&quot;color&quot;:&quot;(#[0-9a-f]+)&quot;\\}"[^>]*>Go<`).exec(html)?.[1];
const idle = (html: string, key: string): string | undefined => new RegExp(`&quot;${key}&quot;:&quot;([^&]+)&quot;`).exec(html.slice(html.indexOf("data-idle-style")))?.[1];

test("a bare Btn is secondary — neutral border, surface1, foreground label (not the old accent outline)", () => {
  const html = btn();
  assert.equal(labelColour(html), c.foreground);
  assert.equal(idle(html, "borderColor"), c.border);
  assert.equal(idle(html, "backgroundColor"), c.surface1);
});

test("solid and variant=primary are the accent-filled button with a surface0 label", () => {
  for (const html of [btn({ solid: true }), btn({ variant: "primary" })]) {
    assert.equal(labelColour(html), c.surface0);
    assert.equal(idle(html, "backgroundColor"), c.accent);
  }
});

test("an explicit tone keeps the tone-outline look — tone label, tinted fill and border", () => {
  const html = btn({ tone: "statusWarning" });
  assert.equal(labelColour(html), c.statusWarning);
  assert.equal(idle(html, "backgroundColor"), `${c.statusWarning}0d`);
  assert.equal(idle(html, "borderColor"), `${c.statusWarning}66`);
  assert.equal(labelColour(btn({ tone: "foregroundMuted" })), c.foreground, "the muted tone stays the neutral outline");
});

test("variant wins over solid and tone", () => {
  assert.equal(labelColour(btn({ variant: "secondary", solid: true, tone: "statusWarning" })), c.foreground);
});

test("ghost has a transparent border and fill with a muted label; danger is a neutral outline with a danger label", () => {
  const ghost = btn({ variant: "ghost" });
  assert.equal(labelColour(ghost), c.foregroundMuted);
  assert.equal(idle(ghost, "borderColor"), "transparent");
  assert.equal(idle(ghost, "backgroundColor"), "transparent");
  assert.match(ghost, /&quot;borderWidth&quot;:1[,}]/, "ghost keeps the 1px border so heights match");
  const danger = btn({ variant: "danger" });
  assert.equal(labelColour(danger), c.statusDanger);
  assert.equal(idle(danger, "borderColor"), c.border);
});

test("disabled keeps the muted label and 0.45 opacity for every variant", () => {
  for (const variant of ["primary", "secondary", "ghost", "danger"]) {
    const html = btn({ variant, disabled: true });
    assert.equal(labelColour(html), c.foregroundMuted, variant);
    assert.match(html, /&quot;opacity&quot;:0\.45/, variant);
  }
});

test("Btn keeps its testID and button role", () => {
  assert.match(btn(), /data-testid="b"[^>]*data-role="button"/);
});

test("Btn accentColour overrides primary, tone, and enabled ghost foreground while preserving disabled and defaults", () => {
  const lead = "#2f7899";
  const wait = "#8f6802";
  const bad = "#c8253d";

  const primary = btn({ variant: "primary", accentColour: lead });
  assert.equal(labelColour(primary), c.surface0);
  assert.equal(idle(primary, "backgroundColor"), lead);
  assert.equal(idle(primary, "borderColor"), `${lead}66`);

  const toneBtn = btn({ tone: "statusWarning", accentColour: wait });
  assert.equal(labelColour(toneBtn), wait);
  assert.equal(idle(toneBtn, "backgroundColor"), `${wait}0d`);
  assert.equal(idle(toneBtn, "borderColor"), `${wait}66`);

  const ghost = btn({ variant: "ghost", accentColour: bad });
  assert.equal(labelColour(ghost), bad);
  assert.equal(idle(ghost, "borderColor"), "transparent");
  assert.equal(idle(ghost, "backgroundColor"), "transparent");

  const disabledGhost = btn({ variant: "ghost", accentColour: bad, disabled: true });
  assert.equal(labelColour(disabledGhost), c.foregroundMuted);
  assert.match(disabledGhost, /&quot;opacity&quot;:0\.45/);
});

test("Card forwards optional testID and keeps shared card container styling", () => {
  const withId = renderToStaticMarkup(createElement(kit.Card, { theme, testID: "card-hook" }, createElement("span", null, "Body")));
  assert.match(withId, /data-testid="card-hook"/);
  assert.match(withId, /&quot;borderWidth&quot;:1,&quot;borderColor&quot;:&quot;#cccccc&quot;,&quot;backgroundColor&quot;:&quot;#f5f5f5&quot;,&quot;borderRadius&quot;:8,&quot;padding&quot;:12/);
  const withoutId = renderToStaticMarkup(createElement(kit.Card, { theme }, createElement("span", null, "Body")));
  assert.equal(withoutId.includes("data-testid="), false);
});

test("AlertRow renders 3px bar, tinted fill, and places actions on title line when wide or below children when narrow", () => {
  const colour = "#c8253d";
  const renderAlert = (wide: boolean) =>
    renderToStaticMarkup(
      createElement(
        kit.AlertRow,
        {
          theme,
          testID: "alert-hook",
          colour,
          title: "Broken state",
          wide,
          actions: createElement(kit.Btn, { theme, small: true, label: "Fix", testID: "alert-action", onPress: () => {} }),
        },
        createElement("span", { "data-testid": "alert-detail" }, "Detail copy"),
      ),
    );

  const wide = renderAlert(true);
  assert.match(wide, /data-testid="alert-hook"/);
  assert.match(wide, /&quot;backgroundColor&quot;:&quot;#c8253d10&quot;/);
  assert.match(wide, /&quot;width&quot;:3,&quot;backgroundColor&quot;:&quot;#c8253d&quot;/);
  assert.match(wide, /&quot;color&quot;:&quot;#c8253d&quot;[^}]*\}"[^>]*>Broken state</);
  assert.ok(wide.indexOf('data-testid="alert-action"') < wide.indexOf('data-testid="alert-detail"'), "wide places actions on the title row before children");

  const narrow = renderAlert(false);
  assert.ok(narrow.indexOf('data-testid="alert-detail"') < narrow.indexOf('data-testid="alert-action"'), "narrow places actions below children");
});

test("ChoiceChip applies accentColour when selected and defaults to theme.colors.accent", () => {
  const lead = "#2f7899";
  const selectedWithAccent = renderToStaticMarkup(
    createElement(kit.ChoiceChip, { theme, testID: "cc-1", label: "Opt", selected: true, disabled: false, accentColour: lead, onPress: () => {} }),
  );
  assert.equal(idle(selectedWithAccent, "borderColor"), lead);
  assert.equal(idle(selectedWithAccent, "backgroundColor"), `${lead}1f`);
  assert.ok(selectedWithAccent.includes(`&quot;color&quot;:&quot;${lead}&quot;`));

  const selectedDefault = renderToStaticMarkup(
    createElement(kit.ChoiceChip, { theme, testID: "cc-2", label: "Opt", selected: true, disabled: false, onPress: () => {} }),
  );
  assert.equal(idle(selectedDefault, "borderColor"), c.accent);
  assert.equal(idle(selectedDefault, "backgroundColor"), `${c.accent}1f`);

  const unselected = renderToStaticMarkup(
    createElement(kit.ChoiceChip, { theme, testID: "cc-3", label: "Opt", selected: false, disabled: false, accentColour: lead, onPress: () => {} }),
  );
  assert.equal(idle(unselected, "borderColor"), c.border);
  assert.equal(idle(unselected, "backgroundColor"), c.surface1);
});

test("SegmentedControl supports control accentColour, per-option accentColour, and optionTestIDPrefix", () => {
  const lead = "#2f7899";
  const ok = "#337e58";
  const idleHex = "#677176";

  const controlAccent = renderToStaticMarkup(
    createElement(kit.SegmentedControl, {
      theme,
      testID: "seg-ctrl",
      accentColour: lead,
      value: "a",
      onChange: () => {},
      options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
    }),
  );
  assert.ok(controlAccent.includes('data-testid="seg-ctrl"'));
  assert.ok(controlAccent.includes('data-testid="seg-ctrl-a"'));
  assert.ok(controlAccent.includes(`&quot;borderColor&quot;:&quot;${lead}&quot;`));
  assert.ok(controlAccent.includes(`&quot;backgroundColor&quot;:&quot;${lead}20&quot;`));
  assert.ok(controlAccent.includes(`&quot;color&quot;:&quot;${lead}&quot;`));

  const perOptionAndPrefix = renderToStaticMarkup(
    createElement(kit.SegmentedControl, {
      theme,
      optionTestIDPrefix: "mode-opt",
      accentColour: lead,
      value: "auto",
      onChange: () => {},
      options: [
        { value: "off", label: "off", accentColour: idleHex },
        { value: "on-request", label: "on-request" },
        { value: "auto", label: "auto", accentColour: ok },
      ],
    }),
  );
  assert.equal(perOptionAndPrefix.includes('data-testid="mode-opt"'), false, "container omits testID when only optionTestIDPrefix is set");
  assert.ok(perOptionAndPrefix.includes('data-testid="mode-opt-off"'));
  assert.ok(perOptionAndPrefix.includes('data-testid="mode-opt-on-request"'));
  assert.ok(perOptionAndPrefix.includes('data-testid="mode-opt-auto"'));
  assert.ok(perOptionAndPrefix.includes(`&quot;borderColor&quot;:&quot;${ok}&quot;`));
  assert.ok(perOptionAndPrefix.includes(`&quot;backgroundColor&quot;:&quot;${ok}20&quot;`));
  assert.ok(perOptionAndPrefix.includes(`&quot;color&quot;:&quot;${ok}&quot;`));
  assert.equal(perOptionAndPrefix.includes(lead), false, "inactive option does not apply active tint");
});

test("Tabs renders one hook per tab and only the selected one carries the selected state", () => {
  const items = [{ id: "a", label: "Team" }, { id: "b", label: "Models", badge: 3 }, { id: "c", label: "Project", badge: 0 }];
  const html = renderToStaticMarkup(createElement(tabs.Tabs, { theme, tabs: items, value: "b", onChange: () => {}, testID: "x" }));
  for (const id of ["x", "x-a", "x-b", "x-c"]) assert.ok(html.includes(`data-testid="${id}"`), id);
  const selected = (id: string): string | undefined => new RegExp(`data-testid="x-${id}"[^>]*data-selected="(true|false)"`).exec(html)?.[1];
  assert.deepEqual(["a", "b", "c"].map(selected), ["false", "true", "false"]);
  assert.equal(html.match(/data-role="tab"/g)?.length, 3);
  assert.ok(html.includes(">3<"), "a positive badge renders its count");
  assert.equal(html.includes(">0<"), false, "a zero badge renders nothing");
  const bar = (id: string): string | undefined => new RegExp(`data-testid="x-${id}"[^>]*data-idle-style="[^"]*&quot;borderBottomColor&quot;:&quot;([^&]+)&quot;`).exec(html)?.[1];
  assert.deepEqual(["a", "b", "c"].map(bar), ["transparent", c.accent, "transparent"], "the active tab carries the accent bar");
});

test("Tabs only fires onChange for a different tab", () => {
  const seen: string[] = [];
  const el = createElement(tabs.Tabs, { theme, tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }], value: "a", onChange: (id: string) => seen.push(id), testID: "t" });
  const root = tabs.Tabs(el.props) as { props: { children: { props: { onPress: () => void } }[] } };
  root.props.children[0]!.props.onPress();
  root.props.children[1]!.props.onPress();
  assert.deepEqual(seen, ["b"]);
});

test("workspaceRowBadgePlan returns null for non-Factory workspaces, empty ids, and idle Projects", () => {
  const projects: ProjectDirectoryEntry[] = [
    { slug: "idle", root: "/tmp/idle", workspaceId: "ws-idle", needsYouCount: 0, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 0 },
    { slug: "legacy-idle", root: "/tmp/legacy", workspaceId: "ws-legacy", needsYouCount: 0 },
    { slug: "unanchored", root: "/tmp/unanchored", workspaceId: null, needsYouCount: 2, handoffActive: true, activeWorkCount: 1, backgroundWorkCount: 1 },
  ];

  assert.equal(workspaceRowBadgePlan("", projects), null);
  assert.equal(workspaceRowBadgePlan("ws-stranger", projects), null);
  assert.equal(workspaceRowBadgePlan("ws-idle", projects), null);
  assert.equal(workspaceRowBadgePlan("ws-legacy", projects), null);
});

test("workspaceRowBadgePlan enforces priority: Needs you > handoff > active work > background work", () => {
  const base = { slug: "proj", root: "/tmp/proj", workspaceId: "ws-1" };

  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 3, handoffActive: true, activeWorkCount: 2, backgroundWorkCount: 4 },
    ]),
    {
      label: "Needs you · 3",
      tone: "warning",
      icon: "AlertTriangle",
      accessibilityLabel: "Factory: Needs you · 3",
    },
  );

  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: true, activeWorkCount: 2, backgroundWorkCount: 4 },
    ]),
    {
      label: "Handing off",
      tone: "info",
      icon: "RefreshCw",
      accessibilityLabel: "Factory: Handing off",
    },
  );

  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: false, activeWorkCount: 1, backgroundWorkCount: 4 },
    ]),
    {
      label: "1 active",
      tone: "success",
      icon: "Activity",
      accessibilityLabel: "Factory: 1 active seat",
    },
  );

  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: false, activeWorkCount: 2, backgroundWorkCount: 0 },
    ]),
    {
      label: "2 active",
      tone: "success",
      icon: "Activity",
      accessibilityLabel: "Factory: 2 active seats",
    },
  );

  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 1 },
    ]),
    {
      label: "1 background",
      tone: "warning",
      icon: "Activity",
      accessibilityLabel: "Factory: 1 background process running",
    },
  );

  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: false, activeWorkCount: 0, backgroundWorkCount: 3 },
    ]),
    {
      label: "3 background",
      tone: "warning",
      icon: "Activity",
      accessibilityLabel: "Factory: 3 background processes running",
    },
  );
});

test("workspaceRowBadgePlan prioritizes Gate running and Gate #N below Needs you and Handing off, above active/background work", () => {
  const base = { slug: "proj", root: "/tmp/proj", workspaceId: "ws-1" };

  // Needs you beats Gate running
  assert.equal(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 1, handoffActive: false, gateQueueStatus: "running", gateQueuePosition: 1, activeWorkCount: 2 },
    ])?.label,
    "Needs you · 1",
  );

  // Handing off beats Gate running and Gate #N
  assert.equal(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: true, gateQueueStatus: "running", gateQueuePosition: 1, activeWorkCount: 2 },
    ])?.label,
    "Handing off",
  );
  assert.equal(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: true, gateQueueStatus: "queued", gateQueuePosition: 2, activeWorkCount: 2 },
    ])?.label,
    "Handing off",
  );

  // Gate running beats active and background work
  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: false, gateQueueStatus: "running", gateQueuePosition: 1, activeWorkCount: 2, backgroundWorkCount: 1 },
    ]),
    {
      label: "Gate running",
      tone: "success",
      icon: "Activity",
      accessibilityLabel: "Factory: Gate running",
    },
  );

  // Gate #N beats active and background work
  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: false, gateQueueStatus: "queued", gateQueuePosition: 3, activeWorkCount: 2, backgroundWorkCount: 1 },
    ]),
    {
      label: "Gate #3",
      tone: "warning",
      icon: "Clock",
      accessibilityLabel: "Factory: Gate #3",
    },
  );

  // Gate queued fallback when position is omitted
  assert.deepEqual(
    workspaceRowBadgePlan("ws-1", [
      { ...base, needsYouCount: 0, handoffActive: false, gateQueueStatus: "queued", gateQueuePosition: null, gateQueuePaused: true },
    ]),
    {
      label: "Gate queued",
      tone: "warning",
      icon: "Clock",
      accessibilityLabel: "Factory: Gate queued (paused)",
    },
  );
});

test("sidebarOverviewBadgePlan summarizes Needs you, running Gates, and queued Gates across all Projects", () => {
  const proj = (over: Partial<ProjectDirectoryEntry>): ProjectDirectoryEntry => ({
    slug: "p",
    root: "/tmp/p",
    workspaceId: "ws-1",
    needsYouCount: 0,
    ...over,
  });

  // Idle machine -> null
  assert.equal(
    sidebarOverviewBadgePlan([proj({}), proj({ slug: "p2", workspaceId: "ws-2" })], { paused: false, concurrency: 1, runningCount: 0, queuedCount: 0 }),
    null,
  );

  // Needs you only
  assert.deepEqual(
    sidebarOverviewBadgePlan([proj({ needsYouCount: 2 }), proj({ slug: "p2", needsYouCount: 1 })], { paused: false, concurrency: 1, runningCount: 0, queuedCount: 0 }),
    {
      needsYouCount: 3,
      runningCount: 0,
      queuedCount: 0,
      paused: false,
      label: "Needs you · 3",
      tone: "wait",
    },
  );

  // Running Gate (+ queued)
  assert.deepEqual(
    sidebarOverviewBadgePlan([proj({})], { paused: false, concurrency: 1, runningCount: 1, queuedCount: 2 }),
    {
      needsYouCount: 0,
      runningCount: 1,
      queuedCount: 2,
      paused: false,
      label: "Gate running · +2",
      tone: "ok",
    },
  );

  // Queued only (unpaused vs paused)
  assert.deepEqual(
    sidebarOverviewBadgePlan([proj({})], { paused: false, concurrency: 1, runningCount: 0, queuedCount: 2 }),
    {
      needsYouCount: 0,
      runningCount: 0,
      queuedCount: 2,
      paused: false,
      label: "2 queued",
      tone: "wait",
    },
  );
  assert.deepEqual(
    sidebarOverviewBadgePlan([proj({})], { paused: true, concurrency: 1, runningCount: 0, queuedCount: 2 }),
    {
      needsYouCount: 0,
      runningCount: 0,
      queuedCount: 2,
      paused: true,
      label: "Paused · 2",
      tone: "wait",
    },
  );

  // Fallback when gateQueue summary is absent (legacy/minimal payload)
  assert.deepEqual(
    sidebarOverviewBadgePlan([proj({ gateQueueStatus: "running" })]),
    {
      needsYouCount: 0,
      runningCount: 1,
      queuedCount: 0,
      paused: false,
      label: "Gate running",
      tone: "ok",
    },
  );
});
