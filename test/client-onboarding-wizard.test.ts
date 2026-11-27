/**
 * Quick Start onboarding's client half (ADR 0073 amending ADR 0056 / ADR 0065).
 * The server owns every decision (`test/surface-rpc.test.ts` — the inspect and
 * start/commit doors); the client renders the single-screen Quick Start UI and
 * tracks Owner input. The state machine is pure (`onboarding-state.ts`) and the
 * real `onboarding-wizard.tsx` is mounted as markup and interactive DOM.
 * Source-text pins are limited to what Node cannot mount — the shell's host
 * wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";
import { loadClientModule, testTheme } from "./client-markup.ts";
import type { PanelView } from "../plugin/shared/view.ts";

async function loadInteractiveWizard(): Promise<Record<string, any>> {
  const bundle = await build({
    entryPoints: [join(repoRoot, "plugin/client/factory/onboarding-wizard.tsx")],
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
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui)$/ }, (args) => ({ path: args.path, namespace: "native" }));
          b.onLoad({ filter: /.*/, namespace: "native" }, () => ({
            loader: "js",
            contents: `
              const React = require('react');
              const tag = (name) => ({ children, onPress, disabled, testID, accessibilityRole, accessibilityState, accessibilityLabel }) =>
                React.createElement(name, {
                  disabled,
                  onClick: onPress,
                  'data-testid': testID,
                  'data-role': accessibilityRole,
                  'aria-label': accessibilityLabel,
                  'data-selected': accessibilityState && accessibilityState.selected !== undefined ? String(accessibilityState.selected) : undefined,
                }, typeof children === 'function' ? children({ pressed: false }) : children);
              exports.View = tag('div');
              exports.ScrollView = tag('div');
              exports.Text = tag('span');
              exports.Pressable = tag('button');
              exports.Icon = () => null;
              exports.TextInput = ({ value, placeholder, testID, onChangeText, editable }) =>
                React.createElement('input', {
                  value: value ?? '',
                  placeholder,
                  readOnly: !onChangeText || editable === false,
                  onInput: (e) => onChangeText && onChangeText(e.currentTarget.value),
                  'data-testid': testID,
                });
              const Modal = ({ children, open, title }) => (open ? React.createElement('div', { 'data-modal-title': title }, children) : null);
              Modal.Content = tag('div');
              exports.Modal = Modal;
              exports.Platform = { OS: 'web', select: (spec) => (spec.web !== undefined ? spec.web : spec.default) };
            `,
          }));
        },
      },
    ],
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), compiled, compiled.exports);
  return compiled.exports;
}

const theme = testTheme;
const MACHINE_LANES = { supervisor: "claude/opus-4-8", lead: "pi/zcode/glm-5.3", worker: "pi/zcode/glm-5.3", watch: "pi/zcode/glm-5.3", freshEyes: "pi/zcode/glm-5.3" };

const ready = (id: string, title: string) => ({ id, title, ready: true, detail: null });
const missing = (id: string, title: string, detail = "not installed") => ({ id, title, ready: false, detail });

const readyInspection = {
  ok: true, folder: "/work/my-app", gitRepo: true, hasCommits: true, registered: false, existingLead: false, existingSupervisor: false,
  prerequisites: [ready("factory-skills-pack", "Factory skills pack")], missingPrerequisites: [] as string[],
};

const view = { lanes: MACHINE_LANES, machineLanes: MACHINE_LANES, providers: [] };

const noopActions = {
  inspect: async () => readyInspection,
  start: async () => ({ ok: true as const, agentId: "agent-sup", projectRoot: "/work/my-app", slug: "my-app", bootstrapped: false, summary: "ok" }),
};

async function render(initialUi: Record<string, unknown>, props: Record<string, unknown> = {}): Promise<string> {
  const { OnboardingWizard } = await loadClientModule("plugin/client/factory/onboarding-wizard.tsx");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(createElement(OnboardingWizard, { theme, view, folder: "/work/my-app", actions: noopActions, initialUi, ...props }));
}

const hasHook = (html: string, id: string): boolean => html.includes(`data-testid="${id}"`);
/** The hook's element opens with `<button disabled=""` when disabled. */
const isDisabled = (html: string, id: string): boolean => new RegExp(`<button[^>]*disabled=""[^>]*data-testid="${id}"`).test(html);
function elementOf(html: string, id: string): string {
  const start = html.lastIndexOf("<div", html.indexOf(`data-testid="${id}"`));
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index! + m[0].length);
  }
  throw new Error(`unbalanced markup for ${id}`);
}

// ---- the pure state machine -----------------------------------------------------------------

test("Quick Start state preserves entered values across Customize models toggles and drops 4-step/design/directive fields", async () => {
  const mod = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  const { initialWizard, reduceWizard } = mod;
  assert.equal(mod.ONBOARDING_STEPS, undefined);
  assert.equal(mod.canAdvance, undefined);
  assert.equal(mod.stepLabel, undefined);

  let state = initialWizard(MACHINE_LANES);
  assert.equal(state.initGit, false);
  assert.equal(state.customizeModels, false);
  assert.equal(state.profileId, null);
  assert.equal(state.profileLanes, null);
  assert.equal(state.profileModified, false);
  assert.deepEqual(state.lanes, { supervisor: MACHINE_LANES.supervisor, lead: MACHINE_LANES.lead, worker: MACHINE_LANES.worker });
  assert.equal("step" in state, false, "Quick Start state no longer carries step");
  assert.equal("design" in state, false, "Quick Start state no longer carries design");
  assert.equal("directive" in state, false, "Quick Start state no longer carries directive");

  state = reduceWizard(state, { type: "initGit", value: true });
  state = reduceWizard(state, { type: "customizeModels" });
  assert.equal(state.customizeModels, true);
  state = reduceWizard(state, { type: "lane", lane: "lead", value: "claude/opus-4-8:high" });
  state = reduceWizard(state, { type: "customizeModels", value: false });
  assert.equal(state.customizeModels, false);
  state = reduceWizard(state, { type: "customizeModels", value: true });
  assert.equal(state.customizeModels, true);
  assert.equal(state.initGit, true);
  assert.equal(state.lanes.lead, "claude/opus-4-8:high");
});

test("canStartOnboarding requires a settled inspection, a usable repo (or Git init offered), and nothing live there", async () => {
  const { canStartOnboarding, blockerOf } = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  assert.equal(canStartOnboarding(null, false), false, "no inspection yet");
  assert.equal(canStartOnboarding(readyInspection, false), true);
  assert.equal(canStartOnboarding({ ...readyInspection, hasCommits: false }, false), true, "no commits is a warning, not a block");
  assert.equal(canStartOnboarding({ ...readyInspection, gitRepo: false, hasCommits: false }, false), false, "a non-Git folder needs the Owner to accept git init");
  assert.equal(canStartOnboarding({ ...readyInspection, gitRepo: false, hasCommits: false }, true), true);
  assert.equal(canStartOnboarding({ ...readyInspection, existingLead: true }, true), false, "an existing Lead stops onboarding");
  assert.equal(canStartOnboarding({ ...readyInspection, existingSupervisor: true }, true), false);
  assert.equal(canStartOnboarding({ ...readyInspection, missingPrerequisites: ["x"] }, false), true, "missing prerequisites never block Quick Start");
  assert.equal(blockerOf({ ...readyInspection, existingLead: true }), "lead-live");
  assert.equal(blockerOf({ ...readyInspection, existingSupervisor: true }), "supervisor-live");
  assert.equal(blockerOf(readyInspection), null);
});

test("the commit payload carries the folder, the three models — and initGit only when the folder is not a repo (with no UI directive or Open Design id)", async () => {
  const { initialWizard, reduceWizard, commitInputOf } = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  let state = initialWizard(MACHINE_LANES);
  state = reduceWizard(state, { type: "initGit", value: true });
  assert.deepEqual(commitInputOf(state, readyInspection, "/work/my-app"), {
    folder: "/work/my-app",
    models: { supervisor: "claude/opus-4-8", lead: "pi/zcode/glm-5.3", worker: "pi/zcode/glm-5.3" },
  }, "an existing repo never asks for git init");
  assert.equal(commitInputOf(state, { ...readyInspection, gitRepo: false, hasCommits: false }, "/work/my-app").initGit, true);
  const bare = commitInputOf(initialWizard(MACHINE_LANES), readyInspection, "/work/my-app");
  assert.equal("directive" in bare, false, "no directive is emitted by the UI");
  assert.equal("openDesignProjectId" in bare, false, "no openDesignProjectId is emitted by Quick Start");
  assert.equal("profileId" in bare, false, "no profile active, no profileId");
});

test("02-profiles: selecting a profile prefills seats and sets profileId, editing a seat marks modified, and machineDefaults clears it", async () => {
  const { initialWizard, reduceWizard, commitInputOf } = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  const fastProfile = {
    id: "fast",
    lanes: { supervisor: "claude/sonnet-4-6", lead: "pi/zcode/glm-5.3:low", worker: "pi/zcode/glm-5.3:off" },
  };
  let state = initialWizard(MACHINE_LANES);
  assert.equal(state.profileId, null);
  assert.equal(state.profileModified, false);

  state = reduceWizard(state, { type: "profile", profile: fastProfile });
  assert.equal(state.profileId, "fast");
  assert.equal(state.profileModified, false);
  assert.deepEqual(state.lanes, fastProfile.lanes);
  assert.deepEqual(commitInputOf(state, readyInspection, "/work/my-app"), {
    folder: "/work/my-app",
    profileId: "fast",
    models: fastProfile.lanes,
  });

  // Toggling Customize models preserves profileId and profileModified.
  state = reduceWizard(state, { type: "customizeModels", value: true });
  state = reduceWizard(state, { type: "lane", lane: "lead", value: "claude/opus-4-8:high" });
  assert.equal(state.profileId, "fast");
  assert.equal(state.profileModified, true);
  assert.equal(state.lanes.lead, "claude/opus-4-8:high");
  state = reduceWizard(state, { type: "customizeModels", value: false });
  assert.equal(state.profileId, "fast");
  assert.equal(state.profileModified, true);
  assert.equal(commitInputOf(state, readyInspection, "/work/my-app").profileId, "fast");
  assert.equal(commitInputOf(state, readyInspection, "/work/my-app").models?.lead, "claude/opus-4-8:high");

  // Editing another seat and reverting one keeps modified=true until ALL seats match the profile again.
  state = reduceWizard(state, { type: "lane", lane: "worker", value: "codex/gpt-5.4:medium" });
  assert.equal(state.profileModified, true);
  state = reduceWizard(state, { type: "lane", lane: "lead", value: fastProfile.lanes.lead });
  assert.equal(state.profileModified, true, "worker still diverges from profile");
  state = reduceWizard(state, { type: "lane", lane: "worker", value: fastProfile.lanes.worker });
  assert.equal(state.profileModified, false, "reverting every edited seat back to profile lanes clears profileModified");

  // Re-selecting the same or another profile clears modified.
  state = reduceWizard(state, { type: "profile", profile: fastProfile });
  assert.equal(state.profileId, "fast");
  assert.equal(state.profileModified, false);
  assert.deepEqual(state.lanes, fastProfile.lanes);

  // Editing a seat with the exact same value does not mark modified.
  state = reduceWizard(state, { type: "lane", lane: "lead", value: fastProfile.lanes.lead });
  assert.equal(state.profileModified, false);

  // Reverting to machine defaults clears profileId and profileModified and restores machineLanes.
  state = reduceWizard(state, { type: "machineDefaults", machineLanes: MACHINE_LANES });
  assert.equal(state.profileId, null);
  assert.equal(state.profileModified, false);
  assert.deepEqual(state.lanes, { supervisor: MACHINE_LANES.supervisor, lead: MACHINE_LANES.lead, worker: MACHINE_LANES.worker });
  assert.equal("profileId" in commitInputOf(state, readyInspection, "/work/my-app"), false);
});

test("describeThrown distinguishes RPC timeouts, unreachable server errors, and generic handler errors honestly", async () => {
  const { describeThrown } = await loadClientModule("plugin/client/factory/onboarding-state.ts");

  // Timeouts -> honest Paseo-busy timeout message advising to check status or retry.
  for (const msg of ["Plugin RPC timed out after 30000ms", "Request timeout waiting for daemon", "connect ETIMEDOUT 127.0.0.1:4100"]) {
    const out = describeThrown(new Error(msg));
    assert.match(out, /timed out/i, `timeout classification for: ${msg}`);
    assert.match(out, /busy|check status|retry/i, `advises check status or retry for: ${msg}`);
    assert.doesNotMatch(out, /Could not reach the Factory server/i, `must not misclassify timeout as unreachable: ${msg}`);
  }

  // Real connection/socket errors -> Factory server unreachable.
  for (const msg of ["connect ECONNREFUSED 127.0.0.1:4100", "socket hang up", "WebSocket closed before response", "fetch failed: network error", "ENOTFOUND localhost", "client not connected"]) {
    const out = describeThrown(new Error(msg));
    assert.match(out, /Could not reach the Factory server/i, `connection classification for: ${msg}`);
    assert.match(out, /check that Paseo is running/i, `advises checking Paseo for: ${msg}`);
  }

  // Other runtime/handler errors -> clean underlying reason without blaming Paseo being down.
  const generic = describeThrown(new Error("ENOENT: no such directory /tmp/missing"));
  assert.match(generic, /ENOENT: no such directory \/tmp\/missing/);
  assert.doesNotMatch(generic, /Could not reach the Factory server/i);
  assert.doesNotMatch(generic, /timed out/i);
});

// ---- Quick Start single-screen view, as an Owner sees it --------------------------------------

