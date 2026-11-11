#!/usr/bin/env node
/**
 * The Hermes bundle boundary check (v0.0.13, ADR 0009 §5) — replicates the
 * daemon's plugin compiler rules over this repo's plugin directory, building
 * BOTH bundles from the git-tracked files alone (as Paseo's loader builds
 * them):
 *
 * - placement: modules live in client/, server/, shared/, or the index
 *   entries; relative imports never cross places (shared is shared).
 * - specifiers: node builtins and @types/node stay server-side; SDK
 *   client-only specifiers (and react/react-native) stay client-side; the
 *   host-private @getpaseo/plugin/client/host is rejected everywhere; every
 *   other package must be an installed dependency.
 * - esbuild config mirrors the daemon compiler exactly (CJS, automatic JSX,
 *   neutral platform + es2020 + `async-await: false` for Hermes on the
 *   client; externals = SDK + react/react-native/zod).
 * - after a successful client build, the bundle output is parsed with the
 *   TypeScript compiler API: class declarations/expressions fail — Hermes
 *   evaluates class syntax to undefined (PigMonitor's check, replicated).
 * - the same parse refuses browser-only APIs that crash Paseo mobile
 *   (v0.6.0, ADR 0056): `window`/`document` event APIs not behind a
 *   `typeof <host>?.<method> === "function"` guard (React Native's `window`
 *   has no addEventListener; bare global `addEventListener(…)` calls included), and DOM element creation (a string-tag
 *   createElement/jsx call, or `document.createElement`).
 *
 * Exit 0: both bundles build from the tracked files alone. Exit 1: they do
 * not, with every failure named.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const CLIENT_SDK = ["@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native"];
const SERVER_SDK = ["@getpaseo/plugin/server", "@getpaseo/plugin/server/provider", "@getpaseo/plugin/server/usage", "@getpaseo/plugin/server/acp"];
const SDK = ["@getpaseo/plugin", ...SERVER_SDK, ...CLIENT_SDK];
const CLIENT_ONLY = /^((?:@types\/)?react(?:-dom|-native)?|use-sync-external-store|@tanstack\/react-query)(\/|$)/;
const IMPORTS = /\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const HOST = /^(zod|react|react-native|@tanstack\/react-query)(\/|$)/;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = path.join(repoRoot, "plugin");

/** A temp copy of the plugin directory's tracked files — the loader's view, no untracked strays. */
function trackedCopy(source) {
  const copy = realpathSync.native(mkdtempSync(path.join(tmpdir(), "factory-bundle-")));
  // The inner git must resolve the worktree from its cwd exactly as an
  // interactive call does: `git commit` exports GIT_DIR/GIT_INDEX_FILE to the
  // pre-commit hook (a linked worktree's gitdir and index), and inheriting
  // them here makes `ls-files --cached` treat plugin/ as the worktree top and
  // return every repo-root-relative path — nesting the copy one level too
  // deep so the bundle entries vanish. Strip the hook's exported GIT_* vars.
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const files = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: source, env }).toString("utf8").split("\0").filter(Boolean);
  for (const file of files) {
    if (!existsSync(path.join(source, file))) continue;
    mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    if (lstatSync(path.join(source, file)).isSymbolicLink()) symlinkSync(readlinkSync(path.join(source, file)), path.join(copy, file));
    else copyFileSync(path.join(source, file), path.join(copy, file));
  }
  return copy;
}

const root = trackedCopy(realpathSync.native(pluginRoot));

function placeOf(file) {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "outside";
  const [first] = relative.split(path.sep);
  if (first === "node_modules") return null;
  if (first === "client" || first === "server" || first === "shared") return first;
  if (/^index\.client\.tsx?$/.test(relative)) return "client";
  if (/^index\.server\.tsx?$/.test(relative)) return "server";
  return "invalid";
}

function installError(specifier, importer, typeOnly) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier) || SDK.includes(specifier) || HOST.test(specifier) || isBuiltin(specifier) || specifier === "@types/node") return null;
  // Paseo's runtime boundary resolves both type-only and runtime imports from
  // the isolated checkout directory (which has no node_modules), so any
  // non-SDK, non-HOST package specifier fails `paseo plugin install git:...`.
  const from = importer;
  try {
    createRequire(from).resolve(specifier);
    return null;
  } catch {
    return typeOnly ? `Could not resolve type dependency "${specifier}" imported by ${importer}` : `Could not resolve "${specifier}" imported by ${importer}`;
  }
}

