/**
 * Seam 2 (v0.6.0, ADR 0056 W0): the client bundle Gate refuses browser-only
 * APIs that crash Paseo's native app (Hermes + React Native `window` has no
 * `addEventListener`, no DOM element exists). It drives scripts/check-bundle.mjs
 * over a tracked-files fixture exactly as the installed-artifacts tests do, and
 * asserts only on its exit status and the failure text.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

function clientFixture(t: TestContext) {
  const dir = realpathSync(makeTempDir());
  disposeDir(t, dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "plugin/server"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts/check-bundle.mjs"), join(dir, "scripts/check-bundle.mjs"));
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "plugin/index.server.ts"), "export const server = 1;\n");
  const check = (clientSource: string) => {
    writeFileSync(join(dir, "plugin/index.client.tsx"), `${clientSource}\nexport const client = 1;\n`);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["add", "scripts", "plugin"], { cwd: dir, stdio: "pipe" });
    return spawnSync(process.execPath, [join(dir, "scripts/check-bundle.mjs")], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_PATH: "" } });
  };
  return { check };
}

for (const unsafe of [
  { name: "an unguarded window event listener", source: 'window.addEventListener("focus", () => {});', error: /window\.addEventListener/ },
  { name: "an unguarded window listener removal", source: 'export const off = () => window.removeEventListener("focus", () => {});', error: /window\.removeEventListener/ },
  { name: "a window listener guarded only by a typeof window check", source: 'if (typeof window !== "undefined") window.addEventListener("focus", () => {});', error: /window\.addEventListener/ },
  { name: "an unguarded document event listener", source: 'document.addEventListener("visibilitychange", () => {});', error: /document\.addEventListener/ },
  { name: "a DOM iframe created through React", source: 'import { createElement } from "react"; export const frame = () => createElement("iframe", { srcDoc: "<p/>" });', error: /iframe/ },
  { name: "a DOM image created through React", source: 'import { createElement } from "react"; export const img = () => createElement("img", { src: "x" });', error: /img/ },
  { name: "a DOM element created through the document", source: 'export const el = () => document.createElement("div");', error: /document\.createElement/ },
]) {
  test(`the client bundle Gate refuses ${unsafe.name}`, (t) => {
    const refused = clientFixture(t).check(unsafe.source);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, unsafe.error);
    assert.match(refused.stderr, /index\.client\.tsx/, "the failure names the offending module");
  });
}

test("the client bundle Gate accepts browser event APIs behind a typeof method guard and native-only element creation", (t) => {
  const accepted = clientFixture(t).check(
    [
      'import { createElement } from "react";',
      'import { View } from "react-native";',
      'export const on = (fn: () => void) => { if (typeof window?.addEventListener === "function") window.addEventListener("focus", fn); };',
      'export const off = (fn: () => void) => { if (typeof window?.removeEventListener === "function") window.removeEventListener("focus", fn); };',
      'export const both = (fn: () => void) => typeof window?.addEventListener === "function" && window.addEventListener("blur", fn);',
      'export const optional = (fn: () => void) => { (window as { addEventListener?: (n: string, f: () => void) => void }).addEventListener?.("focus", fn); };',
      "export const native = () => createElement(View, {});",
    ].join("\n"),
  );
  assert.equal(accepted.status, 0, accepted.stderr);
});