test("Quick Start renders single-screen folder, Lane profile, collapsed Customize models…, and Start Supervisor without Step 1–4 or Open Design", async () => {
  const html = await render({ inspection: readyInspection });
  assert.ok(hasHook(html, "factory-onboarding"));
  assert.ok(hasHook(html, "factory-quickstart"));
  assert.ok(hasHook(html, "factory-quickstart-folder"));
  assert.match(html, /\/work\/my-app/);
  assert.match(html, /Git repository/);
  assert.ok(hasHook(html, "factory-onboarding-profiles"));
  assert.ok(hasHook(html, "factory-quickstart-customize-models"));
  assert.ok(hasHook(html, "factory-quickstart-start"));
  assert.equal(isDisabled(html, "factory-quickstart-start"), false);
  assert.match(html, /sets up the Project and opens the Supervisor conversation directly/i);
  assert.doesNotMatch(html, /<input/, "the folder is the workspace's — no pasted path box");
  assert.doesNotMatch(html, /Browse|Choose folder|Paste/i);

  // Zero 4-step / Step 2 / Open Design / legacy start / directive hooks.
  assert.doesNotMatch(html, /Step \d+ of 4/i);
  assert.doesNotMatch(html, /First directive/i);
  for (const absent of [
    "factory-onboarding-progress",
    "factory-onboarding-steps",
    "factory-onboarding-step-pill-1",
    "factory-onboarding-back",
    "factory-onboarding-next",
    "factory-onboarding-step-prerequisites",
    "factory-onboarding-install-all",
    "factory-onboarding-od",
    "factory-onboarding-od-choose",
    "factory-onboarding-summary",
    "factory-onboarding-directive",
    "factory-onboarding-start",
    "factory-quickstart-models",
    "factory-onboarding-lane-supervisor",
  ]) {
    assert.equal(hasHook(html, absent), false, `${absent} must be absent on initial Quick Start`);
  }

  // Disabled until folder inspection completes.
  const pendingHtml = await render({});
  assert.ok(isDisabled(pendingHtml, "factory-quickstart-start"), "Start Supervisor stays disabled while inspection is null");
});

test("Quick Start: a folder that is not a Git repo offers to initialise one and disables Start Supervisor until the Owner agrees; no commits is only a warning", async () => {
  const plain = { ...readyInspection, gitRepo: false, hasCommits: false };
  const before = await render({ inspection: plain });
  assert.ok(hasHook(before, "factory-onboarding-init-git"));
  assert.match(before, /not a Git repository/i);
  assert.ok(isDisabled(before, "factory-quickstart-start"), "Start Supervisor waits for the Owner's yes");
  const agreed = await render({ inspection: plain, initGit: true });
  assert.equal(isDisabled(agreed, "factory-quickstart-start"), false);
  assert.match(agreed, /will be initialised/i);

  const unborn = await render({ inspection: { ...readyInspection, hasCommits: false } });
  assert.match(unborn, /No commits yet/);
  assert.equal(isDisabled(unborn, "factory-quickstart-start"), false);
});

test("Quick Start: a folder that already has a Lead or Supervisor stops onboarding — Start Supervisor is disabled, Re-check is available", async () => {
  const html = await render({ inspection: { ...readyInspection, existingLead: true } });
  assert.match(html, /A Lead is already running in this folder/);
  assert.ok(hasHook(html, "factory-onboarding-blocked"));
  assert.ok(isDisabled(html, "factory-quickstart-start"));
  assert.ok(hasHook(html, "factory-onboarding-recheck"));
  const sup = await render({ inspection: { ...readyInspection, existingSupervisor: true } });
  assert.match(sup, /A Supervisor is already live in this folder/);
  assert.ok(isDisabled(sup, "factory-quickstart-start"));
});

test("Quick Start: a failed inspection names the failure and offers Retry — never a spinner with nothing behind it", async () => {
  const html = await render({ inspectError: "cannot read the daemon's agents — check that Paseo is running" });
  assert.ok(hasHook(html, "factory-onboarding-error"));
  assert.match(html, /check that Paseo is running/);
  assert.ok(hasHook(html, "factory-onboarding-retry"));
  assert.ok(isDisabled(html, "factory-quickstart-start"));
});

test("Quick Start omits Step 2 Prerequisites and Open Design even when prerequisites are missing", async () => {
  const lacking = {
    ...readyInspection,
    prerequisites: [ready("a", "Core skills"), missing("b", "Expo skills", "Missing core skills: x")],
    missingPrerequisites: ["Expo skills"],
  };
  const html = await render({ inspection: lacking });
  assert.equal(hasHook(html, "factory-onboarding-step-prerequisites"), false);
  assert.equal(hasHook(html, "factory-onboarding-install-all"), false);
  assert.equal(hasHook(html, "factory-onboarding-od"), false);
  assert.doesNotMatch(html, /Install all|Open Design/i);
  assert.equal(isDisabled(html, "factory-quickstart-start"), false, "missing prerequisites never block Quick Start");
});

test("Quick Start collapses model lanes by default and reveals Supervisor, Lead, and Worker pickers when Customize models… is expanded", async () => {
  const collapsed = await render({ inspection: readyInspection });
  assert.ok(hasHook(collapsed, "factory-quickstart-customize-models"));
  assert.equal(hasHook(collapsed, "factory-quickstart-models"), false);
  for (const lane of ["supervisor", "lead", "worker", "watch"]) {
    assert.equal(hasHook(collapsed, `factory-onboarding-lane-${lane}`), false, `${lane} hidden while collapsed`);
  }

  const expanded = await render({ inspection: readyInspection, customizeModels: true });
  assert.ok(hasHook(expanded, "factory-quickstart-models"));
  for (const lane of ["supervisor", "lead", "worker"]) {
    assert.ok(hasHook(expanded, `factory-onboarding-lane-${lane}`), `${lane} row`);
    assert.ok(hasHook(expanded, `factory-onboarding-lane-change-${lane}`), `${lane} Change`);
  }
  assert.match(expanded, /claude\/opus-4-8/);
  assert.match(expanded, /pi\/zcode\/glm-5\.3/);
  assert.match(expanded, /machine defaults/i);
  assert.equal(hasHook(expanded, "factory-onboarding-lane-watch"), false, "only the three seats the Project starts on");
  assert.match(
    await render({ inspection: readyInspection, customizeModels: true, lanes: { ...MACHINE_LANES, lead: "claude/opus-4-8:high" } }),
    /claude\/opus-4-8:high/,
    "a changed model shows",
  );
});

test("a failed Start says what went wrong and how to fix it, and Start Supervisor stays available to retry", async () => {
  const html = await render({ inspection: readyInspection, startError: "Could not start Supervisor — check provider credentials, then Start again" });
  assert.ok(hasHook(html, "factory-onboarding-error"));
  assert.match(html, /Could not start Supervisor/);
  assert.match(html, /then Start again/);
  assert.ok(hasHook(html, "factory-quickstart-start"));
  assert.equal(isDisabled(html, "factory-quickstart-start"), false);
});