function specifierError(specifier, owner) {
  if (specifier === "@getpaseo/plugin/client/host") return "host-private";
  if ((specifier === "@getpaseo/plugin" || specifier.startsWith("@getpaseo/plugin/")) && !SDK.includes(specifier)) return "Unknown SDK";
  if (owner !== "server" && (isBuiltin(specifier) || specifier === "@types/node")) return "Node";
  if (owner !== "server" && SERVER_SDK.includes(specifier)) return "server-only";
  if (owner !== "client" && (CLIENT_SDK.includes(specifier) || CLIENT_ONLY.test(specifier))) return "client-only";
  return null;
}

function placementError(specifier, importer, owner) {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return null;
  const place = placeOf(path.resolve(path.dirname(importer), specifier));
  if (place === "invalid") return `Plugin modules belong in client/, server/, or shared/: ${specifier} imported by ${importer}`;
  if (place === "outside") return `Module escapes installed plugin: ${specifier} imported by ${importer}`;
  if (place === null || place === "shared" || place === owner) return null;
  return `${place}-only module cannot be imported into the plugin ${owner} bundle: ${specifier} imported by ${importer}`;
}

function boundary(target) {
  const ownerOf = (file) => (placeOf(file) === "shared" ? "shared" : target);
  const check = (specifier, importer) => {
    const owner = ownerOf(importer);
    const kind = specifierError(specifier, owner);
    if (kind) return `${kind} module cannot be imported into the plugin ${owner} bundle: ${specifier} imported by ${importer}`;
    return placementError(specifier, importer, owner);
  };
  return {
    name: `factory-${target}-boundary`,
    setup(context) {
      context.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        const place = placeOf(args.path);
        if (place === "outside") return { errors: [{ text: `Module escapes installed plugin: ${args.path}` }] };
        if (place === null) return null;
        for (const match of readFileSync(args.path, "utf8").matchAll(IMPORTS)) {
          const specifier = match[2] ?? match[3];
          const error = check(specifier, args.path) ?? installError(specifier, args.path, Boolean(match[1]));
          if (error) return { errors: [{ text: error }] };
        }
        return null;
      });
      context.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return null;
        const error = check(args.path, args.importer);
        return error ? { errors: [{ text: error }] } : null;
      });
    },
  };
}

function bundle(entry, target) {
  return build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    loader: { ".svg": "text" },
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    mainFields: target === "client" ? ["module", "main"] : undefined,
    supported: target === "client" ? { "async-await": false } : undefined,
    external: target === "client" ? [...SDK, "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod"] : [...SDK, "zod"],
    plugins: [boundary(target)],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
}

/** Hermes evaluates class syntax to undefined — no class may reach the client bundle. */
function classSyntaxErrors(code) {
  const parsed = ts.createSourceFile("client.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const modules = [...code.matchAll(/^\/\/ (.+)$/gm)].map((match) => ({ at: match.index, file: path.relative(root, path.resolve(match[1])) }));
  const errors = [];
  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const start = node.getStart(parsed);
      const file = modules.findLast((module) => module.at < start)?.file ?? "client bundle";
      const name = node.name?.text ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(parsed) : "(anonymous)");
      errors.push(`${file}: class ${name} reaches the client bundle, where Paseo's native app (Hermes) evaluates class syntax to undefined; use a function or factory instead`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return errors;
}

const HOST_OBJECTS = new Set(["window", "document", "globalThis", "self"]);
const EVENT_APIS = new Set(["addEventListener", "removeEventListener", "dispatchEvent"]);

/** `window.addEventListener` / `window?.addEventListener` / `window["addEventListener"]` → "window.addEventListener". */
function hostApiOf(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
  const host = node.expression;
  if (!ts.isIdentifier(host) || !HOST_OBJECTS.has(host.text)) return null;
  const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
  return name === null ? null : { host: host.text, name };
}

/** A bare call of a global event API (`addEventListener(…)`) — the global object is the host, so React Native's missing method is just as fatal. */
function bareApiOf(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && EVENT_APIS.has(node.expression.text) ? { host: null, name: node.expression.text } : null;
}

/** Names a module itself declares (variable, function, parameter, binding), so its own local `addEventListener` is not mistaken for the global. */
function declaredEventApiNames(parsed) {
  const names = new Set();
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && node.name && ts.isIdentifier(node.name) && EVENT_APIS.has(node.name.text)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return names;
}

/** True when a `typeof <host>.<name>` test (any optional-chain spelling) is the condition of an enclosing if / ternary / && that governs this node. */
function guardedByTypeof(node, api) {
  const tests = (condition) => {
    let found = false;
    const scan = (n) => {
      if (ts.isTypeOfExpression(n)) {
        const operand = n.expression;
        const target = api.host === null ? (ts.isIdentifier(operand) ? { host: null, name: operand.text } : null) : hostApiOf(operand);
        if (target && target.host === api.host && target.name === api.name) found = true;
      }
      ts.forEachChild(n, scan);
    };
    scan(condition);
    return found;
  };
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child && tests(parent.expression)) return true;
    if (ts.isConditionalExpression(parent) && parent.whenTrue === child && tests(parent.condition)) return true;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child && tests(parent.left)) return true;
  }
  return false;
}

