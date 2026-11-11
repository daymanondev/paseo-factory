/**
 * v0.6.0 W0 (ADR 0056): the Factory client mounts on Paseo mobile. React
 * Native's `window` is a bare object with no `addEventListener` and there is
 * no DOM, so client modules that run on mount must treat the host as
 * possibly lacking browser methods. These tests mount the real client modules
 * (bundled from source, native primitives adapted to markup) under a
 * RN-like `window` and assert on what renders and whether mounting throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";

type Exports = Record<string, any>;

/** Bundles one client module with react-native / SDK ui replaced by markup adapters, then evaluates it. */
async function load(entry: string, platformOs = "ios"): Promise<Exports> {
  const bundle = await build({
    entryPoints: [join(repoRoot, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "native-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui|@getpaseo\/plugin\/client)$/ }, (args) => ({ path: args.path, namespace: "native" }));
          b.onLoad({ filter: /.*/, namespace: "native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              const tag = (name) => ({ children, onPress, disabled, ...rest }) => React.createElement(name, { disabled, onClick: onPress, 'data-testid': rest.testID }, children);
              exports.View = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button'); exports.TextInput = tag('input');
              exports.Icon = () => null;
              exports.Platform = { OS: ${JSON.stringify(platformOs)}, select: (spec) => (spec[${JSON.stringify(platformOs)}] !== undefined ? spec[${JSON.stringify(platformOs)}] : spec.default) };
              exports.DocumentFrame = ({ url }) => React.createElement('section', { 'data-document-frame': url });
              const Modal = ({ children, open }) => (open ? React.createElement('div', null, children) : null);
              Modal.Content = tag('div');
              exports.Modal = Modal;
            `,
          }));
        },
      },
    ],
  });
  const compiled = { exports: {} as Exports };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), compiled, compiled.exports);
  return compiled.exports;
}

/** A DOM for React's renderer, whose `window` is then made RN-like: no event APIs, no document. */
async function mountUnderNativeWindow<T>(run: (render: typeof import("react-dom/client").createRoot, container: HTMLElement, act: (fn: () => void | Promise<void>) => Promise<void>) => Promise<T>): Promise<T> {
  // jsdom ships no types in this repo; it only stands in for the DOM React's renderer needs.
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window; g.document = dom.window.document; g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  try {
    return await run(createRoot, dom.window.document.getElementById("root")!, (fn) => act(async () => { await fn(); }));
  } finally {
    g.window = saved.window; g.document = saved.document; g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
}

/** React Native's window: no addEventListener / removeEventListener / dispatchEvent, and no `document` global. */
function goNative() {
  const w = (globalThis as Record<string, any>).window;
  for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) Object.defineProperty(w, key, { value: undefined, configurable: true, writable: true });
  delete (globalThis as Record<string, unknown>).document;
}

test("usePoll mounts and unmounts under a RN-like window that has no addEventListener", async () => {
  const { usePoll } = await load("plugin/client/kit/poll.ts");
  const { createElement } = await import("react");
  let seen: { value: string | null } = { value: null };
  const Probe = () => { seen = usePoll(async () => ({ ok: true as const, value: "view" }), "key", () => 30000); return null; };
  await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    goNative();
    await act(() => root.render(createElement(Probe)));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    assert.equal(seen.value, "view", "the poll still loads the first view without the focus listener");
    await act(() => root.unmount());
  });
});

test("StudioRelay mounts under a RN-like window and renders the SDK DocumentFrame, never a DOM iframe", async () => {
  const { StudioRelay } = await load("plugin/client/factory/studio-relay.tsx");
  const { createElement } = await import("react");
  const theme = { colors: { surface0: "#fff", surface1: "#fff", surface2: "#fff", foreground: "#111", foregroundMuted: "#555", accent: "#35a", border: "#ccc", statusSuccess: "#272", statusWarning: "#860", statusDanger: "#a33" } };
  const bundle = { studioHtml: "<p>Studio</p>", channel: "c", activeGateId: null, model: { revision: 1, runId: "r", design: { revision: 1, digest: "d" } } };
  const html = await mountUnderNativeWindow(async (createRoot, container, act) => {
    const root = createRoot(container);
    goNative();
    await act(() => root.render(createElement(StudioRelay, { theme, bundle, close() {} })));
    const markup = container.innerHTML;
    await act(() => root.unmount());
    return markup;
  });
  assert.match(html, /data-document-frame="data:text\/html/, "Studio renders through DocumentFrame on a document URL");
  assert.doesNotMatch(html, /<iframe|<img/, "no DOM iframe or img element is created");
});

test("the code text role carries a font family iOS ships, not the bare 'monospace' keyword", async () => {
  const ios = await load("plugin/client/kit/theme.ts", "ios");
  const android = await load("plugin/client/kit/theme.ts", "android");
  const theme = { colors: { foreground: "#111", foregroundMuted: "#555" } };
  assert.equal(ios.text(theme, "code").fontFamily, "Menlo");
  assert.equal(android.text(theme, "code").fontFamily, "monospace");
});