test("Quick Start checklist renders applicable-only phases with FACTORY_PALETTE status colours, elapsed seconds, >= 10s calm reassurance note, poll warning, and disabled controls without Cancel", async () => {
  const t0 = Date.parse("2026-11-20T12:00:00.000Z");

  // Minimal config (existing Git repo): omits init-git and open-design.
  const minimalRun = {
    runId: "run-1",
    folder: "/work/my-app",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:12.000Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.050Z", error: null },
      { id: "register-and-lanes", label: "Registering Project & saving model lanes", status: "done", startedAt: "2026-11-20T12:00:00.050Z", finishedAt: "2026-11-20T12:00:01.000Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: "2026-11-20T12:00:01.000Z", finishedAt: null, error: null },
    ],
  };

  // At 5s elapsed: elapsed counter shows 4s, no slow-note yet.
  const under10s = await render({ inspection: readyInspection, run: minimalRun, now: t0 + 5_000 });
  assert.ok(hasHook(under10s, "factory-onboarding-run-checklist"));
  assert.ok(hasHook(under10s, "factory-onboarding-phase-checking"));
  assert.equal(hasHook(under10s, "factory-onboarding-phase-init-git"), false, "init-git omitted when not needed");
  assert.ok(hasHook(under10s, "factory-onboarding-phase-register-and-lanes"));
  assert.equal(hasHook(under10s, "factory-onboarding-phase-open-design"), false, "open-design omitted when not linked");
  assert.ok(hasHook(under10s, "factory-onboarding-phase-start-supervisor"));
  assert.ok(hasHook(under10s, "factory-onboarding-phase-open-workspace"), "client open-workspace phase appended");
  assert.match(elementOf(under10s, "factory-onboarding-phase-start-supervisor"), /4s/);
  assert.equal(hasHook(under10s, "factory-onboarding-slow-note"), false, "no slow note under 10s");
  assert.ok(isDisabled(under10s, "factory-quickstart-start"), "Start disabled while running");
  assert.ok(isDisabled(under10s, "factory-quickstart-customize-models"), "Customize models disabled while running");
  assert.ok(isDisabled(under10s, "factory-onboarding-profile-machine-defaults"), "Profile pills disabled while running");
  assert.equal(hasHook(under10s, "factory-onboarding-cancel"), false, "no Cancel button");
  assert.doesNotMatch(under10s, />Cancel</i, "no Cancel button label");

  // Status badge colours from FACTORY_PALETTE (light theme).
  assert.ok(elementOf(under10s, "factory-onboarding-phase-status-checking").includes("#337e58"), "done uses palette.ok");
  assert.ok(elementOf(under10s, "factory-onboarding-phase-status-start-supervisor").includes("#2f7899"), "running uses palette.lead");
  assert.ok(elementOf(under10s, "factory-onboarding-phase-status-open-workspace").includes("#677176"), "pending uses palette.idle");

  // At >= 10s elapsed (12s into start-supervisor) + pollWarning: renders calm neutral slow note and poll warning.
  const over10s = await render({
    inspection: readyInspection,
    run: minimalRun,
    now: t0 + 13_000,
    pollWarning: "Temporary connection hiccup checking status — still retrying…",
  });
  assert.match(elementOf(over10s, "factory-onboarding-phase-start-supervisor"), /12s/);
  assert.ok(hasHook(over10s, "factory-onboarding-slow-note"), "calm reassurance note renders at >= 10s");
  assert.doesNotMatch(over10s.slice(over10s.indexOf("factory-onboarding-slow-note") - 120, over10s.indexOf("factory-onboarding-slow-note") + 200), /#c8253d|#fe5462/, "slow note is neutral, never styled as error");
  assert.ok(hasHook(over10s, "factory-onboarding-poll-warning"));
  assert.match(over10s, /Temporary connection hiccup/);

  // Partial failure retains done/failed phases, exact error, and Retry.
  const failedRun = {
    runId: "run-2",
    folder: "/work/my-app",
    status: "failed",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:05.000Z",
    result: null,
    error: "Provider quota exceeded — check provider billing, then press Retry",
    errorCode: "supervisor-start-failed",
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.050Z", error: null },
      { id: "init-git", label: "Initialising Git repository", status: "done", startedAt: "2026-11-20T12:00:00.050Z", finishedAt: "2026-11-20T12:00:01.000Z", error: null },
      { id: "register-and-lanes", label: "Registering Project & saving model lanes", status: "done", startedAt: "2026-11-20T12:00:01.000Z", finishedAt: "2026-11-20T12:00:01.500Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "failed", startedAt: "2026-11-20T12:00:02.000Z", finishedAt: "2026-11-20T12:00:05.000Z", error: "Provider quota exceeded — check provider billing, then press Retry" },
    ],
  };
  const failedHtml = await render({ inspection: readyInspection, run: failedRun });
  for (const id of ["checking", "init-git", "register-and-lanes", "start-supervisor", "open-workspace"]) {
    assert.ok(hasHook(failedHtml, `factory-onboarding-phase-${id}`), `phase ${id} renders`);
  }
  assert.ok(elementOf(failedHtml, "factory-onboarding-phase-status-init-git").includes("#337e58"));
  assert.ok(elementOf(failedHtml, "factory-onboarding-phase-status-start-supervisor").includes("#c8253d"), "failed uses palette.bad");
  assert.match(elementOf(failedHtml, "factory-onboarding-phase-start-supervisor"), /Provider quota exceeded/);
  assert.ok(hasHook(failedHtml, "factory-onboarding-error"));
  assert.match(elementOf(failedHtml, "factory-onboarding-error"), /Provider quota exceeded/);
  assert.ok(hasHook(failedHtml, "factory-onboarding-run-retry"));
  assert.equal(isDisabled(failedHtml, "factory-onboarding-run-retry"), false);

  // Unchecking initGit after a server failure disables Retry when folder is not a Git repo.
  const failedNonGit = await render({ inspection: { ...readyInspection, gitRepo: false, hasCommits: false }, initGit: false, run: failedRun });
  assert.ok(isDisabled(failedNonGit, "factory-onboarding-run-retry"), "Retry disabled if folder cannot start");
});

test("01-badges: OnboardingWizard applies FACTORY_PALETTE to Quick Start readiness badges, profile pills, expanded seat/thinking pills, and checklist statuses in light & dark", async () => {
  const darkTheme = { colors: { ...theme.colors, surface0: "#000000" } };

  // Expanded Quick Start seat colours & thinking pills across light/dark.
  const qsLight = await render({ customizeModels: true, inspection: readyInspection, lanes: { ...MACHINE_LANES, lead: "claude/opus-4-8:high" } });
  assert.ok(elementOf(qsLight, "factory-onboarding-profile-machine-defaults").includes("#2f7899"), "active Machine defaults uses palette.lead");
  assert.ok(elementOf(qsLight, "factory-onboarding-lane-supervisor").includes("#7459b4"), "Supervisor seat colour");
  assert.ok(elementOf(qsLight, "factory-onboarding-lane-lead").includes("#2f7899"), "Lead seat colour");
  assert.ok(elementOf(qsLight, "factory-onboarding-lane-worker").includes("#287a81"), "Worker uses peer seat colour");
  assert.match(elementOf(qsLight, "factory-onboarding-lane-worker"), />Worker</);
  assert.ok(elementOf(qsLight, "factory-onboarding-lane-thinking-lead").includes("#b23a98"), "high thinking pill uses thinking ramp");
  assert.match(elementOf(qsLight, "factory-onboarding-lane-thinking-lead"), />high</);

  const qsDark = await render(
    { customizeModels: true, inspection: readyInspection, lanes: { ...MACHINE_LANES, lead: "claude/opus-4-8:high" } },
    { theme: darkTheme },
  );
  assert.ok(elementOf(qsDark, "factory-onboarding-profile-machine-defaults").includes("#5fa8cc"), "dark active Machine defaults uses palette.lead");
  assert.ok(elementOf(qsDark, "factory-onboarding-lane-supervisor").includes("#a798d7"), "dark Supervisor seat colour");
  assert.ok(elementOf(qsDark, "factory-onboarding-lane-lead").includes("#5fa8cc"), "dark Lead seat colour");
  assert.ok(elementOf(qsDark, "factory-onboarding-lane-worker").includes("#5db3ba"), "dark Worker uses peer seat colour");
  assert.ok(elementOf(qsDark, "factory-onboarding-lane-thinking-lead").includes("#de54c1"), "dark high thinking pill uses thinking ramp");

  // Readiness status badges: ok, wait, bad (light & dark).
  assert.ok(elementOf(qsLight, "factory-onboarding-git-badge").includes("#337e5818"), "Git ready uses ok badge");
  assert.ok(elementOf(qsDark, "factory-onboarding-git-badge").includes("#68b78d18"), "dark Git ready uses ok badge");
  const qsWaitLight = await render({ inspection: { ...readyInspection, gitRepo: false, hasCommits: false } });
  const qsWaitDark = await render({ inspection: { ...readyInspection, gitRepo: false, hasCommits: false } }, { theme: darkTheme });
  assert.ok(elementOf(qsWaitLight, "factory-onboarding-git-badge").includes("#8f680218"), "non-Git uses wait badge");
  assert.ok(elementOf(qsWaitDark, "factory-onboarding-git-badge").includes("#cd9a2218"), "dark non-Git uses wait badge");
  const qsBadLight = await render({ inspection: { ...readyInspection, existingLead: true } });
  const qsBadDark = await render({ inspection: { ...readyInspection, existingLead: true } }, { theme: darkTheme });
  assert.ok(elementOf(qsBadLight, "factory-onboarding-blocker-badge").includes("#c8253d18"), "blocker uses bad badge");
  assert.ok(elementOf(qsBadDark, "factory-onboarding-blocker-badge").includes("#fe546218"), "dark blocker uses bad badge");

  // Checklist phase status badges in dark mode.
  const darkRunHtml = await render(
    {
      inspection: readyInspection,
      run: {
        runId: "run-dark",
        folder: "/work/my-app",
        status: "failed",
        startedAt: "2026-11-20T12:00:00.000Z",
        updatedAt: "2026-11-20T12:00:05.000Z",
        result: null,
        error: "boom",
        errorCode: "supervisor-start-failed",
        phases: [
          { id: "checking", label: "Checking", status: "done", startedAt: null, finishedAt: null, error: null },
          { id: "start-supervisor", label: "Starting Supervisor", status: "failed", startedAt: null, finishedAt: null, error: "boom" },
        ],
      },
    },
    { theme: darkTheme },
  );
  assert.ok(elementOf(darkRunHtml, "factory-onboarding-phase-status-checking").includes("#68b78d"), "dark done uses palette.ok");
  assert.ok(elementOf(darkRunHtml, "factory-onboarding-phase-status-start-supervisor").includes("#fe5462"), "dark failed uses palette.bad");
  assert.ok(elementOf(darkRunHtml, "factory-onboarding-phase-status-open-workspace").includes("#6c767b"), "dark pending uses palette.idle");
});

const SAMPLE_PROFILES = [
  {
    id: "fast",
    name: "Fast",
    description: "Quick turnaround models",
    lanes: {
      supervisor: "claude/sonnet-4-6",
      lead: "pi/zcode/glm-5.3:low",
      worker: "pi/zcode/glm-5.3:off",
      watch: "claude/haiku-4-5",
      freshEyes: "claude/sonnet-4-6",
    },
    updatedAt: "2026-11-18T00:00:00.000Z",
  },
  {
    id: "quality",
    name: "Quality",
    description: null,
    lanes: {
      supervisor: "claude/opus-4-8:high",
      lead: "claude/opus-4-8:high",
      worker: "claude/sonnet-4-6:medium",
      watch: "claude/haiku-4-5",
      freshEyes: "claude/opus-4-8",
    },
    updatedAt: "2026-11-18T00:00:00.000Z",
  },
];

test("02-profiles: Quick Start always renders Lane profile pills + Machine defaults (even when profiles.length === 0), highlights active selection with FACTORY_PALETTE, and shows modified badge when a seat diverges", async () => {
  // Empty profiles: Lane profile box still renders cleanly with active Machine defaults and Customize models… toggle.
  const emptyProfilesHtml = await render({ inspection: readyInspection }, { view: { ...view, profiles: [] } });
  assert.ok(hasHook(emptyProfilesHtml, "factory-onboarding-profiles"));
  assert.match(emptyProfilesHtml, /Lane profile/);
  assert.ok(hasHook(emptyProfilesHtml, "factory-onboarding-profile-machine-defaults"));
  assert.match(elementOf(emptyProfilesHtml, "factory-onboarding-profile-machine-defaults"), /data-selected="true"/);
  assert.ok(hasHook(emptyProfilesHtml, "factory-quickstart-customize-models"));

  const profileView = { ...view, profiles: SAMPLE_PROFILES };

  // Default state: Machine defaults is selected, Customize models is collapsed.
  const defaultHtml = await render({ inspection: readyInspection }, { view: profileView });
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profiles"));
  assert.match(defaultHtml, /Lane profile/);
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profile-machine-defaults"));
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profile-fast"));
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profile-quality"));
  assert.match(elementOf(defaultHtml, "factory-onboarding-profile-machine-defaults"), /data-selected="true"/);
  assert.ok(elementOf(defaultHtml, "factory-onboarding-profile-machine-defaults").includes("#2f7899"), "active selection uses palette.lead");
  assert.match(elementOf(defaultHtml, "factory-onboarding-profile-fast"), /data-selected="false"/);
  assert.equal(hasHook(defaultHtml, "factory-onboarding-profile-modified"), false);
  assert.equal(hasHook(defaultHtml, "factory-onboarding-lane-supervisor"), false);

  // Selected profile state with Customize models expanded: prefills profile seats and does not mark them changed.
  const selectedHtml = await render({ customizeModels: true, inspection: readyInspection, profileId: "fast" }, { view: profileView });
  assert.match(elementOf(selectedHtml, "factory-onboarding-profile-fast"), /data-selected="true"/);
  assert.ok(elementOf(selectedHtml, "factory-onboarding-profile-fast").includes("#2f7899"), "active profile uses palette.lead");
  assert.match(elementOf(selectedHtml, "factory-onboarding-profile-machine-defaults"), /data-selected="false"/);
  assert.match(elementOf(selectedHtml, "factory-onboarding-lane-supervisor"), /claude\/sonnet-4-6/);
  assert.match(elementOf(selectedHtml, "factory-onboarding-lane-lead"), /pi\/zcode\/glm-5\.3:low/);
  assert.equal(hasHook(selectedHtml, "factory-onboarding-lane-changed-supervisor"), false);
  assert.equal(hasHook(selectedHtml, "factory-onboarding-lane-changed-lead"), false);
  assert.equal(hasHook(selectedHtml, "factory-onboarding-profile-modified"), false);

  // Modified profile state: a diverged seat shows changed and the profile shows modified with palette.wait.
  const modifiedHtml = await render(
    {
      customizeModels: true,
      inspection: readyInspection,
      profileId: "fast",
      profileModified: true,
      lanes: { ...SAMPLE_PROFILES[0]!.lanes, lead: "claude/opus-4-8:high" },
    },
    { view: profileView },
  );
  assert.ok(hasHook(modifiedHtml, "factory-onboarding-profile-modified"));
  assert.ok(elementOf(modifiedHtml, "factory-onboarding-profile-modified").includes("#8f680218"), "modified badge uses palette.wait");
  assert.ok(hasHook(modifiedHtml, "factory-onboarding-lane-changed-lead"));
  assert.equal(hasHook(modifiedHtml, "factory-onboarding-lane-changed-supervisor"), false);

  const darkTheme = { colors: { ...theme.colors, surface0: "#000000" } };
  const darkModifiedHtml = await render(
    {
      customizeModels: true,
      inspection: readyInspection,
      profileId: "fast",
      profileModified: true,
      lanes: { ...SAMPLE_PROFILES[0]!.lanes, lead: "claude/opus-4-8:high" },
    },
    { theme: darkTheme, view: profileView },
  );
  assert.ok(elementOf(darkModifiedHtml, "factory-onboarding-profile-fast").includes("#5fa8cc"), "dark active profile uses palette.lead");
  assert.ok(elementOf(darkModifiedHtml, "factory-onboarding-profile-modified").includes("#cd9a2218"), "dark modified badge uses palette.wait");
});

test("02-profiles: toggling Customize models…, clicking a profile pill, reverting to Machine defaults, and Start Supervisor submits profileId", async () => {
  const { OnboardingWizard } = await loadInteractiveWizard();
  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const started: unknown[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          theme,
          view: { ...view, profiles: SAMPLE_PROFILES },
          folder: "/work/my-app",
          actions: {
            ...noopActions,
            start: async (input: unknown) => {
              started.push(input);
              return { ok: true as const };
            },
          },
          initialUi: { inspection: readyInspection },
        }),
      );
    });
    const click = async (testId: string) => {
      const el = dom.window.document.querySelector(`[data-testid="${testId}"]`);
      assert.ok(el, `missing ${testId}`);
      await act(async () => {
        el.click();
      });
    };

    // Collapsed by default -> expand Customize models….
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-supervisor"]'), null);
    await click("factory-quickstart-customize-models");
    assert.ok(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-supervisor"]'));

    await click("factory-onboarding-profile-fast");
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-fast"]')?.getAttribute("data-selected"), "true");
    assert.match(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-supervisor"]')?.textContent ?? "", /claude\/sonnet-4-6/);

    await click("factory-onboarding-profile-machine-defaults");
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-machine-defaults"]')?.getAttribute("data-selected"), "true");
    assert.match(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-supervisor"]')?.textContent ?? "", /claude\/opus-4-8/);

    await click("factory-onboarding-profile-fast");

    // Edit Lead thinking to High -> inline modified badge appears.
    await click("factory-onboarding-lane-change-lead");
    const buttonNamed = (label: string): HTMLButtonElement | undefined =>
      (Array.from(dom.window.document.querySelectorAll("button")) as HTMLButtonElement[]).find((b) => b.textContent?.trim() === label);
    const highBtn = buttonNamed("High");
    assert.ok(highBtn, "High thinking chip renders");
    await act(async () => { highBtn.click(); });
    const saveBtn = buttonNamed("Save lane");
    assert.ok(saveBtn, "Save lane button renders");
    await act(async () => { saveBtn.click(); });
    assert.ok(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-modified"]'), "modified badge renders after seat edit");

    // Collapse & re-expand Customize models… -> edited lane and modified badge stay intact.
    await click("factory-quickstart-customize-models");
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-lead"]'), null);
    assert.ok(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-modified"]'));
    await click("factory-quickstart-customize-models");
    assert.match(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-lead"]')?.textContent ?? "", /pi\/zcode\/glm-5\.3:high/);

    // Revert Lead back to Low -> modified badge clears.
    await click("factory-onboarding-lane-change-lead");
    const lowBtn = buttonNamed("Low");
    assert.ok(lowBtn, "Low thinking chip renders");
    await act(async () => { lowBtn.click(); });
    const saveBtn2 = buttonNamed("Save lane");
    assert.ok(saveBtn2, "Save lane button renders");
    await act(async () => { saveBtn2.click(); });
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-modified"]'), null, "modified badge clears when seat reverts to profile lane");

    await click("factory-quickstart-start");
    assert.equal(started.length, 1);
    assert.deepEqual(started[0], {
      folder: "/work/my-app",
      profileId: "fast",
      models: {
        supervisor: "claude/sonnet-4-6",
        lead: "pi/zcode/glm-5.3:low",
        worker: "pi/zcode/glm-5.3:off",
      },
    });
    await act(async () => {
      root.unmount();
    });
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("Quick Start async run polls status, tolerates transient poll errors, supports client-only open-workspace Retry, and applies post-failure edits on server-failure Retry", async () => {
  const { OnboardingWizard } = await loadInteractiveWizard();
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const basePhases = [
    { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.050Z", error: null },
    { id: "register-and-lanes", label: "Registering Project & saving model lanes", status: "done", startedAt: "2026-11-20T12:00:00.050Z", finishedAt: "2026-11-20T12:00:00.200Z", error: null },
  ];
  const runningRun = {
    runId: "run-live-1",
    folder: "/work/my-app",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:00.200Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      ...basePhases,
      { id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: "2026-11-20T12:00:00.200Z", finishedAt: null, error: null },
    ],
  };
  const succeededRun = {
    ...runningRun,
    status: "succeeded",
    updatedAt: "2026-11-20T12:00:01.000Z",
    result: { agentId: "sup-1", projectRoot: "/work/my-app", slug: "my-app", bootstrapped: false, summary: "Started Supervisor" },
    phases: [
      ...basePhases,
      { id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: "2026-11-20T12:00:00.200Z", finishedAt: "2026-11-20T12:00:01.000Z", error: null },
    ],
  };

  let startCalls = 0;
  let statusCalls = 0;
  let finalizeCalls = 0;
  let finalizeShouldFail = true;
  let releaseFourthPoll: (() => void) | null = null;
  const fourthPollGate = new Promise<void>((resolve) => {
    releaseFourthPoll = resolve;
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    // 1. Client-only open-workspace failure + transient poll error resilience + Retry only calls finalize.
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          theme,
          view,
          folder: "/work/my-app",
          initialUi: { inspection: readyInspection, pollIntervalMs: 10 },
          actions: {
            ...noopActions,
            start: async () => {
              startCalls += 1;
              return { ok: true as const, run: runningRun };
            },
            status: async () => {
              statusCalls += 1;
              if (statusCalls <= 2) throw new Error("Plugin RPC timed out");
              if (statusCalls === 3) return { ok: false as const, error: "transient blip" };
              await fourthPollGate;
              return { ok: true as const, run: succeededRun };
            },
            finalize: async () => {
              finalizeCalls += 1;
              if (finalizeShouldFail) return { ok: false as const, error: "Workspace creation failed: disk busy" };
              return { ok: true as const };
            },
          },
        }),
      );
    });

    await act(async () => {
      q("factory-quickstart-start")!.click();
    });
    assert.equal(startCalls, 1);
    assert.ok(q("factory-onboarding-run-checklist"), "checklist renders immediately on async start");
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, true);
    assert.equal((q("factory-quickstart-customize-models") as HTMLButtonElement).disabled, true);
    assert.equal(q("factory-onboarding-cancel"), null);

    // Wait for 2nd transient poll failure (still silent) and 3rd (shows poll warning).
    for (let i = 0; i < 20 && statusCalls < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 8));
      });
    }
    assert.ok(statusCalls >= 2);
    if (statusCalls === 2) {
      assert.equal(q("factory-onboarding-poll-warning"), null, "first 2 transient errors stay silent");
    }
    for (let i = 0; i < 20 && statusCalls < 3; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 8));
      });
    }
    assert.ok(statusCalls >= 3);
    assert.ok(q("factory-onboarding-poll-warning"), "3 consecutive transient poll errors show non-fatal warning");
    assert.equal(q("factory-onboarding-error"), null, "transient poll warning never marks checklist failed");

    // Release 4th poll (succeeded) -> clears poll warning and runs finalize (which fails).
    releaseFourthPoll!();
    for (let i = 0; i < 20 && finalizeCalls === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    assert.ok(statusCalls >= 4, `expected >= 4 status polls, got ${statusCalls}`);
    assert.equal(finalizeCalls, 1, "finalize ran once after server run succeeded");
    assert.equal(q("factory-onboarding-poll-warning"), null, "poll warning clears once status succeeds");
    assert.equal(q("factory-onboarding-phase-status-start-supervisor")?.textContent, "done");
    assert.equal(q("factory-onboarding-phase-status-open-workspace")?.textContent, "failed");
    assert.match(q("factory-onboarding-error")?.textContent ?? "", /Workspace creation failed: disk busy/);
    assert.ok(q("factory-onboarding-run-retry"), "Retry button renders on open-workspace failure");

    // Clicking Retry retries ONLY finalize, never re-calling actions.start.
    finalizeShouldFail = false;
    await act(async () => {
      q("factory-onboarding-run-retry")!.click();
    });
    assert.equal(startCalls, 1, "client-only retry never re-calls actions.start");
    assert.equal(finalizeCalls, 2, "client-only retry calls actions.finalize again");
    assert.equal(q("factory-onboarding-phase-status-open-workspace")?.textContent, "done");
    assert.equal(q("factory-onboarding-error"), null);

    // 2. Server failure retains checklist, and post-failure profile/model edits apply on Retry.
    const serverStartInputs: unknown[] = [];
    const failedServerRun = {
      ...runningRun,
      runId: "run-fail-1",
      folder: "/work/other-app",
      status: "failed",
      error: "Supervisor creation failed: invalid key",
      errorCode: "supervisor-start-failed",
      phases: [
        ...basePhases,
        { id: "start-supervisor", label: "Starting Supervisor", status: "failed", startedAt: "2026-11-20T12:00:00.200Z", finishedAt: "2026-11-20T12:00:01.000Z", error: "Supervisor creation failed: invalid key" },
      ],
    };
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          key: "other-app",
          theme,
          view: { ...view, profiles: SAMPLE_PROFILES },
          folder: "/work/other-app",
          initialUi: { inspection: { ...readyInspection, folder: "/work/other-app" } },
          actions: {
            ...noopActions,
            start: async (input: unknown) => {
              serverStartInputs.push(input);
              return { ok: true as const, run: failedServerRun };
            },
          },
        }),
      );
    });
    await act(async () => {
      q("factory-quickstart-start")!.click();
    });
    assert.equal(serverStartInputs.length, 1);
    assert.equal(q("factory-onboarding-phase-status-register-and-lanes")?.textContent, "done");
    assert.equal(q("factory-onboarding-phase-status-start-supervisor")?.textContent, "failed");
    assert.match(q("factory-onboarding-error")?.textContent ?? "", /Supervisor creation failed: invalid key/);

    // Switch profile after server failure -> Retry sends updated profileId and lanes.
    await act(async () => {
      q("factory-onboarding-profile-fast")!.click();
    });
    await act(async () => {
      q("factory-onboarding-run-retry")!.click();
    });
    assert.equal(serverStartInputs.length, 2, "Retry re-calls actions.start when server run failed");
    assert.deepEqual(serverStartInputs[1], {
      folder: "/work/other-app",
      profileId: "fast",
      models: {
        supervisor: "claude/sonnet-4-6",
        lead: "pi/zcode/glm-5.3:low",
        worker: "pi/zcode/glm-5.3:off",
      },
    });

    await act(async () => {
      root.unmount();
    });
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("Quick Start live elapsed timer ticks every second and reveals neutral >= 10s reassurance note", async (t) => {
  const { OnboardingWizard } = await loadInteractiveWizard();
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const baseNow = Date.parse("2026-11-20T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: baseNow });

  const runningRun = {
    runId: "run-timer-1",
    folder: "/work/my-app",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:00.000Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.000Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: null, error: null },
    ],
  };

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          theme,
          view,
          folder: "/work/my-app",
          initialUi: { inspection: readyInspection, run: runningRun },
          actions: noopActions,
        }),
      );
    });
    assert.equal(q("factory-onboarding-phase-elapsed-start-supervisor")?.textContent, "0s");
    assert.equal(q("factory-onboarding-slow-note"), null);

    await act(async () => {
      t.mock.timers.tick(3_000);
    });
    assert.equal(q("factory-onboarding-phase-elapsed-start-supervisor")?.textContent, "3s");
    assert.equal(q("factory-onboarding-slow-note"), null);

    await act(async () => {
      t.mock.timers.tick(7_000);
    });
    assert.equal(q("factory-onboarding-phase-elapsed-start-supervisor")?.textContent, "10s");
    assert.ok(q("factory-onboarding-slow-note"), "calm reassurance note appears at 10s");

    await act(async () => {
      root.unmount();
    });
  } finally {
    t.mock.timers.reset();
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("OnboardingWizard surfaces honest timeout vs connection error messages when inspect or start throws", async () => {
  const { OnboardingWizard } = await loadInteractiveWizard();
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    // 1. Inspect throws RPC timeout -> honest Paseo-busy timeout message.
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          theme,
          view,
          folder: "/work/timeout-app",
          actions: {
            ...noopActions,
            inspect: async () => {
              throw new Error("Plugin RPC timed out");
            },
          },
        }),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const inspectMsg = q("factory-onboarding-error")?.textContent ?? "";
    assert.match(inspectMsg, /Paseo was busy and the request timed out/i);
    assert.doesNotMatch(inspectMsg, /Could not reach the Factory server/i);

    // 2. Start throws ECONNREFUSED -> Factory server unreachable message.
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          key: "conn-app",
          theme,
          view,
          folder: "/work/conn-app",
          initialUi: { inspection: readyInspection },
          actions: {
            ...noopActions,
            start: async () => {
              throw new Error("connect ECONNREFUSED 127.0.0.1:4100");
            },
          },
        }),
      );
    });
    await act(async () => {
      q("factory-quickstart-start")!.click();
    });
    const startMsg = q("factory-onboarding-error")?.textContent ?? "";
    assert.match(startMsg, /Could not reach the Factory server/i);

    await act(async () => {
      root.unmount();
    });
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("OnboardingWizard automatically attaches to an in-flight running run for the canonical folder on Quick Start", async () => {
  const { OnboardingWizard } = await loadInteractiveWizard();
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const statusQueries: unknown[] = [];
  const finalizeCalls: unknown[] = [];
  let statusCallCount = 0;

  const runningRun = {
    runId: "run-reattach-1",
    folder: "/canonical/work/my-app",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:01.000Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.050Z", error: null },
      { id: "register-and-lanes", label: "Registering Project & saving model lanes", status: "done", startedAt: "2026-11-20T12:00:00.050Z", finishedAt: "2026-11-20T12:00:00.500Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: "2026-11-20T12:00:00.500Z", finishedAt: null, error: null },
    ],
  };
  const succeededRun = {
    ...runningRun,
    status: "succeeded",
    updatedAt: "2026-11-20T12:00:02.000Z",
    result: { agentId: "sup-reattach", projectRoot: "/canonical/work/my-app", slug: "my-app", bootstrapped: false, summary: "Reattached and ready" },
    phases: [
      runningRun.phases[0]!,
      runningRun.phases[1]!,
      { id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: "2026-11-20T12:00:00.500Z", finishedAt: "2026-11-20T12:00:02.000Z", error: null },
    ],
  };

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          theme,
          view,
          folder: "/work/my-app",
          initialUi: { pollIntervalMs: 10 },
          actions: {
            ...noopActions,
            inspect: async () => ({ ...readyInspection, folder: "/canonical/work/my-app" }),
            status: async (input: unknown) => {
              statusQueries.push(input);
              statusCallCount += 1;
              return { ok: true as const, run: statusCallCount === 1 ? runningRun : succeededRun };
            },
            finalize: async (result: unknown) => {
              finalizeCalls.push(result);
              return { ok: true as const };
            },
          },
        }),
      );
    });

    for (let i = 0; i < 20 && finalizeCalls.length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }

    assert.deepEqual(statusQueries[0], { folder: "/canonical/work/my-app" }, "queries status by canonical inspected folder");
    assert.ok(q("factory-quickstart"), "renders Quick Start view");
    assert.ok(q("factory-onboarding-run-checklist"), "checklist attaches immediately");
    assert.equal(finalizeCalls.length, 1, "reattached run completes through finalize");
    assert.equal(q("factory-onboarding-phase-status-open-workspace")?.textContent, "done");

    await act(async () => {
      root.unmount();
    });
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

