/**
 * v0.6.0 W7 (ADR 0056): the onboarding wizard's client half. The server owns
 * every decision (test/surface-rpc.test.ts — the inspect and commit doors);
 * the client renders the four steps and carries the Owner's input between them.
 * The wizard's state machine is pure (`onboarding-state.ts`) so "back without
 * losing input" is asserted as behaviour, and the real `onboarding-wizard.tsx`
 * is mounted as markup for what an Owner sees at each step. Source-text pins
 * are limited to what Node cannot mount — the shell's host wiring.
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
  installPrerequisites: async () => ({ ok: true as const }),
  listDesigns: async () => ({ ok: true as const, projects: [] }),
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

test("back returns to the previous step without losing anything the Owner entered", async () => {
  const { initialWizard, reduceWizard } = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  let state = initialWizard(MACHINE_LANES);
  assert.equal(state.step, 1);
  state = reduceWizard(state, { type: "initGit", value: true });
  state = reduceWizard(state, { type: "next" });
  state = reduceWizard(state, { type: "next" });
  state = reduceWizard(state, { type: "lane", lane: "lead", value: "claude/opus-4-8:high" });
  state = reduceWizard(state, { type: "next" });
  assert.equal(state.step, 4);
  state = reduceWizard(state, { type: "design", design: { projectId: "owner-design", projectName: "Owner screens" } });
  state = reduceWizard(state, { type: "back" });
  state = reduceWizard(state, { type: "back" });
  state = reduceWizard(state, { type: "back" });
  assert.equal(state.step, 1);
  assert.equal(state.initGit, true);
  assert.equal(state.lanes.lead, "claude/opus-4-8:high");
  assert.equal("directive" in state, false, "wizard UI state no longer carries directive");
  assert.deepEqual(state.design, { projectId: "owner-design", projectName: "Owner screens" });
  assert.equal(reduceWizard(state, { type: "back" }).step, 1, "there is no step before the Folder");
  let last = state;
  for (let i = 0; i < 6; i++) last = reduceWizard(last, { type: "next" });
  assert.equal(last.step, 4, "there is no step after Start");
});

test("a step may advance only when its own question is settled: the Folder must be a usable repo (or Git offered), nothing running there", async () => {
  const { canAdvance, blockerOf } = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  assert.equal(canAdvance(1, null, false), false, "no inspection yet");
  assert.equal(canAdvance(1, readyInspection, false), true);
  assert.equal(canAdvance(1, { ...readyInspection, hasCommits: false }, false), true, "no commits is a warning, not a block");
  assert.equal(canAdvance(1, { ...readyInspection, gitRepo: false, hasCommits: false }, false), false, "a non-Git folder needs the Owner to accept git init");
  assert.equal(canAdvance(1, { ...readyInspection, gitRepo: false, hasCommits: false }, true), true);
  assert.equal(canAdvance(1, { ...readyInspection, existingLead: true }, true), false, "an existing Lead stops onboarding");
  assert.equal(canAdvance(1, { ...readyInspection, existingSupervisor: true }, true), false);
  assert.equal(blockerOf({ ...readyInspection, existingLead: true }), "lead-live");
  assert.equal(blockerOf({ ...readyInspection, existingSupervisor: true }), "supervisor-live");
  assert.equal(blockerOf(readyInspection), null);
  assert.equal(canAdvance(2, { ...readyInspection, missingPrerequisites: ["x"] }, false), true, "missing prerequisites warn but do not block");
  assert.equal(canAdvance(3, readyInspection, false), true);
});

test("the commit payload carries the folder, the three models, the design id — and initGit only when the folder is not a repo (with no UI directive)", async () => {
  const { initialWizard, reduceWizard, commitInputOf } = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  let state = initialWizard(MACHINE_LANES);
  state = reduceWizard(state, { type: "initGit", value: true });
  state = reduceWizard(state, { type: "design", design: { projectId: "owner-design", projectName: "Owner screens" } });
  assert.deepEqual(commitInputOf(state, readyInspection, "/work/my-app"), {
    folder: "/work/my-app",
    models: { supervisor: "claude/opus-4-8", lead: "pi/zcode/glm-5.3", worker: "pi/zcode/glm-5.3" },
    openDesignProjectId: "owner-design",
  }, "an existing repo never asks for git init");
  assert.deepEqual(commitInputOf(state, { ...readyInspection, gitRepo: false, hasCommits: false }, "/work/my-app").initGit, true);
  const bare = commitInputOf(initialWizard(MACHINE_LANES), readyInspection, "/work/my-app");
  assert.equal("directive" in bare, false, "no directive is emitted by the UI");
  assert.equal("openDesignProjectId" in bare, false);
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

  // Back/Next preserves profileId and profileModified.
  state = reduceWizard(state, { type: "next" });
  state = reduceWizard(state, { type: "lane", lane: "lead", value: "claude/opus-4-8:high" });
  assert.equal(state.profileId, "fast");
  assert.equal(state.profileModified, true);
  assert.equal(state.lanes.lead, "claude/opus-4-8:high");
  state = reduceWizard(state, { type: "back" });
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

// ---- the four steps, as an Owner sees them --------------------------------------------------

test("step 1 shows 'Step 1 of 4', the workspace folder (never a picker or a path box), the repo facts and Next — and no Back", async () => {
  const html = await render({ inspection: readyInspection });
  assert.match(html, /Step 1 of 4/);
  assert.match(html, /Folder/);
  assert.match(html, /\/work\/my-app/);
  assert.match(html, /Git repository/);
  assert.ok(hasHook(html, "factory-onboarding-next"));
  assert.equal(isDisabled(html, "factory-onboarding-next"), false);
  assert.equal(hasHook(html, "factory-onboarding-back"), false);
  assert.equal(hasHook(html, "factory-onboarding-start"), false);
  assert.doesNotMatch(html, /<input/, "the folder is the workspace's — no pasted path box");
  assert.doesNotMatch(html, /Browse|Choose folder|Paste/i);
});

test("step 1: a folder that is not a Git repo offers to initialise one and blocks Next until the Owner agrees; no commits is only a warning", async () => {
  const plain = { ...readyInspection, gitRepo: false, hasCommits: false };
  const before = await render({ inspection: plain });
  assert.ok(hasHook(before, "factory-onboarding-init-git"));
  assert.match(before, /not a Git repository/i);
  assert.ok(isDisabled(before, "factory-onboarding-next"), "Next waits for the Owner's yes");
  const agreed = await render({ inspection: plain, initGit: true });
  assert.equal(isDisabled(agreed, "factory-onboarding-next"), false);
  assert.match(agreed, /will be initialised/i);

  const unborn = await render({ inspection: { ...readyInspection, hasCommits: false } });
  assert.match(unborn, /No commits yet/);
  assert.equal(isDisabled(unborn, "factory-onboarding-next"), false);
});

test("step 1: a folder that already has a Lead stops onboarding — it says what is wrong and how to fix it, Next is disabled, there is a Re-check", async () => {
  const html = await render({ inspection: { ...readyInspection, existingLead: true } });
  assert.match(html, /A Lead is already running in this folder/);
  assert.ok(hasHook(html, "factory-onboarding-blocked"));
  assert.ok(isDisabled(html, "factory-onboarding-next"));
  assert.ok(hasHook(html, "factory-onboarding-recheck"));
  const sup = await render({ inspection: { ...readyInspection, existingSupervisor: true } });
  assert.match(sup, /A Supervisor is already live in this folder/);
  assert.ok(isDisabled(sup, "factory-onboarding-next"));
});

test("step 1: a failed inspection names the failure and offers Retry — never a spinner with nothing behind it", async () => {
  const html = await render({ inspectError: "cannot read the daemon's agents — check that Paseo is running" });
  assert.ok(hasHook(html, "factory-onboarding-error"));
  assert.match(html, /check that Paseo is running/);
  assert.ok(hasHook(html, "factory-onboarding-retry"));
  assert.ok(isDisabled(html, "factory-onboarding-next"));
});

test("step 2 lists every prerequisite with Install all while any is missing; with none missing there is nothing to install", async () => {
  const lacking = { ...readyInspection, prerequisites: [ready("a", "Core skills"), missing("b", "Expo skills", "Missing core skills: x")], missingPrerequisites: ["Expo skills"] };
  const html = await render({ step: 2, inspection: lacking });
  assert.match(html, /Step 2 of 4/);
  assert.match(html, /Prerequisites/);
  assert.match(html, /Core skills/);
  assert.match(html, /Expo skills/);
  assert.match(html, /Missing core skills: x/);
  assert.ok(hasHook(html, "factory-onboarding-install-all"));
  assert.ok(hasHook(html, "factory-onboarding-back"));
  assert.ok(hasHook(html, "factory-onboarding-next"));
  assert.equal(isDisabled(html, "factory-onboarding-next"), false, "missing prerequisites warn, they do not block");

  const clean = await render({ step: 2, inspection: readyInspection });
  assert.equal(hasHook(clean, "factory-onboarding-install-all"), false);
  assert.match(clean, /All required skills and tools are installed/);
});

test("step 2: a failed install says what went wrong and how to fix it", async () => {
  const lacking = { ...readyInspection, prerequisites: [missing("b", "Expo skills")], missingPrerequisites: ["Expo skills"] };
  const html = await render({ step: 2, inspection: lacking, installError: "npm exited 1" });
  assert.ok(hasHook(html, "factory-onboarding-error"));
  assert.match(html, /npm exited 1/);
  assert.match(html, /Settings/, "the fix points at the Settings screen");
});

test("step 3 shows the Supervisor, Lead and Worker models prefilled from the machine defaults, each changeable", async () => {
  const html = await render({ step: 3, inspection: readyInspection });
  assert.match(html, /Step 3 of 4/);
  assert.match(html, /Models/);
  for (const lane of ["supervisor", "lead", "worker"]) {
    assert.ok(hasHook(html, `factory-onboarding-lane-${lane}`), `${lane} row`);
    assert.ok(hasHook(html, `factory-onboarding-lane-change-${lane}`), `${lane} Change`);
  }
  assert.match(html, /claude\/opus-4-8/);
  assert.match(html, /pi\/zcode\/glm-5\.3/);
  assert.match(html, /machine defaults/i);
  assert.equal(hasHook(html, "factory-onboarding-lane-watch"), false, "only the three seats the Project starts on");
  assert.match(await render({ step: 3, inspection: readyInspection, lanes: { ...MACHINE_LANES, lead: "claude/opus-4-8:high" } }), /claude\/opus-4-8:high/, "a changed model shows");
});

test("step 4 omits First directive, offers an optional Open Design link and Start — with Back, and no Next — and explains direct Supervisor conversation", async () => {
  const html = await render({ step: 4, inspection: readyInspection });
  assert.match(html, /Step 4 of 4/);
  assert.equal(hasHook(html, "factory-onboarding-directive"), false, "First directive input is removed");
  assert.doesNotMatch(html, /First directive/i);
  assert.ok(hasHook(html, "factory-onboarding-od"));
  assert.ok(hasHook(html, "factory-onboarding-start"));
  assert.ok(hasHook(html, "factory-onboarding-back"));
  assert.equal(hasHook(html, "factory-onboarding-next"), false);
  assert.match(html, /sets up the Project and opens the Supervisor conversation directly/i);

  const linked = await render({ step: 4, inspection: readyInspection, design: { projectId: "d", projectName: "Owner screens" } });
  assert.match(linked, /Owner screens/);
});

test("a failed Start says what went wrong and how to fix it, and Start stays available to retry", async () => {
  const html = await render({ step: 4, inspection: readyInspection, startError: "Open Design link failed: not found — check the design project still exists in Open Design, then Start again" });
  assert.ok(hasHook(html, "factory-onboarding-error"));
  assert.match(html, /Open Design link failed/);
  assert.match(html, /then Start again/);
  assert.ok(hasHook(html, "factory-onboarding-start"));
  assert.equal(isDisabled(html, "factory-onboarding-start"), false);
});

test("step 4 checklist renders applicable-only phases with FACTORY_PALETTE status colours, elapsed seconds, >= 10s calm reassurance note, poll warning, and disabled Back/Start without Cancel", async () => {
  const t0 = Date.parse("2026-11-20T12:00:00.000Z");

  // Minimal config (existing Git repo, no Open Design): omits init-git and open-design.
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
  const under10s = await render({ step: 4, inspection: readyInspection, run: minimalRun, now: t0 + 5_000 });
  assert.ok(hasHook(under10s, "factory-onboarding-run-checklist"));
  assert.ok(hasHook(under10s, "factory-onboarding-phase-checking"));
  assert.equal(hasHook(under10s, "factory-onboarding-phase-init-git"), false, "init-git omitted when not needed");
  assert.ok(hasHook(under10s, "factory-onboarding-phase-register-and-lanes"));
  assert.equal(hasHook(under10s, "factory-onboarding-phase-open-design"), false, "open-design omitted when not linked");
  assert.ok(hasHook(under10s, "factory-onboarding-phase-start-supervisor"));
  assert.ok(hasHook(under10s, "factory-onboarding-phase-open-workspace"), "client open-workspace phase appended");
  assert.match(elementOf(under10s, "factory-onboarding-phase-start-supervisor"), /4s/);
  assert.equal(hasHook(under10s, "factory-onboarding-slow-note"), false, "no slow note under 10s");
  assert.ok(isDisabled(under10s, "factory-onboarding-back"), "Back disabled while running");
  assert.ok(isDisabled(under10s, "factory-onboarding-start"), "Start disabled while running");
  assert.equal(hasHook(under10s, "factory-onboarding-cancel"), false, "no Cancel button");
  assert.doesNotMatch(under10s, />Cancel</i, "no Cancel button label");

  // Status badge colours from FACTORY_PALETTE (light theme).
  assert.ok(elementOf(under10s, "factory-onboarding-phase-status-checking").includes("#337e58"), "done uses palette.ok");
  assert.ok(elementOf(under10s, "factory-onboarding-phase-status-start-supervisor").includes("#2f7899"), "running uses palette.lead");
  assert.ok(elementOf(under10s, "factory-onboarding-phase-status-open-workspace").includes("#677176"), "pending uses palette.idle");

  // At >= 10s elapsed (12s into start-supervisor) + pollWarning: renders calm neutral slow note and poll warning.
  const over10s = await render({
    step: 4,
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

  // Full config (init-git + open-design) + partial failure retains done/failed phases, exact error, and Retry + Back.
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
      { id: "open-design", label: "Linking Open Design", status: "done", startedAt: "2026-11-20T12:00:01.500Z", finishedAt: "2026-11-20T12:00:02.000Z", error: null },
      { id: "start-supervisor", label: "Starting Supervisor", status: "failed", startedAt: "2026-11-20T12:00:02.000Z", finishedAt: "2026-11-20T12:00:05.000Z", error: "Provider quota exceeded — check provider billing, then press Retry" },
    ],
  };
  const failedHtml = await render({ step: 4, inspection: readyInspection, run: failedRun });
  for (const id of ["checking", "init-git", "register-and-lanes", "open-design", "start-supervisor", "open-workspace"]) {
    assert.ok(hasHook(failedHtml, `factory-onboarding-phase-${id}`), `phase ${id} renders`);
  }
  assert.ok(elementOf(failedHtml, "factory-onboarding-phase-status-init-git").includes("#337e58"));
  assert.ok(elementOf(failedHtml, "factory-onboarding-phase-status-start-supervisor").includes("#c8253d"), "failed uses palette.bad");
  assert.match(elementOf(failedHtml, "factory-onboarding-phase-start-supervisor"), /Provider quota exceeded/);
  assert.ok(hasHook(failedHtml, "factory-onboarding-error"));
  assert.match(elementOf(failedHtml, "factory-onboarding-error"), /Provider quota exceeded/);
  assert.ok(hasHook(failedHtml, "factory-onboarding-run-retry"));
  assert.equal(isDisabled(failedHtml, "factory-onboarding-run-retry"), false);
  assert.equal(isDisabled(failedHtml, "factory-onboarding-back"), false);
});

test("01-badges: OnboardingWizard applies FACTORY_PALETTE to progress steps, Step 1–2 status badges, Step 3 seat/thinking pills, and Step 4 summary", async () => {
  const darkTheme = { colors: { ...theme.colors, surface0: "#000000" } };

  // Step 3 progress bar: steps 1 & 2 completed (ok), step 3 active (lead), step 4 pending (idle).
  const step3Light = await render({ step: 3, inspection: readyInspection, lanes: { ...MACHINE_LANES, lead: "claude/opus-4-8:high" } });
  assert.ok(hasHook(step3Light, "factory-onboarding-steps"));
  assert.ok(elementOf(step3Light, "factory-onboarding-step-pill-1").includes("#337e58"), "completed step 1 uses palette.ok");
  assert.ok(elementOf(step3Light, "factory-onboarding-step-pill-2").includes("#337e58"), "completed step 2 uses palette.ok");
  assert.ok(elementOf(step3Light, "factory-onboarding-step-pill-3").includes("#2f7899"), "active step 3 uses palette.lead");
  assert.ok(elementOf(step3Light, "factory-onboarding-step-pill-4").includes("#677176"), "pending step 4 uses palette.idle");

  // Step 3 seat colours & thinking pills across light/dark.
  assert.ok(elementOf(step3Light, "factory-onboarding-lane-supervisor").includes("#7459b4"), "Supervisor seat colour");
  assert.ok(elementOf(step3Light, "factory-onboarding-lane-lead").includes("#2f7899"), "Lead seat colour");
  assert.ok(elementOf(step3Light, "factory-onboarding-lane-worker").includes("#287a81"), "Worker uses peer seat colour");
  assert.match(elementOf(step3Light, "factory-onboarding-lane-worker"), />Worker</);
  assert.ok(elementOf(step3Light, "factory-onboarding-lane-thinking-lead").includes("#b23a98"), "high thinking pill uses thinking ramp");
  assert.match(elementOf(step3Light, "factory-onboarding-lane-thinking-lead"), />high</);

  const step3Dark = await render({ step: 3, inspection: readyInspection, lanes: { ...MACHINE_LANES, lead: "claude/opus-4-8:high" } }, { theme: darkTheme });
  assert.ok(elementOf(step3Dark, "factory-onboarding-step-pill-1").includes("#68b78d"));
  assert.ok(elementOf(step3Dark, "factory-onboarding-step-pill-3").includes("#5fa8cc"));
  assert.ok(elementOf(step3Dark, "factory-onboarding-lane-worker").includes("#5db3ba"));
  assert.ok(elementOf(step3Dark, "factory-onboarding-lane-thinking-lead").includes("#de54c1"));

  // Step 1 status badges: ok, wait, bad.
  const step1Ok = await render({ step: 1, inspection: readyInspection });
  assert.ok(elementOf(step1Ok, "factory-onboarding-git-badge").includes("#337e5818"), "Git ready uses ok badge");
  const step1Wait = await render({ step: 1, inspection: { ...readyInspection, gitRepo: false, hasCommits: false } });
  assert.ok(elementOf(step1Wait, "factory-onboarding-git-badge").includes("#8f680218"), "non-Git uses wait badge");
  const step1Bad = await render({ step: 1, inspection: { ...readyInspection, existingLead: true } });
  assert.ok(elementOf(step1Bad, "factory-onboarding-blocker-badge").includes("#c8253d18"), "blocker uses bad badge");

  // Step 2 status badges: ready (ok) and missing (wait).
  const step2Mixed = await render({ step: 2, inspection: { ...readyInspection, prerequisites: [ready("a", "Core skills"), missing("b", "Expo skills")], missingPrerequisites: ["Expo skills"] } });
  assert.ok(elementOf(step2Mixed, "factory-onboarding-prereq-badge-a").includes("#337e5818"));
  assert.ok(elementOf(step2Mixed, "factory-onboarding-prereq-badge-b").includes("#8f680218"));

  // Step 4 compact summary.
  const step4 = await render({ step: 4, inspection: readyInspection, design: { projectId: "d", projectName: "Owner screens" } });
  const summary = elementOf(step4, "factory-onboarding-summary");
  assert.match(summary, /\/work\/my-app/);
  assert.match(summary, /claude\/opus-4-8/);
  assert.match(summary, /pi\/zcode\/glm-5\.3/);
  assert.match(summary, /Owner screens/);
  assert.ok(summary.includes("#7459b4") && summary.includes("#2f7899") && summary.includes("#287a81"), "summary carries seat colours");
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

test("02-profiles: Step 3 renders Lane profile pills + Machine defaults, highlights active selection with FACTORY_PALETTE, and shows modified badge when a seat diverges", async () => {
  const profileView = { ...view, profiles: SAMPLE_PROFILES };

  // Default state: Machine defaults is selected.
  const defaultHtml = await render({ step: 3, inspection: readyInspection }, { view: profileView });
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profiles"));
  assert.match(defaultHtml, /Lane profile/);
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profile-machine-defaults"));
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profile-fast"));
  assert.ok(hasHook(defaultHtml, "factory-onboarding-profile-quality"));
  assert.match(elementOf(defaultHtml, "factory-onboarding-profile-machine-defaults"), /data-selected="true"/);
  assert.ok(elementOf(defaultHtml, "factory-onboarding-profile-machine-defaults").includes("#2f7899"), "active selection uses palette.lead");
  assert.match(elementOf(defaultHtml, "factory-onboarding-profile-fast"), /data-selected="false"/);
  assert.equal(hasHook(defaultHtml, "factory-onboarding-profile-modified"), false);

  // Selected profile state: prefills profile seats and does not mark them changed.
  const selectedHtml = await render({ step: 3, inspection: readyInspection, profileId: "fast" }, { view: profileView });
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
      step: 3,
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
      step: 3,
      inspection: readyInspection,
      profileId: "fast",
      profileModified: true,
      lanes: { ...SAMPLE_PROFILES[0]!.lanes, lead: "claude/opus-4-8:high" },
    },
    { theme: darkTheme, view: profileView },
  );
  assert.ok(elementOf(darkModifiedHtml, "factory-onboarding-profile-fast").includes("#5fa8cc"), "dark active profile uses palette.lead");
  assert.ok(elementOf(darkModifiedHtml, "factory-onboarding-profile-modified").includes("#cd9a2218"), "dark modified badge uses palette.wait");

  // Step 4 summary names the selected profile and modified marker.
  const step4Html = await render(
    {
      step: 4,
      inspection: readyInspection,
      profileId: "fast",
      profileModified: true,
      lanes: { ...SAMPLE_PROFILES[0]!.lanes, lead: "claude/opus-4-8:high" },
    },
    { view: profileView },
  );
  assert.match(elementOf(step4Html, "factory-onboarding-summary"), /Fast \(modified\)/);
});

test("02-profiles: clicking a profile pill prefills seats, Machine defaults resets, and Start submits profileId", async () => {
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
          initialUi: { step: 3, inspection: readyInspection },
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

    await click("factory-onboarding-profile-fast");
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-fast"]')?.getAttribute("data-selected"), "true");
    assert.match(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-supervisor"]')?.textContent ?? "", /claude\/sonnet-4-6/);

    await click("factory-onboarding-profile-machine-defaults");
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-machine-defaults"]')?.getAttribute("data-selected"), "true");
    assert.match(dom.window.document.querySelector('[data-testid="factory-onboarding-lane-supervisor"]')?.textContent ?? "", /claude\/opus-4-8/);

    await click("factory-onboarding-profile-fast");

    // Edit Lead thinking to High -> modified badge & Step 4 (modified) appear.
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
    await click("factory-onboarding-next");
    assert.match(dom.window.document.querySelector('[data-testid="factory-onboarding-summary"]')?.textContent ?? "", /Profile: Fast \(modified\)/);

    // Revert Lead back to Low -> modified badge & Step 4 (modified) disappear.
    await click("factory-onboarding-back");
    await click("factory-onboarding-lane-change-lead");
    const lowBtn = buttonNamed("Low");
    assert.ok(lowBtn, "Low thinking chip renders");
    await act(async () => { lowBtn.click(); });
    const saveBtn2 = buttonNamed("Save lane");
    assert.ok(saveBtn2, "Save lane button renders");
    await act(async () => { saveBtn2.click(); });
    assert.equal(dom.window.document.querySelector('[data-testid="factory-onboarding-profile-modified"]'), null, "modified badge clears when seat reverts to profile lane");
    await click("factory-onboarding-next");
    const summaryText = dom.window.document.querySelector('[data-testid="factory-onboarding-summary"]')?.textContent ?? "";
    assert.match(summaryText, /Profile: Fast/);
    assert.doesNotMatch(summaryText, /\(modified\)/);

    await click("factory-onboarding-start");
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

test("Step 4 async run polls status, tolerates transient poll errors, supports client-only open-workspace Retry, and supports server failure Retry/Back", async () => {
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
          initialUi: { step: 4, inspection: readyInspection, pollIntervalMs: 10 },
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
      q("factory-onboarding-start")!.click();
    });
    assert.equal(startCalls, 1);
    assert.ok(q("factory-onboarding-run-checklist"), "checklist renders immediately on async start");
    assert.equal((q("factory-onboarding-back") as HTMLButtonElement).disabled, true);
    assert.equal((q("factory-onboarding-start") as HTMLButtonElement).disabled, true);
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
    assert.equal((q("factory-onboarding-back") as HTMLButtonElement).disabled, false);

    // Clicking Retry retries ONLY finalize, never re-calling actions.start.
    finalizeShouldFail = false;
    await act(async () => {
      q("factory-onboarding-run-retry")!.click();
    });
    assert.equal(startCalls, 1, "client-only retry never re-calls actions.start");
    assert.equal(finalizeCalls, 2, "client-only retry calls actions.finalize again");
    assert.equal(q("factory-onboarding-phase-status-open-workspace")?.textContent, "done");
    assert.equal(q("factory-onboarding-error"), null);

    // 2. Server failure retains checklist, Retry re-invokes start, Back returns to Step 3.
    let serverStartCount = 0;
    const failedServerRun = {
      ...runningRun,
      runId: "run-fail-1",
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
          view,
          folder: "/work/other-app",
          initialUi: { step: 4, inspection: { ...readyInspection, folder: "/work/other-app" } },
          actions: {
            ...noopActions,
            start: async () => {
              serverStartCount += 1;
              return { ok: true as const, run: failedServerRun };
            },
          },
        }),
      );
    });
    await act(async () => {
      q("factory-onboarding-start")!.click();
    });
    assert.equal(serverStartCount, 1);
    assert.equal(q("factory-onboarding-phase-status-register-and-lanes")?.textContent, "done");
    assert.equal(q("factory-onboarding-phase-status-start-supervisor")?.textContent, "failed");
    assert.match(q("factory-onboarding-error")?.textContent ?? "", /Supervisor creation failed: invalid key/);

    await act(async () => {
      q("factory-onboarding-run-retry")!.click();
    });
    assert.equal(serverStartCount, 2, "Retry re-calls actions.start when server run failed");

    await act(async () => {
      q("factory-onboarding-back")!.click();
    });
    assert.match(q("factory-onboarding-progress")?.textContent ?? "", /Step 3 of 4/);

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

test("Step 4 live elapsed timer ticks every second and reveals neutral >= 10s reassurance note", async (t) => {
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
          initialUi: { step: 4, inspection: readyInspection, run: runningRun },
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
          initialUi: { step: 4, inspection: readyInspection },
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
      q("factory-onboarding-start")!.click();
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

test("OnboardingWizard automatically jumps to Step 4 and attaches when inspect + status find an in-flight running run for the canonical folder", async () => {
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
    assert.match(q("factory-onboarding-progress")?.textContent ?? "", /Step 4 of 4/);
    assert.ok(q("factory-onboarding-run-checklist"), "Step 4 checklist attaches immediately");
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
  assert.match(shell, /<OnboardingWizard/);
  assert.match(shell, /!mobile/, "the wizard is gated on the mobile flag");
  assert.match(shell, /navigation\?\.openAgent\(\{ agentId: result\.agentId/, "completing onboarding opens the Supervisor conversation directly");
  assert.doesNotMatch(shell, /projectAdd|pickFolder|projectPick/);
  const wizard = read("plugin/client/factory/onboarding-wizard.tsx");
  assert.doesNotMatch(wizard, /Start Lead|useRpc\((leadEnsure|leadDispatch)\)/, "the wizard starts the Supervisor and never a Lead");
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
    for (let i = 0; i < 10 && !q("factory-onboarding-next"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.ok(q("factory-onboarding"), "renders OnboardingWizard initially");

    // Step 1 -> 2 -> 3 -> 4 -> Start Supervisor.
    for (let s = 0; s < 3; s++) {
      await act(async () => { q("factory-onboarding-next")!.click(); });
    }
    await act(async () => { q("factory-onboarding-start")!.click(); });

    assert.equal(rpcCalls.some((c) => c.method === "factory.onboarding.commit"), false, "never calls legacy onboardingCommit");
    assert.ok(rpcCalls.some((c) => c.method === "factory.onboarding.start"), "calls onboardingStart");
    assert.ok(q("factory-onboarding-run-checklist"), "renders Step 4 checklist");

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
    assert.ok(q("factory-onboarding-run-checklist"), "re-attaches to Step 4 checklist even when isProject is already true with vacant Supervisor");
    assert.match(q("factory-onboarding-progress")?.textContent ?? "", /Step 4 of 4/);

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
    for (let i = 0; i < 10 && !q("factory-onboarding-next"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    assert.ok(q("factory-onboarding"), "renders OnboardingWizard initially");

    for (let s = 0; s < 3; s++) {
      await act(async () => { q("factory-onboarding-next")!.click(); });
    }
    await act(async () => { q("factory-onboarding-start")!.click(); });

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