/** Optional-call spelling: `window.addEventListener?.(…)` throws on no host. */
function optionallyCalled(node) {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression === node && parent.questionDotToken !== undefined;
}

/** Paseo mobile (React Native on Hermes) has no DOM: no window/document event APIs without a method guard, and no element creation. */
function browserApiErrors(code) {
  const parsed = ts.createSourceFile("client.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const modules = [...code.matchAll(/^\/\/ (.+)$/gm)].map((match) => ({ at: match.index, file: path.relative(root, path.resolve(match[1])) }));
  const errors = [];
  const fileOf = (node) => modules.findLast((module) => module.at < node.getStart(parsed))?.file ?? "client bundle";
  const report = (node, message) => {
    errors.push(`${fileOf(node)}: ${message}`);
  };
  const declared = declaredEventApiNames(parsed);
  const calleeName = (callee) => (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null);
  const visit = (node) => {
    const api = hostApiOf(node);
    if (api && EVENT_APIS.has(api.name) && !optionallyCalled(node) && !guardedByTypeof(node, api) && !ts.isTypeOfExpression(node.parent)) {
      report(node, `${api.host}.${api.name} is used without a \`typeof ${api.host}?.${api.name} === "function"\` guard — React Native's ${api.host} has no ${api.name}, so Paseo mobile crashes on load`);
    }
    const bare = bareApiOf(node);
    if (bare && !declared.has(bare.name) && !guardedByTypeof(node, bare)) {
      report(node, `bare ${bare.name} is used without a \`typeof ${bare.name} === "function"\` guard — React Native's global scope has no ${bare.name}, so Paseo mobile crashes on load`);
    }
    if (api && api.host === "document" && /^createElement/.test(api.name)) {
      report(node, `document.${api.name} creates a DOM element — Paseo mobile has no DOM; use the plugin SDK's DocumentFrame or React Native primitives`);
    }
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      // esbuild emits (0, import_react.createElement)(…) for namespace calls.
      if (ts.isParenthesizedExpression(callee) && ts.isBinaryExpression(callee.expression) && callee.expression.operatorToken.kind === ts.SyntaxKind.CommaToken) callee = callee.expression.right;
      const name = calleeName(callee);
      const first = node.arguments[0];
      if (name && /^(createElement|jsx|jsxs|jsxDEV|_jsx|_jsxs)$/.test(name) && first && ts.isStringLiteralLike(first)) {
        report(node, `DOM element <${first.text}> is created — Paseo mobile has no DOM; use the plugin SDK's DocumentFrame or React Native primitives`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return errors;
}

/** Paseo's server loader evaluates the compiled CJS bundle without `import.meta` or `__dirname`. */
function serverEvalErrors(code) {
  const mod = { exports: {} };
  const hostRequire = createRequire(import.meta.url);
  const cjsRequire = (specifier) => hostRequire(specifier);
  try {
    vm.runInNewContext(code, {
      require: cjsRequire,
      module: mod,
      exports: mod.exports,
      process,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
    });
    return [];
  } catch (error) {
    return [`server bundle failed CJS evaluation (as Paseo's plugin loader evaluates it): ${error instanceof Error ? error.message : String(error)}`];
  }
}

const results = await Promise.allSettled([bundle("index.client.tsx", "client"), bundle("index.server.ts", "server")]);
rmSync(root, { recursive: true, force: true });
const failures = results.flatMap((result) => (result.status === "rejected" ? (result.reason.errors?.map((error) => `${error.location ? `${error.location.file}:${error.location.line}: ` : ""}${error.text}`) ?? [String(result.reason)]) : []));
if (results[0].status === "fulfilled") {
  failures.push(...classSyntaxErrors(results[0].value.outputFiles[0].text));
  failures.push(...browserApiErrors(results[0].value.outputFiles[0].text));
}
if (results[1].status === "fulfilled") failures.push(...serverEvalErrors(results[1].value.outputFiles[0].text));
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("client and server bundles build from the tracked plugin files alone, as Paseo's plugin loader builds them");