// ---- panel integration + structural pins -----------------------------------------------------

const notAProject: PanelView = {
  handoffs: [], profile: { active: null, list: [], modified: false }, defaultWorker: null,
  isProject: false, name: null, summary: "Not a Factory Project yet", needsYou: [], seats: null, openDesign: null,
  onboarding: { folder: "/work/my-app", gitRepo: true, hasCommits: true, existingLead: false },
};

async function renderPanel(mobile: boolean): Promise<string> {
  const { ProjectPanel } = await loadClientModule("plugin/client/factory/project-panel.tsx");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const wizard = createElement("div", { "data-testid": "wizard-slot" }, "wizard");
  return renderToStaticMarkup(createElement(ProjectPanel, {
    theme, panel: notAProject, mobile, now: Date.now(), daemonError: null,
    actions: { openAgent() {}, installPrerequisites() {}, handoffStart() {}, handoffReplaceNow() {}, handoffCancel() {}, handoffRetry() {}, viewHandover() {}, startSupervisor() {}, busy: false },
    onboarding: wizard,
  }));
}

test("desktop mounts the wizard under 'Set up Factory for this folder'; mobile shows only the set-it-up-on-Desktop message", async () => {
  const desktop = await renderPanel(false);
  assert.ok(hasHook(desktop, "wizard-slot"), "the wizard replaces the old placeholder");
  assert.match(desktop, /Set up Factory for this folder/);
  assert.doesNotMatch(desktop, /New Chat/, "the placeholder that pointed at New Chat is gone");
  const mobile = await renderPanel(true);
  assert.equal(hasHook(mobile, "wizard-slot"), false, "the wizard never mounts on mobile");
  assert.match(mobile, /Set this Project up on Paseo Desktop/);
  assert.ok(hasHook(mobile, "factory-panel-onboarding"));
});

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

test("the shell builds the wizard on desktop only and drives it through onboardingInspect, onboardingStart, and onboardingStatus — and the old paste-path door is not bound", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /useRpc\(onboardingInspect\)/);
  assert.match(shell, /useRpc\(onboardingStart\)/);
  assert.match(shell, /useRpc\(onboardingStatus\)/);
  assert.doesNotMatch(shell, /useRpc\(onboardingCommit\)/);
  assert.doesNotMatch(shell, /openDesignCatalog/);
  assert.match(shell, /<OnboardingWizard/);
  assert.match(shell, /<OnboardingWizard[\s\S]*?\bkey=\{onboardingFolder\b/);
  assert.match(shell, /!mobile/, "the wizard is gated on the mobile flag");
  assert.match(shell, /navigation\?\.openAgent\(\{ agentId: result\.agentId/, "completing onboarding opens the Supervisor conversation directly");
  assert.doesNotMatch(shell, /projectAdd|pickFolder|projectPick/);
  const wizard = read("plugin/client/factory/onboarding-wizard.tsx");
  assert.doesNotMatch(wizard, /Start Lead|useRpc\((leadEnsure|leadDispatch)\)/, "the wizard starts the Supervisor and never a Lead");
  assert.match(wizard, /factory-quickstart/);
  assert.match(wizard, /factory-quickstart-customize-models/);
  assert.match(wizard, /factory-quickstart-start/);
  assert.doesNotMatch(wizard, /factory-onboarding-step-prerequisites|factory-onboarding-install-all|factory-onboarding-od\b|factory-onboarding-next|factory-onboarding-back/);
});

async function loadShellHarness(options: { withSubscription?: boolean } = {}): Promise<Record<string, any>> {
  const withSubscription = options.withSubscription ?? true;
  const entryContents = withSubscription
    ? `export { FactoryShell } from ${JSON.stringify(join(repoRoot, "plugin/client/factory/shell.tsx"))};\nexport { PluginRpcProvider } from "@getpaseo/plugin/client";`
    : `export { FactoryShell } from ${JSON.stringify(join(repoRoot, "plugin/client/factory/shell.tsx"))};`;
  const bundle = await build({
    stdin: {
      contents: entryContents,
      resolveDir: repoRoot,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "shell-test-adapter",
        setup(b) {
          b.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client\/ui)$/ }, (args) => ({ path: args.path, namespace: "rn-ui" }));
          b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, (args) => ({ path: args.path, namespace: "paseo-client" }));
          b.onLoad({ filter: /.*/, namespace: "rn-ui" }, () => ({
            loader: "js",
            contents: `
              const React = require("react");
              const tag = (name) => ({ children, onPress, disabled, testID, accessibilityRole, accessibilityState, accessibilityLabel }) =>
                React.createElement(name, {
                  disabled,
                  onClick: onPress,
                  "data-testid": testID,
                  "data-role": accessibilityRole,
                  "aria-label": accessibilityLabel,
                  "data-selected": accessibilityState && accessibilityState.selected !== undefined ? String(accessibilityState.selected) : undefined,
                }, typeof children === "function" ? children({ pressed: false }) : children);
              exports.View = tag("div");
              exports.ScrollView = tag("div");
              exports.Text = tag("span");
              exports.Pressable = tag("button");
              exports.Icon = () => null;
              exports.Loading = () => null;
              exports.DocumentFrame = ({ url }) => React.createElement("section", { "data-document-frame": url });
              exports.TextInput = ({ value, placeholder, testID, onChangeText }) =>
                React.createElement("input", {
                  value: value ?? "",
                  placeholder,
                  "data-testid": testID,
                  onChange: (e) => onChangeText && onChangeText(e.target.value),
                });
              const Modal = ({ children, open, title }) => (open ? React.createElement("div", { "data-modal-title": title }, children) : null);
              Modal.Content = tag("div");
              exports.Modal = Modal;
              exports.useToast = () => ({
                show(msg, opts) { globalThis.__shellTestToasts?.push({ msg, opts }); },
                error(msg) { globalThis.__shellTestToasts?.push({ msg, error: true }); },
              });
              exports.Platform = { OS: "web", select: (spec) => (spec.web !== undefined ? spec.web : spec.default) };
            `,
          }));
          b.onLoad({ filter: /.*/, namespace: "paseo-client" }, () => ({
            loader: "js",
            resolveDir: repoRoot,
            contents: withSubscription
              ? `
                export { PluginRpcProvider, useRpc, useSubscription } from ${JSON.stringify(
                  join(repoRoot, "node_modules/@getpaseo/plugin/dist/client/rpc-context.js"),
                )};
                export const useToast = () => ({
                  show(msg, opts) { globalThis.__shellTestToasts?.push({ msg, opts }); },
                  error(msg) { globalThis.__shellTestToasts?.push({ msg, error: true }); },
                });
                export const openExternalUrl = async () => {};
              `
              : `
                export const useRpc = (contract) => (input) => globalThis.__shellTestLegacyRpc(contract.name, input);
                export const useToast = () => ({
                  show(msg, opts) { globalThis.__shellTestToasts?.push({ msg, opts }); },
                  error(msg) { globalThis.__shellTestToasts?.push({ msg, error: true }); },
                });
                export const openExternalUrl = async () => {};
              `,
          }));
        },
      },
    ],
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), compiled, compiled.exports);
  return compiled.exports;
}

