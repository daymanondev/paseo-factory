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
import { join } from "node:path";
import { repoRoot } from "./helpers.ts";
import { loadClientModule, testTheme } from "./client-markup.ts";
import type { PanelView } from "../plugin/shared/view.ts";

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
  state = reduceWizard(state, { type: "directive", value: "Build the login page." });
  state = reduceWizard(state, { type: "design", design: { projectId: "owner-design", projectName: "Owner screens" } });
  state = reduceWizard(state, { type: "back" });
  state = reduceWizard(state, { type: "back" });
  state = reduceWizard(state, { type: "back" });
  assert.equal(state.step, 1);
  assert.equal(state.initGit, true);
  assert.equal(state.lanes.lead, "claude/opus-4-8:high");
  assert.equal(state.directive, "Build the login page.");
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

test("the commit payload carries the folder, the three models, the trimmed directive, the design id — and initGit only when the folder is not a repo", async () => {
  const { initialWizard, reduceWizard, commitInputOf } = await loadClientModule("plugin/client/factory/onboarding-state.ts");
  let state = initialWizard(MACHINE_LANES);
  state = reduceWizard(state, { type: "initGit", value: true });
  state = reduceWizard(state, { type: "directive", value: "  Ship it.  \n" });
  state = reduceWizard(state, { type: "design", design: { projectId: "owner-design", projectName: "Owner screens" } });
  assert.deepEqual(commitInputOf(state, readyInspection, "/work/my-app"), {
    folder: "/work/my-app",
    models: { supervisor: "claude/opus-4-8", lead: "pi/zcode/glm-5.3", worker: "pi/zcode/glm-5.3" },
    openDesignProjectId: "owner-design",
    directive: "Ship it.",
  }, "an existing repo never asks for git init");
  assert.deepEqual(commitInputOf(state, { ...readyInspection, gitRepo: false, hasCommits: false }, "/work/my-app").initGit, true);
  const bare = commitInputOf(initialWizard(MACHINE_LANES), readyInspection, "/work/my-app");
  assert.equal("directive" in bare, false, "no directive, no first message");
  assert.equal("openDesignProjectId" in bare, false);
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

test("step 4 offers an optional directive and an optional Open Design link, and Start — with Back, and no Next", async () => {
  const html = await render({ step: 4, inspection: readyInspection });
  assert.match(html, /Step 4 of 4/);
  assert.ok(hasHook(html, "factory-onboarding-directive"));
  assert.ok(hasHook(html, "factory-onboarding-od"));
  assert.ok(hasHook(html, "factory-onboarding-start"));
  assert.ok(hasHook(html, "factory-onboarding-back"));
  assert.equal(hasHook(html, "factory-onboarding-next"), false);
  assert.match(html, /optional/i);
  assert.match(html, /Project panel/, "without a directive the wizard finishes on the Project panel");

  const withDirective = await render({ step: 4, inspection: readyInspection, directive: "Build it" });
  assert.match(withDirective, /first message/i);
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
    actions: { openAgent() {}, installPrerequisites() {}, handoffLead() {}, revokeSupervisor() {}, startSupervisor() {}, busy: false },
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

test("the shell builds the wizard on desktop only and drives it through the two onboarding RPCs — and the old paste-path door is not bound", () => {
  const shell = read("plugin/client/factory/shell.tsx");
  assert.match(shell, /useRpc\(onboardingInspect\)/);
  assert.match(shell, /useRpc\(onboardingCommit\)/);
  assert.match(shell, /<OnboardingWizard/);
  assert.match(shell, /!mobile/, "the wizard is gated on the mobile flag");
  assert.match(shell, /navigation\?\.openAgent\(\{ agentId: reply\.agentId/, "a directive opens the Supervisor conversation");
  assert.doesNotMatch(shell, /projectAdd|pickFolder|projectPick/);
  const wizard = read("plugin/client/factory/onboarding-wizard.tsx");
  assert.doesNotMatch(wizard, /Start Lead|useRpc\((leadEnsure|leadDispatch)\)/, "the wizard starts the Supervisor and never a Lead");
});
