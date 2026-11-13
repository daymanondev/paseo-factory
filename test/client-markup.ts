/**
 * Shared harness for the client markup tests: bundles a real client module
 * from source with the React Native primitives adapted to markup that keeps
 * `testID` and `style` (Node cannot mount React Native), then lets a test
 * `renderToStaticMarkup` it and assert on what an Owner would see.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";

export type Exports = Record<string, any>;

export async function loadClientModule(entry: string): Promise<Exports> {
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
              // Pressable style / children may be functions; data-idle-style is the unpressed, unhovered style, data-selected the tab state, data-checked the switch state.
              const tag = (name) => ({ children, onPress, disabled, testID, style, accessibilityRole, accessibilityState, accessibilityLabel }) =>
                React.createElement(name, { disabled, onClick: onPress, 'data-testid': testID, 'data-role': accessibilityRole, 'aria-label': accessibilityLabel, 'data-checked': accessibilityState && accessibilityState.checked !== undefined ? String(accessibilityState.checked) : undefined, 'data-selected': accessibilityState && accessibilityState.selected !== undefined ? String(accessibilityState.selected) : undefined, 'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined, 'data-idle-style': typeof style === 'function' ? JSON.stringify(style({ pressed: false })) : undefined }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div'); exports.Text = tag('span'); exports.Pressable = tag('button');
              exports.Icon = () => null;
              exports.TextInput = ({ value, placeholder, testID }) => React.createElement('input', { value: value ?? '', placeholder, readOnly: true, 'data-testid': testID });
              exports.Platform = { OS: 'ios', select: (spec) => (spec.ios !== undefined ? spec.ios : spec.default) };
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

/** A minimal Paseo theme — only the colours the client reads. */
export const testTheme = {
  colors: {
    surface0: "#ffffff", surface1: "#f5f5f5", surface2: "#eeeeee", foreground: "#111111", foregroundMuted: "#555555",
    accent: "#3355aa", border: "#cccccc", statusSuccess: "#217342", statusWarning: "#aa8800", statusDanger: "#cc0000",
  },
};