function makeShellOnboardingView(overrides: { isProject?: boolean; folder?: string; supervisorVacant?: boolean } = {}) {
  const folder = overrides.folder ?? "/work/my-app";
  const isProject = overrides.isProject ?? false;
  return {
    version: 5 as const,
    stateDir: "/tmp/state",
    generatedAt: new Date().toISOString(),
    lanes: MACHINE_LANES,
    machineLanes: MACHINE_LANES,
    hasProjectLaneOverride: false,
    providersLoading: false,
    providers: [{ provider: "claude", available: true, models: [{ id: "opus-4-8", label: "Opus", thinkingOptions: [] }] }],
    kpis: { running: 0, needsHuman: 0, readyToAccept: 0, accepted: 0, totalCostUsd: 0, totalTokens: 0 },
    agents: [],
    supervisor: null,
    lead: null,
    project: isProject ? { root: folder, slug: "my-app", missingRoot: false } : null,
    companionTools: [],
    companions: [],
    corePlugin: {
      id: "paseo-factory",
      title: "Paseo Factory",
      tagline: "Verification core",
      description: "Verification core",
      status: "running" as const,
      enabled: true,
      installKind: "git" as const,
      installedSource: "git:daymanondev/paseo-factory:plugin",
      canonicalSource: "git:daymanondev/paseo-factory:plugin",
      currentRevision: "rev-1",
      version: "0.16.2",
      latestRevision: "rev-1",
      commitsBehind: 0,
      updateAvailable: false,
      error: null,
      capabilities: [],
      access: "public" as const,
      sidebarIcon: "flame",
      sidebarLabel: "Factory",
    },
    pluginsCheckedAt: new Date().toISOString(),
    vault: {
      configured: false, repo: null, branch: "main", nodeId: "n1", hasPassphrase: false, cloneExists: false,
      lastHydratedAt: null, lastHydrateMode: null, lastPushedAt: null,
      sharedSecrets: { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
      hydratedApps: [], ghInstalled: false, ghAuthenticated: false, ghUser: null, suggestedRepo: null, error: null, historyImports: [],
    },
    profiles: [],
    activeProfileId: null,
    activeProfileModified: false,
    skillHub: {
      totalInstalled: 0, upToDateCount: 0, updateAvailableCount: 0, localCustomCount: 0, symlinkDriftCount: 0,
      installedSkills: [], skillPacksExplicit: false, projectPacks: [], hostCatalog: [], roleMatrix: [],
    },
    daemonError: null,
    panel: isProject
      ? {
          isProject: true,
          name: "my-app",
          summary: "Supervisor vacant",
          needsYou: [],
          handoffs: [],
          profile: { active: null, list: [], modified: false },
          defaultWorker: { role: "worker" as const, title: "Default worker" as const, lane: { provider: "pi", model: "zcode/glm-5.3", thinking: "off", scope: "machine" as const } },
          seats: {
            supervisor: {
              role: "supervisor" as const,
              vacant: overrides.supervisorVacant ?? true,
              agentId: overrides.supervisorVacant === false ? "sup-live" : null,
              lane: { provider: "claude", model: "opus-4-8", thinking: "off", scope: "machine" as const },
              pendingLane: null,
              markTokens: 128000,
              allowedActions: [],
              statusLabel: "vacant",
              tone: "normal" as const,
              model: null,
              hint: null,
              context: null,
              handoff: null,
            },
            lead: {
              role: "lead" as const,
              vacant: true,
              agentId: null,
              lane: { provider: "pi", model: "zcode/glm-5.3", thinking: "off", scope: "machine" as const },
              pendingLane: null,
              markTokens: 128000,
              allowedActions: [],
              statusLabel: "vacant",
              tone: "normal" as const,
              model: null,
              hint: null,
              context: null,
              handoff: null,
            },
            peers: [],
            supervisorCandidates: [],
          },
          openDesign: null,
          onboarding: null,
        }
      : {
          isProject: false,
          name: null,
          summary: "Not a Factory Project yet",
          needsYou: [],
          handoffs: [],
          profile: { active: null, list: [], modified: false },
          defaultWorker: null,
          seats: null,
          openDesign: null,
          onboarding: { folder, gitRepo: true, hasCommits: true, existingLead: false },
        },
  };
}

test("FactoryShell uses onboardingStart + onboardingStatus, reacts to stateUpdates onboarding.progress even when isProject flips mid-run, and opens Supervisor chat directly", async () => {
  const { FactoryShell, PluginRpcProvider } = await loadShellHarness({ withSubscription: true });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const toasts: any[] = [];
  (g as any).__shellTestToasts = toasts;
  const rpcCalls: Array<{ method: string; input: any }> = [];
  const openedAgents: any[] = [];
  let subObserver: { event: (e: any) => void; closed: (err?: Error) => void } | null = null;
  let currentView = makeShellOnboardingView({ isProject: false, folder: "/work/my-app" });

  const runningRun = {
    runId: "shell-run-1",
    folder: "/work/my-app",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:00.100Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.050Z", error: null },
      { id: "register-and-lanes", label: "Registering Project & saving model lanes", status: "running", startedAt: "2026-11-20T12:00:00.050Z", finishedAt: null, error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "pending", startedAt: null, finishedAt: null, error: null },
    ],
  };
  let currentRun: any = runningRun;

  const invoke = async (method: string, input: any) => {
    rpcCalls.push({ method, input });
    if (method === "factory.snapshot") return { ok: true, view: currentView };
    if (method === "factory.self.update.status") return { ok: true, current: "0.16.2", latest: "0.16.2", updateAvailable: false };
    if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
    if (method === "factory.onboarding.inspect") return { ...readyInspection, folder: "/work/my-app" };
    if (method === "factory.onboarding.status") return { ok: true, run: currentRun === runningRun && rpcCalls.filter((c) => c.method === "factory.onboarding.start").length === 0 ? null : currentRun };
    if (method === "factory.onboarding.start") return { ok: true, run: runningRun };
    return { ok: true };
  };
  const subscribe = (_method: string, _input: unknown, observer: { event: (e: any) => void; closed: (err?: Error) => void }) => {
    subObserver = observer;
    const stop = () => {};
    return Object.assign(stop, { ready: Promise.resolve(), release: async () => {} });
  };

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    await act(async () => {
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/my-app",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
            navigation: { openAgent: (x: unknown) => openedAgents.push(x) },
          }),
        ),
      );
    });
    for (let i = 0; i < 20 && (!q("factory-quickstart-start") || (q("factory-quickstart-start") as HTMLButtonElement).disabled); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.ok(q("factory-onboarding"), "renders OnboardingWizard initially");
    assert.ok(q("factory-quickstart"), "renders Quick Start view");

    await act(async () => { q("factory-quickstart-start")!.click(); });

    assert.equal(rpcCalls.some((c) => c.method === "factory.onboarding.commit"), false, "never calls legacy onboardingCommit");
    assert.ok(rpcCalls.some((c) => c.method === "factory.onboarding.start"), "calls onboardingStart");
    assert.ok(q("factory-onboarding-run-checklist"), "renders Quick Start checklist");

    // Mid-run: register-and-lanes finishes so snapshot flips panel.isProject = true while start-supervisor is still running.
    currentView = makeShellOnboardingView({ isProject: true, folder: "/work/my-app", supervisorVacant: true });
    currentRun = {
      ...runningRun,
      phases: [
        runningRun.phases[0],
        { ...runningRun.phases[1], status: "done", finishedAt: "2026-11-20T12:00:00.400Z" },
        { id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: "2026-11-20T12:00:00.400Z", finishedAt: null, error: null },
      ],
    };
    const statusBeforePush = rpcCalls.filter((c) => c.method === "factory.onboarding.status").length;
    await act(async () => {
      subObserver!.event({ seq: 1, reasons: ["onboarding.progress"], projectRoot: "/work/my-app", at: "2026-11-20T12:00:00.400Z" });
    });
    for (let i = 0; i < 10 && rpcCalls.filter((c) => c.method === "factory.onboarding.status").length === statusBeforePush; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.ok(rpcCalls.filter((c) => c.method === "factory.onboarding.status").length > statusBeforePush, "onboarding.progress triggers immediate status refresh");
    assert.ok(q("factory-onboarding-run-checklist"), "wizard checklist stays mounted mid-run even after project registration");
    assert.equal(q("factory-onboarding-phase-status-register-and-lanes")?.textContent, "done");
    assert.equal(q("factory-onboarding-phase-status-start-supervisor")?.textContent, "running");

    // Terminal completion via onboarding.progress push -> calls refresh and openAgent, then flips to ProjectPanel.
    currentView = makeShellOnboardingView({ isProject: true, folder: "/work/my-app", supervisorVacant: false });
    currentRun = {
      ...runningRun,
      status: "succeeded",
      result: { agentId: "sup-shell-1", projectRoot: "/work/my-app", slug: "my-app", bootstrapped: false, summary: "Set up my-app; Supervisor running." },
      phases: [
        runningRun.phases[0],
        { ...runningRun.phases[1], status: "done", finishedAt: "2026-11-20T12:00:00.400Z" },
        { id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: "2026-11-20T12:00:00.400Z", finishedAt: "2026-11-20T12:00:01.000Z", error: null },
      ],
    };
    await act(async () => {
      subObserver!.event({ seq: 2, reasons: ["onboarding.progress"], projectRoot: "/work/my-app", at: "2026-11-20T12:00:01.000Z" });
    });
    for (let i = 0; i < 20 && openedAgents.length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.deepEqual(openedAgents, [{ agentId: "sup-shell-1", serverId: "srv-1" }], "always opens Supervisor chat on completion");
    assert.ok(toasts.some((t) => /Set up my-app/.test(t.msg) && t.opts?.variant === "success"));

    await act(async () => { root.unmount(); });
  } finally {
    delete (g as any).__shellTestToasts;
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("FactoryShell (< 0.16.0 host without useSubscription) re-attaches to in-flight run on mount and completes via polling, and suppresses navigation if dir switches away", async () => {
  const { FactoryShell } = await loadShellHarness({ withSubscription: false });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const toasts: any[] = [];
  const openedAgents: any[] = [];
  (g as any).__shellTestToasts = toasts;

  const runningRun = {
    runId: "shell-reattach-1",
    folder: "/work/alpha",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:00.100Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.050Z", error: null },
      { id: "register-and-lanes", label: "Registering Project & saving model lanes", status: "done", startedAt: "2026-11-20T12:00:00.050Z", finishedAt: "2026-11-20T12:00:00.200Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: "2026-11-20T12:00:00.200Z", finishedAt: null, error: null },
    ],
  };
  const succeededRun = {
    ...runningRun,
    status: "succeeded",
    result: { agentId: "sup-bg-1", projectRoot: "/work/alpha", slug: "alpha", bootstrapped: false, summary: "Background alpha ready." },
    phases: [
      runningRun.phases[0],
      runningRun.phases[1],
      { id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: "2026-11-20T12:00:00.200Z", finishedAt: "2026-11-20T12:00:01.000Z", error: null },
    ],
  };

  let statusPollCount = 0;
  let releaseComplete = false;
  (g as any).__shellTestLegacyRpc = async (method: string, input: any) => {
    if (method === "factory.snapshot") {
      if (input?.projectRoot === "/work/beta") return { ok: true, view: makeShellOnboardingView({ isProject: true, folder: "/work/beta", supervisorVacant: false }) };
      // Already registered mid-run with vacant Supervisor!
      return { ok: true, view: makeShellOnboardingView({ isProject: true, folder: "/work/alpha", supervisorVacant: true }) };
    }
    if (method === "factory.self.update.status") return { ok: true, current: "0.16.2", latest: "0.16.2", updateAvailable: false };
    if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
    if (method === "factory.onboarding.inspect") return { ...readyInspection, folder: input.folder };
    if (method === "factory.onboarding.status") {
      statusPollCount += 1;
      return { ok: true, run: releaseComplete ? succeededRun : runningRun };
    }
    return { ok: true };
  };

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    await act(async () => {
      root.render(
        createElement(FactoryShell, {
          theme,
          dir: "/work/alpha",
          serverId: "srv-1",
          layout: { compact: false, platform: "web" },
          navigation: { openAgent: (x: unknown) => openedAgents.push(x) },
        }),
      );
    });
    for (let i = 0; i < 20 && !q("factory-onboarding-run-checklist"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
    }
    assert.ok(q("factory-onboarding-run-checklist"), "re-attaches to Quick Start checklist even when isProject is already true with vacant Supervisor");
    assert.ok(q("factory-quickstart"), "renders Quick Start view");

    // User switches away to another workspace (/work/beta) before alpha finishes.
    await act(async () => {
      root.render(
        createElement(FactoryShell, {
          theme,
          dir: "/work/beta",
          serverId: "srv-1",
          layout: { compact: false, platform: "web" },
          navigation: { openAgent: (x: unknown) => openedAgents.push(x) },
        }),
      );
    });
    releaseComplete = true;
    for (let i = 0; i < 30 && toasts.length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    }
    assert.ok(statusPollCount >= 2, "polling fallback continues watching background run");
    assert.ok(toasts.some((t) => /Background alpha ready/.test(t.msg) && t.opts?.variant === "success"), "emits non-intrusive success toast on background completion");
    assert.deepEqual(openedAgents, [], "does NOT steal focus with openAgent when Owner switched away");

    await act(async () => { root.unmount(); });
  } finally {
    delete (g as any).__shellTestToasts;
    delete (g as any).__shellTestLegacyRpc;
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("FactoryShell clears/avoids stale onboardingHoldFolder when factory.onboarding.start synchronously refuses", async () => {
  const { FactoryShell, PluginRpcProvider } = await loadShellHarness({ withSubscription: true });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  (g as any).__shellTestToasts = [];
  let subObserver: { event: (e: any) => void; closed: (err?: Error) => void } | null = null;
  let currentView = makeShellOnboardingView({ isProject: false, folder: "/work/my-app" });
  let snapshotCount = 0;

  const invoke = async (method: string) => {
    if (method === "factory.snapshot") {
      snapshotCount += 1;
      return { ok: true, view: currentView };
    }
    if (method === "factory.self.update.status") return { ok: true, current: "0.16.2", latest: "0.16.2", updateAvailable: false };
    if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
    if (method === "factory.onboarding.inspect") return { ...readyInspection, folder: "/work/my-app" };
    if (method === "factory.onboarding.status") return { ok: true, run: null };
    if (method === "factory.onboarding.start") {
      return { ok: false, code: "lead-live", error: "A Lead is already live in /work/my-app" };
    }
    return { ok: true };
  };
  const subscribe = (_method: string, _input: unknown, observer: { event: (e: any) => void; closed: (err?: Error) => void }) => {
    subObserver = observer;
    const stop = () => {};
    return Object.assign(stop, { ready: Promise.resolve(), release: async () => {} });
  };

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    await act(async () => {
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/my-app",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
          }),
        ),
      );
    });
    for (let i = 0; i < 20 && (!q("factory-quickstart-start") || (q("factory-quickstart-start") as HTMLButtonElement).disabled); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.ok(q("factory-onboarding"), "renders OnboardingWizard initially");

    await act(async () => { q("factory-quickstart-start")!.click(); });

    assert.match(q("factory-onboarding-error")?.textContent ?? "", /A Lead is already live/);

    // Subsequent snapshot flip to a live Project must transition out of the wizard cleanly (no stale hold state).
    currentView = makeShellOnboardingView({ isProject: true, folder: "/work/my-app", supervisorVacant: false });
    const beforeRefresh = snapshotCount;
    await act(async () => {
      subObserver!.event({ seq: 1, reasons: ["snapshot"], projectRoot: "/work/my-app", at: new Date().toISOString() });
    });
    for (let i = 0; i < 10 && snapshotCount === beforeRefresh; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });

    assert.equal(q("factory-onboarding"), null, "does NOT keep wizard held after synchronous start refusal");
    assert.ok(q("factory-panel-seat-supervisor"), "renders ProjectPanel once snapshot shows active Project");
  } finally {
    await act(async () => { root.unmount(); });
    delete (g as any).__shellTestToasts;
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("FactoryShell onboarding completion forwards focusHost: true only when navigation.supportsFocusHost === true", async () => {
  const { FactoryShell, PluginRpcProvider } = await loadShellHarness({ withSubscription: true });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };

  for (const supportsFocusHost of [true, false, undefined] as const) {
    const dom = new JSDOM("<!doctype html><div id=root></div>");
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
    g.window = dom.window;
    g.document = dom.window.document;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    (g as any).__shellTestToasts = [];

    const openedAgents: Array<Record<string, unknown>> = [];
    let currentView = makeShellOnboardingView({ isProject: false, folder: "/work/my-app" });
    let started = false;
    const succeededRun = {
      runId: "shell-focus-1",
      folder: "/work/my-app",
      status: "succeeded",
      startedAt: "2026-11-20T12:00:00.000Z",
      updatedAt: "2026-11-20T12:00:01.000Z",
      result: { agentId: "sup-onboard-focus", projectRoot: "/work/my-app", slug: "my-app", bootstrapped: false, summary: "Set up my-app; Supervisor running." },
      error: null,
      errorCode: null,
      phases: [
        { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.100Z", error: null },
        { id: "register-and-lanes", label: "Registering Project & saving model lanes", status: "done", startedAt: "2026-11-20T12:00:00.100Z", finishedAt: "2026-11-20T12:00:00.500Z", error: null },
        { id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: "2026-11-20T12:00:00.500Z", finishedAt: "2026-11-20T12:00:01.000Z", error: null },
      ],
    };

    const invoke = async (method: string) => {
      if (method === "factory.snapshot") return { ok: true, view: currentView };
      if (method === "factory.self.update.status") return { ok: true, current: "0.17.1", latest: "0.17.1", updateAvailable: false };
      if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
      if (method === "factory.onboarding.inspect") return { ...readyInspection, folder: "/work/my-app" };
      if (method === "factory.onboarding.status") return { ok: true, run: started ? succeededRun : null };
      if (method === "factory.onboarding.start") {
        started = true;
        currentView = makeShellOnboardingView({ isProject: true, folder: "/work/my-app", supervisorVacant: false });
        return { ok: true, run: succeededRun };
      }
      return { ok: true };
    };
    const subscribe = () => Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} });

    const root = createRoot(dom.window.document.getElementById("root")!);
    const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

    try {
      await act(async () => {
        root.render(
          createElement(
            PluginRpcProvider,
            { invoke, subscribe },
            createElement(FactoryShell, {
              theme,
              dir: "/work/my-app",
              serverId: "srv-remote",
              layout: { compact: false, platform: "web" },
              navigation: {
                ...(supportsFocusHost === undefined ? {} : { supportsFocusHost }),
                openAgent: (x: Record<string, unknown>) => openedAgents.push(x),
              },
            }),
          ),
        );
      });
      for (let i = 0; i < 20 && (!q("factory-quickstart-start") || (q("factory-quickstart-start") as HTMLButtonElement).disabled); i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      }
      await act(async () => { q("factory-quickstart-start")!.click(); });
      for (let i = 0; i < 20 && openedAgents.length === 0; i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      }
      assert.equal(openedAgents.length, 1);
      if (supportsFocusHost === true) {
        assert.deepEqual(openedAgents[0], { agentId: "sup-onboard-focus", serverId: "srv-remote", focusHost: true });
      } else {
        assert.deepEqual(openedAgents[0], { agentId: "sup-onboard-focus", serverId: "srv-remote" });
        assert.equal("focusHost" in openedAgents[0]!, false, `focusHost omitted when supportsFocusHost=${String(supportsFocusHost)}`);
      }
    } finally {
      await act(async () => { root.unmount(); });
      delete (g as any).__shellTestToasts;
      g.window = saved.window;
      g.document = saved.document;
      g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
      dom.window.close();
    }
  }
});

// ---- Iteration 2 regression & canary purity tests -------------------------------------------

function buttonOf(html: string, id: string): string {
  const idx = html.indexOf(`data-testid="${id}"`);
  assert.notEqual(idx, -1, `missing button ${id}`);
  const start = html.lastIndexOf("<button", idx);
  assert.notEqual(start, -1, `missing <button for ${id}`);
  const end = html.indexOf("</button>", idx);
  assert.notEqual(end, -1, `missing </button> for ${id}`);
  return html.slice(start, end + "</button>".length);
}

test("Quick Start prevents synchronous double-clicks on Start Supervisor and Retry, releases lock on settlement, and guards client-only open-workspace Retry", async () => {
  const { OnboardingWizard } = await loadInteractiveWizard();
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

  const failedServerRun = {
    runId: "run-dbl-fail",
    folder: "/work/my-app",
    status: "failed",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:01.000Z",
    result: null,
    error: "Supervisor start failed",
    errorCode: "supervisor-start-failed",
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.100Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "failed", startedAt: "2026-11-20T12:00:00.100Z", finishedAt: "2026-11-20T12:00:01.000Z", error: "Supervisor start failed" },
    ],
  };
  const succeededRun = {
    runId: "run-dbl-ok",
    folder: "/work/my-app",
    status: "succeeded",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:01.000Z",
    result: { agentId: "sup-dbl", projectRoot: "/work/my-app", slug: "my-app", bootstrapped: false, summary: "Ready" },
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.100Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: "2026-11-20T12:00:00.100Z", finishedAt: "2026-11-20T12:00:01.000Z", error: null },
    ],
  };

  let startCalls = 0;
  let pendingStartResolvers: Array<(v: any) => void> = [];
  let pendingStartRejectors: Array<(err: Error) => void> = [];
  let startBehavior: "defer" | "reject" = "defer";

  try {
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          theme,
          view,
          folder: "/work/my-app",
          initialUi: { inspection: readyInspection },
          actions: {
            ...noopActions,
            start: () => {
              startCalls += 1;
              return new Promise((resolve, reject) => {
                if (startBehavior === "reject") pendingStartRejectors.push(reject);
                else pendingStartResolvers.push(resolve);
              });
            },
          },
        }),
      );
    });

    // Two synchronous clicks on Start Supervisor in one event batch -> only 1 actions.start call.
    await act(async () => {
      const btn = q("factory-quickstart-start")!;
      btn.click();
      btn.click();
    });
    assert.equal(startCalls, 1, "synchronous double-click on Start Supervisor invokes actions.start once");

    // Settle with failed server run -> Retry renders and lock releases.
    await act(async () => {
      pendingStartResolvers.shift()!({ ok: true, run: failedServerRun });
    });
    assert.ok(q("factory-onboarding-run-retry"), "Retry button renders after server failure");

    // Two synchronous clicks on Retry while start is pending -> only 1 additional call.
    await act(async () => {
      const retry = q("factory-onboarding-run-retry")!;
      retry.click();
      retry.click();
    });
    assert.equal(startCalls, 2, "synchronous double-click on Retry invokes actions.start once");

    // Resolve with { ok: false } -> lock releases; next click fires and rejects -> lock still releases.
    await act(async () => {
      pendingStartResolvers.shift()!({ ok: false, error: "retry failed" });
    });
    startBehavior = "reject";
    await act(async () => {
      q("factory-onboarding-run-retry")!.click();
    });
    assert.equal(startCalls, 3, "lock released after { ok: false }");
    await act(async () => {
      pendingStartRejectors.shift()!(new Error("boom"));
    });
    startBehavior = "defer";
    await act(async () => {
      q("factory-onboarding-run-retry")!.click();
    });
    assert.equal(startCalls, 4, "lock released after async rejection");
    await act(async () => {
      pendingStartResolvers.shift()!({ ok: false, error: "done" });
    });

    // Client-only open-workspace Retry double-click lock.
    let finalizeCalls = 0;
    let resolveFinalize: ((v: any) => void) | null = null;
    await act(async () => {
      root.render(
        createElement(OnboardingWizard, {
          key: "client-only-dbl",
          theme,
          view,
          folder: "/work/my-app",
          initialUi: {
            inspection: readyInspection,
            run: succeededRun,
            openWorkspace: { status: "failed", error: "disk busy" },
          },
          actions: {
            ...noopActions,
            start: async () => {
              startCalls += 1;
              return { ok: true as const };
            },
            finalize: () => {
              finalizeCalls += 1;
              return new Promise((resolve) => {
                resolveFinalize = resolve;
              });
            },
          },
        }),
      );
    });

    await act(async () => {
      const retry = q("factory-onboarding-run-retry")!;
      retry.click();
      retry.click();
    });
    assert.equal(finalizeCalls, 1, "synchronous double-click on open-workspace Retry invokes actions.finalize once");
    assert.equal(startCalls, 4, "client-only Retry never calls actions.start");

    await act(async () => {
      resolveFinalize!({ ok: false, error: "still busy" });
    });
    await act(async () => {
      q("factory-onboarding-run-retry")!.click();
    });
    assert.equal(finalizeCalls, 2, "finalize lock releases on settlement");
    await act(async () => {
      resolveFinalize!({ ok: true });
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("OnboardingWizard clears stale inspection, ignores out-of-order inspect replies, and resets initGit when folder changes without key", async () => {
  const { OnboardingWizard } = await loadInteractiveWizard();
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    // Subcase A: Switching folder without key when new inspect fails clears prior inspection & disables Start.
    let startCallsA = 0;
    const actionsA = {
      ...noopActions,
      inspect: async (folder: string) =>
        folder === "/work/folder-a"
          ? { ...readyInspection, folder: "/work/folder-a", gitRepo: true }
          : { ok: false as const, error: `Folder ${folder} does not exist` },
      start: async () => {
        startCallsA += 1;
        return { ok: true as const };
      },
    };
    await act(async () => {
      root.render(createElement(OnboardingWizard, { theme, view, folder: "/work/folder-a", actions: actionsA }));
    });
    for (let i = 0; i < 10 && (q("factory-quickstart-start") as HTMLButtonElement | null)?.disabled !== false; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, false);

    await act(async () => {
      root.render(createElement(OnboardingWizard, { theme, view, folder: "/work/folder-b", actions: actionsA }));
    });
    for (let i = 0; i < 10 && !q("factory-onboarding-error"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    assert.match(q("factory-onboarding-error")?.textContent ?? "", /Folder \/work\/folder-b does not exist/);
    assert.equal(q("factory-onboarding-git-badge"), null, "stale git badge cleared on failed inspect");
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, true, "Start stays disabled on failed inspect");
    await act(async () => { q("factory-quickstart-start")!.click(); });
    assert.equal(startCallsA, 0, "clicking disabled Start after failed inspect never fires actions.start");

    // Subcase B: Out-of-order slow inspect from older folder never overwrites newer fast folder.
    let resolveSlowA: ((v: any) => void) | null = null;
    const statusQueries: unknown[] = [];
    const actionsB = {
      ...noopActions,
      inspect: (folder: string) => {
        if (folder === "/work/slow-a") {
          return new Promise((resolve) => {
            resolveSlowA = resolve;
          });
        }
        return Promise.resolve({ ...readyInspection, folder: "/work/fast-b", gitRepo: false, hasCommits: false });
      },
      status: async (input: unknown) => {
        statusQueries.push(input);
        return { ok: true as const, run: null };
      },
    };
    await act(async () => {
      root.render(createElement(OnboardingWizard, { key: "ooo-race", theme, view, folder: "/work/slow-a", actions: actionsB }));
    });
    await act(async () => {
      root.render(createElement(OnboardingWizard, { key: "ooo-race", theme, view, folder: "/work/fast-b", actions: actionsB }));
    });
    for (let i = 0; i < 10 && !q("factory-onboarding-git-badge"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    assert.equal(q("factory-onboarding-git-badge")?.textContent, "Not a Git repository");
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, true);

    await act(async () => {
      resolveSlowA!({ ...readyInspection, folder: "/work/slow-a", gitRepo: true, hasCommits: true });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.equal(q("factory-onboarding-git-badge")?.textContent, "Not a Git repository", "stale slow-a inspect discarded");
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, true);
    assert.equal(
      statusQueries.some((qInput: any) => qInput?.folder === "/work/slow-a"),
      false,
      "stale inspect never triggers probeFolder for old folder",
    );

    // Subcase C: initGit resets across folder changes without key.
    const actionsC = {
      ...noopActions,
      inspect: async (folder: string) => ({ ...readyInspection, folder, gitRepo: false, hasCommits: false }),
    };
    await act(async () => {
      root.render(createElement(OnboardingWizard, { key: "initgit-reset", theme, view, folder: "/work/plain-a", actions: actionsC }));
    });
    for (let i = 0; i < 10 && !q("factory-onboarding-init-git"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    await act(async () => { q("factory-onboarding-init-git")!.click(); });
    assert.equal(q("factory-onboarding-git-badge")?.textContent, "Git will be initialised");
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, false);

    await act(async () => {
      root.render(createElement(OnboardingWizard, { key: "initgit-reset", theme, view, folder: "/work/plain-b", actions: actionsC }));
    });
    for (let i = 0; i < 10 && !q("factory-onboarding-git-badge"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    assert.equal(q("factory-onboarding-git-badge")?.textContent, "Not a Git repository", "initGit resets on folder change");
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("FactoryShell remounts OnboardingWizard on dir switch via key={onboardingFolder} and keeps Settings PrerequisiteSetupCard interactive", async () => {
  const { FactoryShell, PluginRpcProvider } = await loadShellHarness({ withSubscription: true });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  (g as any).__shellTestToasts = [];

  const rpcCalls: Array<{ method: string; input: any }> = [];
  const missingTool = {
    id: "factory-skills-pack",
    title: "Factory Skills Pack",
    tagline: "Core SLP skills",
    description: "Required Factory skills",
    canonicalSource: "git:daymanondev/factory-skills-pack",
    sidebarLabel: "Skills",
    sidebarIcon: "sparkles",
    capabilities: [],
    access: "public" as const,
    status: "not_installed" as const,
    enabled: false,
    installKind: null,
    installedSource: null,
    currentRevision: null,
    version: null,
    latestRevision: null,
    commitsBehind: null,
    updateAvailable: null,
    error: null,
  };

  const invoke = async (method: string, input: any) => {
    rpcCalls.push({ method, input });
    if (method === "factory.snapshot") {
      const folder = input?.projectRoot ?? "/work/folder-a";
      const base = makeShellOnboardingView({ isProject: false, folder });
      return { ok: true, view: { ...base, companionTools: [missingTool] } };
    }
    if (method === "factory.self.update.status") return { ok: true, current: "0.17.1", latest: "0.17.1", updateAvailable: false };
    if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
    if (method === "factory.onboarding.inspect") {
      if (input?.folder === "/work/folder-b") return { ok: false, code: "not_found", error: "Folder /work/folder-b does not exist" };
      return { ...readyInspection, folder: input?.folder ?? "/work/folder-a" };
    }
    if (method === "factory.onboarding.status") return { ok: true, run: null };
    if (method === "factory.plugins.install") return { ok: true, installed: ["factory-skills-pack"], summary: "Installed required skills & tools." };
    if (method === "factory.plugins.check.updates") {
      return { ok: true, checkedAt: new Date().toISOString(), updatesAvailable: [], summary: "All up to date" };
    }
    return { ok: true };
  };
  const subscribe = () => Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} });

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    // 1. FactoryShell switching onboardingFolder remounts OnboardingWizard cleanly.
    await act(async () => {
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/folder-a",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
          }),
        ),
      );
    });
    for (let i = 0; i < 20 && (!q("factory-quickstart-start") || (q("factory-quickstart-start") as HTMLButtonElement).disabled); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { q("factory-quickstart-customize-models")!.click(); });
    assert.ok(q("factory-quickstart-models"), "Customize models expanded on folder-a");

    await act(async () => {
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/folder-b",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
          }),
        ),
      );
    });
    for (let i = 0; i < 20 && !q("factory-onboarding-error"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.match(q("factory-onboarding-error")?.textContent ?? "", /Folder \/work\/folder-b does not exist/);
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, true);
    assert.equal(q("factory-quickstart-models"), null, "Customize models collapsed again after remount via key={onboardingFolder}");

    // 2. FactoryShell surface="settings" renders PrerequisiteSetupCard and dispatches factory.plugins.install.
    await act(async () => {
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            surface: "settings",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
          }),
        ),
      );
    });
    for (let i = 0; i < 20 && !(dom.window.document.body.textContent ?? "").includes("Required Factory Skills & Tools Setup"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    const text = dom.window.document.body.textContent ?? "";
    assert.match(text, /PREREQUISITE SETUP GATE/);
    assert.match(text, /Required Factory Skills & Tools Setup/);
    const installBtn = (Array.from(dom.window.document.querySelectorAll("button")) as HTMLButtonElement[]).find(
      (b) => b.textContent?.trim() === "Install Required Skills & Tools",
    );
    assert.ok(installBtn, "PrerequisiteSetupCard Install button renders in Settings");
    await act(async () => { installBtn.click(); });
    assert.ok(
      rpcCalls.some(
        (c) => c.method === "factory.plugins.install" && c.input?.target === "all" && c.input?.includeTools === true,
      ),
      "clicking Install Required Skills & Tools invokes factory.plugins.install with target=all, includeTools=true",
    );
  } finally {
    await act(async () => { root.unmount(); });
    delete (g as any).__shellTestToasts;
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("Quick Start emits zero canary host accent/status colours across light & dark states and styles CTAs with palette.lead", async () => {
  const canaryLightTheme = {
    colors: {
      ...theme.colors,
      surface0: "#ffffff",
      accent: "#ff00fe",
      statusSuccess: "#01ff02",
      statusWarning: "#fffe01",
      statusDanger: "#ff0101",
    },
  };
  const canaryDarkTheme = {
    colors: {
      ...theme.colors,
      surface0: "#000000",
      surface1: "#111111",
      surface2: "#222222",
      foreground: "#eeeeee",
      foregroundMuted: "#aaaaaa",
      border: "#333333",
      accent: "#ff00fe",
      statusSuccess: "#01ff02",
      statusWarning: "#fffe01",
      statusDanger: "#ff0101",
    },
  };

  const t0 = Date.parse("2026-11-20T12:00:00.000Z");
  const runningRun = {
    runId: "canary-run",
    folder: "/work/my-app",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:01.000Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.500Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: "2026-11-20T12:00:01.000Z", finishedAt: null, error: null },
    ],
  };
  const failedRun = {
    ...runningRun,
    status: "failed",
    error: "Provider quota exceeded",
    errorCode: "supervisor-start-failed",
    phases: [
      runningRun.phases[0]!,
      { id: "start-supervisor", label: "Starting Supervisor", status: "failed", startedAt: "2026-11-20T12:00:01.000Z", finishedAt: "2026-11-20T12:00:05.000Z", error: "Provider quota exceeded" },
    ],
  };

  for (const [modeName, t, expectedLead] of [
    ["light", canaryLightTheme, "#2f7899"],
    ["dark", canaryDarkTheme, "#5fa8cc"],
  ] as const) {
    const readyHtml = await render({ inspection: readyInspection, customizeModels: true }, { theme: t, view: { ...view, profiles: SAMPLE_PROFILES } });
    const nonGitHtml = await render({ inspection: { ...readyInspection, gitRepo: false, hasCommits: false }, customizeModels: true }, { theme: t, view: { ...view, profiles: SAMPLE_PROFILES } });
    const initGitOnHtml = await render({ inspection: { ...readyInspection, gitRepo: false, hasCommits: false }, initGit: true }, { theme: t });
    const blockerHtml = await render({ inspection: { ...readyInspection, existingLead: true }, inspectError: "Check failed" }, { theme: t });
    const runningHtml = await render({ inspection: readyInspection, run: runningRun, now: t0 + 13_000, pollWarning: "Temporary hiccup" }, { theme: t });
    const failedHtml = await render({ inspection: readyInspection, run: failedRun }, { theme: t });

    for (const [scenario, html] of [
      ["ready", readyHtml],
      ["non-git", nonGitHtml],
      ["init-git-on", initGitOnHtml],
      ["blocker-error", blockerHtml],
      ["running", runningHtml],
      ["failed", failedHtml],
    ] as const) {
      assert.equal(/#(ff00fe|01ff02|fffe01|ff0101)/i.test(html), false, `${modeName} ${scenario} leaked canary host colour`);
    }

    assert.ok(buttonOf(nonGitHtml, "factory-onboarding-init-git").includes(expectedLead), `${modeName} init-git CTA uses palette.lead`);
    assert.equal(buttonOf(initGitOnHtml, "factory-onboarding-init-git").includes(expectedLead), false, `${modeName} init-git undo stays neutral muted`);
    assert.ok(buttonOf(readyHtml, "factory-quickstart-start").includes(expectedLead), `${modeName} Start Supervisor CTA uses palette.lead`);
    assert.ok(buttonOf(failedHtml, "factory-onboarding-run-retry").includes(expectedLead), `${modeName} Retry CTA uses palette.lead`);
  }
});

// ---- Iteration 3 folder-switch cross-contamination regression tests -------------------------

test("FactoryShell switching unregistered folder-a -> folder-b while folder-a probeFolder is in-flight never hijacks folder-b Quick Start", async () => {
  const { FactoryShell, PluginRpcProvider } = await loadShellHarness({ withSubscription: true });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  (g as any).__shellTestToasts = [];

  let resolveFolderAStatus: ((reply: any) => void) | null = null;
  let folderAStatusRequested = false;
  let folderBStatusResolved = false;

  const runningRunForA = {
    runId: "run-a-hijack",
    folder: "/work/folder-a",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:01.000Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [
      { id: "checking", label: "Checking folder & preconditions", status: "done", startedAt: "2026-11-20T12:00:00.000Z", finishedAt: "2026-11-20T12:00:00.100Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor for folder-a", status: "running", startedAt: "2026-11-20T12:00:00.100Z", finishedAt: null, error: null },
    ],
  };

  const invoke = async (method: string, input: any) => {
    if (method === "factory.snapshot") {
      const folder = input?.projectRoot ?? "/work/folder-a";
      return { ok: true, view: makeShellOnboardingView({ isProject: false, folder }) };
    }
    if (method === "factory.self.update.status") return { ok: true, current: "0.17.1", latest: "0.17.1", updateAvailable: false };
    if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
    if (method === "factory.onboarding.inspect") return { ...readyInspection, folder: input?.folder ?? "/work/folder-a" };
    if (method === "factory.onboarding.status") {
      if (input?.folder === "/work/folder-a") {
        folderAStatusRequested = true;
        return new Promise((resolve) => {
          resolveFolderAStatus = resolve;
        });
      }
      folderBStatusResolved = true;
      return { ok: true, run: null };
    }
    return { ok: true };
  };
  const subscribe = () => Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} });

  const root = createRoot(dom.window.document.getElementById("root")!);
  const q = (testId: string) => dom.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    await act(async () => {
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/folder-a",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
          }),
        ),
      );
    });
    for (let i = 0; i < 30 && !folderAStatusRequested; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.equal(folderAStatusRequested, true, "probeFolder started for /work/folder-a");
    assert.ok(resolveFolderAStatus, "captured deferred status resolver for /work/folder-a");

    // Switch to unregistered /work/folder-b while folder-a's probeFolder is still in flight.
    await act(async () => {
      root.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/folder-b",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
          }),
        ),
      );
    });
    for (
      let i = 0;
      i < 30 && (!folderBStatusResolved || !q("factory-quickstart-start") || (q("factory-quickstart-start") as HTMLButtonElement).disabled);
      i++
    ) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.match(q("factory-quickstart-folder")?.textContent ?? "", /\/work\/folder-b/);
    assert.equal(q("factory-onboarding-run-checklist"), null);
    assert.equal((q("factory-quickstart-start") as HTMLButtonElement).disabled, false);

    // Now settle folder-a's older in-flight probeFolder with a running run for folder-a.
    await act(async () => {
      resolveFolderAStatus!({ ok: true, run: runningRunForA });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    // Folder B's Quick Start must remain clean and ready.
    assert.match(q("factory-quickstart-folder")?.textContent ?? "", /\/work\/folder-b/);
    assert.equal(q("factory-onboarding-run-checklist"), null, "folder-a's checklist must not hijack folder-b");
    const startBtn = q("factory-quickstart-start") as HTMLButtonElement | null;
    assert.ok(startBtn, "Start Supervisor button stays present on folder-b");
    assert.equal(startBtn.textContent?.trim(), "Start Supervisor");
    assert.equal(startBtn.disabled, false, "Start Supervisor stays enabled on folder-b");
  } finally {
    await act(async () => { root.unmount(); });
    delete (g as any).__shellTestToasts;
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});

