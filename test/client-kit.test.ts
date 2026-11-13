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