test("useOnboardingRunTracker & FactoryShell isolate background refreshWatchedRun polls and startRun across folder switches without focus-steal", async () => {
  const { useOnboardingRunTracker } = await loadClientModule("plugin/client/factory/onboarding-run-tracker.tsx");
  const { FactoryShell, PluginRpcProvider } = await loadShellHarness({ withSubscription: true });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };

  // Part 1: Direct useOnboardingRunTracker tests for in-flight startRun and background refreshWatchedRun poll across folder switches.
  const dom1 = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom1.window;
  g.document = dom1.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  let latestTracker: any = null;
  function TrackerHarness(props: any) {
    latestTracker = useOnboardingRunTracker(props);
    return null;
  }

  const root1 = createRoot(dom1.window.document.getElementById("root")!);
  try {
    // 1A: startRun in-flight while activeFolder switches folder-a -> folder-b.
    let resolveStartA: ((reply: any) => void) | null = null;
    const activeCompleteA: string[] = [];
    const bgCompleteA: string[] = [];
    const trackerPropsA = {
      start: () =>
        new Promise((resolve) => {
          resolveStartA = resolve;
        }),
      onActiveComplete: async (result: any) => {
        activeCompleteA.push(result.projectRoot);
        return { ok: true as const };
      },
      onBackgroundComplete: (result: any) => {
        bgCompleteA.push(result.projectRoot);
      },
    };
    await act(async () => {
      root1.render(createElement(TrackerHarness, { ...trackerPropsA, activeFolder: "/work/folder-a" }));
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = latestTracker.startRun({ folder: "/work/folder-a" });
    });
    await act(async () => {
      root1.render(createElement(TrackerHarness, { ...trackerPropsA, activeFolder: "/work/folder-b" }));
    });
    await act(async () => {
      resolveStartA!({
        ok: true,
        run: {
          runId: "run-start-a",
          folder: "/work/folder-a",
          status: "succeeded",
          startedAt: "2026-11-20T12:00:00.000Z",
          updatedAt: "2026-11-20T12:00:01.000Z",
          error: null,
          errorCode: null,
          phases: [{ id: "checking", label: "Checking", status: "done", startedAt: null, finishedAt: null, error: null }],
          result: { agentId: "sup-a", projectRoot: "/work/folder-a", slug: "folder-a", bootstrapped: false, summary: "Done A" },
        },
      });
      await startPromise;
    });
    assert.equal(latestTracker.activeRun, null, "folder-b activeRun remains null when folder-a startRun settles");
    assert.deepEqual(activeCompleteA, [], "onActiveComplete not called after switching to folder-b");
    assert.deepEqual(bgCompleteA, ["/work/folder-a"], "onBackgroundComplete called for folder-a");

    // 1B: background refreshWatchedRun poll while viewing folder-b.
    const activeCompleteAlpha: string[] = [];
    const bgCompleteAlpha: string[] = [];
    let alphaStatusPolls = 0;
    let alphaFinished = false;
    const runningAlpha = {
      runId: "run-poll-alpha",
      folder: "/work/alpha",
      status: "running",
      startedAt: "2026-11-20T12:00:00.000Z",
      updatedAt: "2026-11-20T12:00:00.100Z",
      result: null,
      error: null,
      errorCode: null,
      phases: [{ id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: null, finishedAt: null, error: null }],
    };
    const succeededAlpha = {
      ...runningAlpha,
      status: "succeeded",
      result: { agentId: "sup-alpha", projectRoot: "/work/alpha", slug: "alpha", bootstrapped: false, summary: "Alpha ready" },
      phases: [{ id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: null, finishedAt: null, error: null }],
    };
    const trackerPropsAlpha = {
      pollIntervalMs: 10,
      start: async () => ({ ok: true as const, run: runningAlpha }),
      status: async () => {
        alphaStatusPolls += 1;
        return { ok: true as const, run: alphaFinished ? succeededAlpha : runningAlpha };
      },
      onActiveComplete: async (result: any) => {
        activeCompleteAlpha.push(result.projectRoot);
        return { ok: true as const };
      },
      onBackgroundComplete: (result: any) => {
        bgCompleteAlpha.push(result.projectRoot);
      },
    };
    await act(async () => {
      root1.render(createElement(TrackerHarness, { ...trackerPropsAlpha, key: "poll-test", activeFolder: "/work/alpha" }));
    });
    await act(async () => {
      await latestTracker.startRun({ folder: "/work/alpha" });
    });
    assert.equal(latestTracker.activeRun?.folder, "/work/alpha");

    await act(async () => {
      root1.render(createElement(TrackerHarness, { ...trackerPropsAlpha, key: "poll-test", activeFolder: "/work/beta" }));
    });
    assert.equal(latestTracker.activeRun, null);

    // Wait for >= 2 running polls while still viewing /work/beta.
    const pollsBefore = alphaStatusPolls;
    for (let i = 0; i < 30 && alphaStatusPolls < pollsBefore + 2; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 12)); });
    }
    assert.ok(alphaStatusPolls >= pollsBefore + 2, "background refreshWatchedRun polled for alpha");
    assert.equal(latestTracker.activeRun, null, "activeRun stays null on beta across alpha background polls");

    alphaFinished = true;
    for (let i = 0; i < 30 && bgCompleteAlpha.length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 12)); });
    }
    assert.equal(latestTracker.activeRun, null, "activeRun stays null on beta when alpha completes");
    assert.deepEqual(activeCompleteAlpha, [], "no onActiveComplete on beta");
    assert.deepEqual(bgCompleteAlpha, ["/work/alpha"], "onBackgroundComplete fires for alpha");
  } finally {
    await act(async () => { root1.unmount(); });
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom1.window.close();
  }

  // Part 2: FactoryShell switching between two unregistered folders while folder-a polls and finishes in background.
  const dom2 = new JSDOM("<!doctype html><div id=root></div>");
  g.window = dom2.window;
  g.document = dom2.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const toasts: any[] = [];
  (g as any).__shellTestToasts = toasts;
  const openedAgents: any[] = [];

  const runningShellA = {
    runId: "shell-bg-a",
    folder: "/work/folder-a",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:00.100Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [{ id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: null, finishedAt: null, error: null }],
  };
  const succeededShellA = {
    ...runningShellA,
    status: "succeeded",
    result: { agentId: "sup-a", projectRoot: "/work/folder-a", slug: "folder-a", bootstrapped: false, summary: "Background folder-a ready." },
    phases: [{ id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: null, finishedAt: null, error: null }],
  };
  let startedShellA = false;
  let shellAFinished = false;
  let shellPollsAfterSwitch = 0;
  let switchedToB = false;

  const invoke = async (method: string, input: any) => {
    if (method === "factory.snapshot") {
      return { ok: true, view: makeShellOnboardingView({ isProject: false, folder: input?.projectRoot ?? "/work/folder-a" }) };
    }
    if (method === "factory.self.update.status") return { ok: true, current: "0.17.1", latest: "0.17.1", updateAvailable: false };
    if (method === "factory.open_design.status") return { ok: true, link: null, updateAvailable: false, sourceAvailable: false };
    if (method === "factory.onboarding.inspect") return { ...readyInspection, folder: input?.folder ?? "/work/folder-a" };
    if (method === "factory.onboarding.start") {
      startedShellA = true;
      return { ok: true, run: runningShellA };
    }
    if (method === "factory.onboarding.status") {
      if (input?.runId === "shell-bg-a") {
        if (switchedToB) shellPollsAfterSwitch += 1;
        return { ok: true, run: shellAFinished ? succeededShellA : runningShellA };
      }
      if (input?.folder === "/work/folder-a" && startedShellA) {
        return { ok: true, run: shellAFinished ? succeededShellA : runningShellA };
      }
      return { ok: true, run: null };
    }
    return { ok: true };
  };
  const subscribe = () => Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} });

  const root2 = createRoot(dom2.window.document.getElementById("root")!);
  const q2 = (testId: string) => dom2.window.document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  try {
    await act(async () => {
      root2.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/folder-a",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
            navigation: { openAgent: (x: unknown) => openedAgents.push(x) },
          }),
        ),
      );
    });
    for (let i = 0; i < 30 && (!q2("factory-quickstart-start") || (q2("factory-quickstart-start") as HTMLButtonElement).disabled); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    await act(async () => { q2("factory-quickstart-start")!.click(); });
    assert.ok(q2("factory-onboarding-run-checklist"), "checklist active on folder-a");

    // Switch to unregistered /work/folder-b.
    switchedToB = true;
    await act(async () => {
      root2.render(
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FactoryShell, {
            theme,
            dir: "/work/folder-b",
            serverId: "srv-1",
            layout: { compact: false, platform: "web" },
            navigation: { openAgent: (x: unknown) => openedAgents.push(x) },
          }),
        ),
      );
    });
    for (let i = 0; i < 30 && (!q2("factory-quickstart-start") || (q2("factory-quickstart-start") as HTMLButtonElement).disabled); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    // Wait for a background poll while folder-a is still running (LIVE_BACKSTOP_POLL_MS = 2000ms, or wait via interval).
    // Actually trigger completion right after verifying folder-b stays clean across background poll if poll fires,
    // wait: use polling fallback host (`withSubscription: false` polls at 750ms) or wait up to 900ms with a <0.16.0 host?
    // Even better, check after 2100ms (or let's test the 750ms poll interval directly with `withSubscription: false`? Wait: we already loaded `FactoryShell` with `withSubscription: true`, and `LIVE_BACKSTOP_POLL_MS` is 2000ms).
    // Wait 2.1s for the live backstop poll tick while folder-a is still running, then finish folder-a on the next tick.
    for (let i = 0; i < 50 && shellPollsAfterSwitch === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    }
    assert.ok(shellPollsAfterSwitch >= 1, "FactoryShell polled folder-a while viewing unregistered folder-b");
    assert.equal(q2("factory-onboarding-run-checklist"), null, "folder-b Quick Start stays clean after background poll");
    assert.equal((q2("factory-quickstart-start") as HTMLButtonElement).disabled, false);

    shellAFinished = true;
    for (let i = 0; i < 50 && toasts.length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    }
    assert.ok(toasts.some((t) => /Background folder-a ready/.test(t.msg) && t.opts?.variant === "success"), "background completion toast shown");
    assert.deepEqual(openedAgents, [], "no focus-steal openAgent on folder-b when folder-a completes");
    assert.equal(q2("factory-onboarding-run-checklist"), null);
  } finally {
    await act(async () => { root2.unmount(); });
    delete (g as any).__shellTestToasts;
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom2.window.close();
  }
});

test("useOnboardingRunTracker probeFolder(canonicalFolder, aliasFolder) attaches when viewing aliasFolder and stays isolated on folder switch", async () => {
  const { useOnboardingRunTracker } = await loadClientModule("plugin/client/factory/onboarding-run-tracker.tsx");
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  let tracker: any = null;
  function Harness(props: any) {
    tracker = useOnboardingRunTracker(props);
    return null;
  }

  const runningCanonical = {
    runId: "run-symlink-1",
    folder: "/canonical/work/real-dir",
    status: "running",
    startedAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:01.000Z",
    result: null,
    error: null,
    errorCode: null,
    phases: [{ id: "start-supervisor", label: "Starting Supervisor", status: "running", startedAt: null, finishedAt: null, error: null }],
  };
  const succeededCanonical = {
    ...runningCanonical,
    status: "succeeded",
    result: { agentId: "sup-symlink", projectRoot: "/canonical/work/real-dir", slug: "real-dir", bootstrapped: false, summary: "Symlink ready" },
    phases: [{ id: "start-supervisor", label: "Starting Supervisor", status: "done", startedAt: null, finishedAt: null, error: null }],
  };

  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    // Subcase A: Staying on aliasFolder attaches canonical run and routes completion to onActiveComplete.
    const activeCalls: string[] = [];
    const bgCalls: string[] = [];
    let finishCanonical = false;
    const propsA = {
      pollIntervalMs: 10,
      start: async () => ({ ok: true as const }),
      status: async () => ({ ok: true as const, run: finishCanonical ? succeededCanonical : runningCanonical }),
      onActiveComplete: async (result: any) => {
        activeCalls.push(result.projectRoot);
        return { ok: true as const };
      },
      onBackgroundComplete: (result: any) => {
        bgCalls.push(result.projectRoot);
      },
    };
    await act(async () => {
      root.render(createElement(Harness, { ...propsA, key: "alias-stay", activeFolder: "/work/alias-link" }));
    });
    await act(async () => {
      await tracker.probeFolder("/canonical/work/real-dir", "/work/alias-link");
    });
    assert.equal(tracker.activeRun?.runId, "run-symlink-1", "attaches when viewing aliasFolder");

    finishCanonical = true;
    for (let i = 0; i < 30 && activeCalls.length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 12)); });
    }
    assert.deepEqual(activeCalls, ["/canonical/work/real-dir"], "completes via onActiveComplete while viewing aliasFolder");
    assert.deepEqual(bgCalls, []);

    // Subcase B: Switching from aliasFolder to other-folder while probeFolder is in-flight keeps other-folder clean,
    // then switching back to aliasFolder re-attaches cleanly.
    let resolveProbe: ((reply: any) => void) | null = null;
    const propsB = {
      start: async () => ({ ok: true as const }),
      status: () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    };
    await act(async () => {
      root.render(createElement(Harness, { ...propsB, key: "alias-switch", activeFolder: "/work/alias-link" }));
    });
    let probePromise!: Promise<unknown>;
    await act(async () => {
      probePromise = tracker.probeFolder("/canonical/work/real-dir", "/work/alias-link");
    });
    await act(async () => {
      root.render(createElement(Harness, { ...propsB, key: "alias-switch", activeFolder: "/work/other-folder" }));
    });
    await act(async () => {
      resolveProbe!({ ok: true, run: runningCanonical });
      await probePromise;
    });
    assert.equal(tracker.activeRun, null, "other-folder stays clean when canonical/alias probeFolder settles");

    await act(async () => {
      root.render(createElement(Harness, { ...propsB, key: "alias-switch", activeFolder: "/work/alias-link" }));
    });
    assert.equal(tracker.activeRun?.runId, "run-symlink-1", "switching back to aliasFolder re-attaches cleanly");
  } finally {
    await act(async () => { root.unmount(); });
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
});
