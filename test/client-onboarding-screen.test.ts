/**
 * Ticket 04 (ADR 0063): Desktop-only global Onboarding entry, unregistered Paseo
 * Projects picker, visual Folder Browser backed by `onboardingBrowse`, and
 * inline `<OnboardingWizard />` mounting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./helpers.ts";
import { testTheme } from "./client-markup.ts";

type Exports = Record<string, any>;

interface LoadOptions {
  platformOs?: "web" | "ios" | "android";
}

async function loadScreenModule(entry: string, options: LoadOptions = {}): Promise<Exports> {
  const platformOs = options.platformOs ?? "web";
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
              const tag = (name) => ({ children, onPress, disabled, style, ...rest }) =>
                React.createElement(
                  name,
                  {
                    disabled,
                    onClick: onPress,
                    'data-testid': rest.testID,
                    'data-role': rest.accessibilityRole,
                    'aria-label': rest.accessibilityLabel,
                    'data-style': typeof style === 'object' && style !== null ? JSON.stringify(style) : undefined,
                  },
                  typeof children === 'function' ? children({ pressed: false }) : children,
                );
              exports.View = tag('div');
              exports.ScrollView = tag('div');
              exports.Text = tag('span');
              exports.Pressable = tag('button');
              exports.TextInput = ({ value, placeholder, onChangeText, onSubmitEditing, ...rest }) =>
                React.createElement('input', {
                  value: value ?? '',
                  placeholder,
                  'data-testid': rest.testID,
                  onChange: (event) => onChangeText && onChangeText(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter' && onSubmitEditing) onSubmitEditing(); },
                });
              exports.Icon = ({ name }) => React.createElement('span', { 'data-icon': name });
              exports.Loading = () => React.createElement('div', { 'data-testid': 'host-loading' }, 'Loading...');
              exports.SidebarRow = ({ id, icon, label, onPress, active }) =>
                React.createElement('button', {
                  'data-testid': id ? 'sidebar-row-' + id : 'sidebar-row',
                  'data-icon': icon,
                  'data-active': String(Boolean(active)),
                  onClick: onPress,
                }, label);
              exports.WorkspaceRowBadge = ({ label }) => React.createElement('span', {}, label);
              const Modal = ({ children, open, title }) => (open ? React.createElement('div', { 'data-modal-title': title }, children) : null);
              Modal.Content = tag('div');
              exports.Modal = Modal;
              exports.useRpc = (contract) => (input) => globalThis.__onboardScreenTestRpc(contract.name, input);
              exports.useWorkspace = () => '/project';
              exports.useWorkspaces = (query) => {
                const fn = globalThis.__onboardScreenTestWorkspaces;
                return fn ? fn(query) : [];
              };
              exports.useProjects = (query) => {
                const fn = globalThis.__onboardScreenTestProjects;
                return fn ? fn(query) : [];
              };
              exports.useProject = (ref) => {
                const fn = globalThis.__onboardScreenTestProject;
                return fn ? fn(ref) : null;
              };
              exports.usePaseo = () => {
                const fn = globalThis.__onboardScreenTestPaseo;
                return fn ? fn() : {
                  workspaces: {
                    list: async () => ({ entries: [] }),
                    create: async () => ({ id: 'ws-created-default' }),
                  },
                  projects: {
                    ref: () => ({ createWorkspace: async () => ({ id: 'ws-project-default' }) }),
                  },
                };
              };
              exports.useToast = () => ({
                show(msg, opts) { globalThis.__onboardScreenTestToasts?.push({ msg, opts }); },
                error(msg) { globalThis.__onboardScreenTestToasts?.push({ msg, error: true }); },
              });
              exports.openExternalUrl = async () => {};
              exports.Platform = {
                OS: ${JSON.stringify(platformOs)},
                select: (spec) => (spec[${JSON.stringify(platformOs)}] !== undefined ? spec[${JSON.stringify(platformOs)}] : spec.default),
              };
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

async function mountDom<T>(run: (createRoot: typeof import("react-dom/client").createRoot, container: HTMLElement, act: (fn: () => void | Promise<void>) => Promise<void>) => Promise<T>): Promise<T> {
  const { JSDOM } = (await import(["jsdom"].join(""))) as { JSDOM: new (html: string) => { window: any } };
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
  g.window = dom.window;
  g.document = dom.window.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  try {
    return await run(createRoot, dom.window.document.getElementById("root")!, (fn) => act(async () => { await fn(); }));
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    g.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
}

test("contribute registers desktop-only sidebar footer, global Command Center item, and onboard screen; mobile registers none of them", async () => {
  const makeMockClient = () => {
    const sidebarFooterItems: any[] = [];
    const screens: any[] = [];
    const commandItems: any[] = [];
    const workspacePanels: any[] = [];
    const settingsScreens: any[] = [];
    const openedScreens: any[] = [];
    return {
      sidebarFooterItems,
      screens,
      commandItems,
      workspacePanels,
      settingsScreens,
      openedScreens,
      client: {
        addWorkspacePanel: (c: any) => { workspacePanels.push(c); return () => {}; },
        addSettingsScreen: (c: any) => { settingsScreens.push(c); return () => {}; },
        addSidebarFooterItem: (c: any) => { sidebarFooterItems.push(c); return () => {}; },
        addScreen: (c: any) => { screens.push(c); return () => {}; },
        addCommandCenterItem: (c: any) => { commandItems.push(c); return () => {}; },
        addHeaderButton: () => ({ update() {}, remove() {} }),
        addComposerPill: () => ({ update() {}, remove() {} }),
        addWorkspaceRowBadgeItem: () => () => {},
        subscribe: () => ({ unsubscribe() {} }),
        rpc: async () => ({ ok: true, daemonError: null, projects: [], seats: [] }),
        openPanel: () => {},
        openSettings: () => {},
        openScreen: (input: any) => openedScreens.push(input),
      },
    };
  };

  // Desktop ("web"): registers global onboarding entry points.
  const desktop = await loadScreenModule("plugin/index.client.tsx", { platformOs: "web" });
  const webMock = makeMockClient();
  const offWeb = desktop.default(webMock.client);
  try {
    assert.equal(webMock.sidebarFooterItems.length, 1);
    assert.equal(webMock.sidebarFooterItems[0].id, "paseo-factory-onboard");
    assert.equal(webMock.sidebarFooterItems[0].title, "Onboard Project");
    assert.equal(webMock.screens.length, 1);
    assert.equal(webMock.screens[0].id, "paseo-factory-onboard");
    const globalCmd = webMock.commandItems.find((c) => c.context === "global");
    assert.ok(globalCmd, "global Command Center item is registered on desktop");
    assert.equal(globalCmd.id, "factory-onboard-project");
    assert.equal(globalCmd.title, "Factory: Onboard Project");
    globalCmd.onSelect({ openScreen: webMock.client.openScreen });
    assert.deepEqual(webMock.openedScreens, [{ screenId: "paseo-factory-onboard" }]);
  } finally {
    offWeb();
  }

  // Mobile ("ios" and "android"): omits global onboarding registrations.
  for (const os of ["ios", "android"] as const) {
    const mobile = await loadScreenModule("plugin/index.client.tsx", { platformOs: os });
    const mobMock = makeMockClient();
    const offMob = mobile.default(mobMock.client);
    try {
      assert.equal(mobMock.sidebarFooterItems.length, 0, `${os} does not register sidebar footer item`);
      assert.equal(mobMock.screens.length, 0, `${os} does not register onboarding screen`);
      assert.equal(mobMock.commandItems.filter((c) => c.context === "global").length, 0, `${os} does not register global onboard command`);
    } finally {
      offMob();
    }
  }
});

test("isFactoryRegisteredRoot normalizes trailing slashes when filtering unregistered Paseo Projects", async () => {
  const { isFactoryRegisteredRoot } = await loadScreenModule("plugin/client/factory/onboarding-screen.tsx", { platformOs: "web" });
  const registered = [{ root: "/work/alpha/" }, { root: "/work/beta" }];
  assert.equal(isFactoryRegisteredRoot("/work/alpha", registered), true);
  assert.equal(isFactoryRegisteredRoot("/work/beta/", registered), true);
  assert.equal(isFactoryRegisteredRoot("/work/gamma", registered), false);
  assert.equal(isFactoryRegisteredRoot("/", [{ root: "/" }]), true);
});

const MACHINE_LANES = {
  supervisor: "claude/opus-4-8",
  lead: "pi/zcode/glm-5.3",
  worker: "pi/zcode/glm-5.3",
  watch: "pi/zcode/glm-5.3",
  freshEyes: "pi/zcode/glm-5.3",
};

function makeSnapshotView() {
  return {
    lanes: MACHINE_LANES,
    machineLanes: MACHINE_LANES,
    providers: [{ provider: "claude", available: true, models: [] }, { provider: "pi", available: true, models: [] }],
    profiles: [],
    panel: { isProject: false },
  };
}

test("FactoryOnboardSidebarItem and FactoryOnboardScreen render on desktop and return null on mobile without calling RPCs", async () => {
  const entries = await loadScreenModule("plugin/client/factory/entries.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const opened: any[] = [];
  await mountDom(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          createElement(entries.FactoryOnboardSidebarItem, {
            theme: testTheme,
            host: { id: "h1", label: "Local" },
            layout: { compact: false, platform: "web" },
            currentScreen: null,
            openScreen: (input: any) => opened.push(input),
            openPopover: () => {},
          }),
        ),
      );
      const row = container.querySelector('[data-testid="sidebar-row"]') as HTMLElement;
      assert.ok(row, "desktop renders SidebarRow");
      assert.match(row.textContent!, /Onboard Project/);
      await act(() => row.click());
      assert.deepEqual(opened, [{ screenId: "paseo-factory-onboard" }]);

      for (const platform of ["ios", "android"] as const) {
        await act(() =>
          root.render(
            createElement(entries.FactoryOnboardSidebarItem, {
              theme: testTheme,
              host: { id: "h1", label: "Local" },
              layout: { compact: true, platform },
              currentScreen: null,
              openScreen: (input: any) => opened.push(input),
              openPopover: () => {},
            }),
          ),
        );
        assert.equal(container.innerHTML, "", `${platform} sidebar item renders null`);
      }

      const rpcCalls: string[] = [];
      (globalThis as any).__onboardScreenTestRpc = async (name: string) => {
        rpcCalls.push(name);
        return { ok: true };
      };
      (globalThis as any).__onboardScreenTestProjects = () => [];
      (globalThis as any).__onboardScreenTestProject = () => null;
      await act(() =>
        root.render(
          createElement(entries.FactoryOnboardScreen, {
            theme: testTheme,
            host: { id: "h1", label: "Local" },
            layout: { compact: true, platform: "ios" },
            params: {},
          }),
        ),
      );
      assert.equal(container.innerHTML, "", "mobile screen wrapper renders null");
      assert.deepEqual(rpcCalls, [], "mobile triggers zero RPCs");
    } finally {
      await act(() => root.unmount());
      delete (globalThis as any).__onboardScreenTestRpc;
      delete (globalThis as any).__onboardScreenTestProjects;
      delete (globalThis as any).__onboardScreenTestProject;
    }
  });
});

test("OnboardingScreen filters unregistered Paseo Projects, supports 1-click selection, and mounts OnboardingWizard inline without mutating disk", async () => {
  const { OnboardingScreen } = await loadScreenModule("plugin/client/factory/onboarding-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const projects = [
    {
      ref: { kind: "project", key: "h1:p-reg", hostId: "h1", id: "p-reg" },
      hostId: "h1",
      displayName: "Already Registered",
      rootPath: "/Users/owner/work/registered-app/",
      kind: "git",
      iconRevision: null,
    },
    {
      ref: { kind: "project", key: "h1:p-new", hostId: "h1", id: "p-new" },
      hostId: "h1",
      displayName: "Brand New App",
      rootPath: "/Users/owner/work/new-app",
      kind: "non_git",
      iconRevision: null,
    },
  ];

  const rpcCalls: { name: string; input: any }[] = [];
  (globalThis as any).__onboardScreenTestProjects = (query: any) =>
    projects.filter((p) => (!query?.hosts || query.hosts.includes(p.hostId)) && (!query?.where || query.where(p))).map((p) => p.ref);
  (globalThis as any).__onboardScreenTestProject = (ref: any) =>
    projects.find((p) => p.ref.key === ref.key) ?? null;
  (globalThis as any).__onboardScreenTestRpc = async (name: string, input: any) => {
    rpcCalls.push({ name, input });
    if (name === "factory.seats.directory") {
      return { ok: true, daemonError: null, seats: [], projects: [{ slug: "registered-app", root: "/Users/owner/work/registered-app", workspaceId: "ws-1", needsYouCount: 0 }] };
    }
    if (name === "factory.snapshot") {
      return { ok: true, view: makeSnapshotView() };
    }
    if (name === "factory.onboarding.browse") {
      return {
        ok: true,
        path: "/Users/owner",
        parent: "/Users",
        home: "/Users/owner",
        entries: [{ name: "work", path: "/Users/owner/work", gitRepo: false }],
      };
    }
    if (name === "factory.onboarding.inspect") {
      return {
        ok: true,
        folder: input.folder,
        gitRepo: false,
        hasCommits: false,
        registered: false,
        existingLead: false,
        existingSupervisor: false,
        prerequisites: [],
        missingPrerequisites: [],
      };
    }
    return { ok: false, error: `unexpected rpc ${name}` };
  };

  await mountDom(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          createElement(OnboardingScreen, {
            theme: testTheme,
            host: { id: "h1", label: "Local" },
            layout: { compact: false, platform: "web" },
            params: {},
          }),
        ),
      );
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));

      const projectsBox = container.querySelector('[data-testid="factory-onboard-projects"]');
      assert.ok(projectsBox, "renders unregistered projects section");
      assert.equal(container.querySelector('[data-testid="factory-onboard-project-p-reg"]'), null, "registered Paseo Project is filtered out");
      const newBtn = container.querySelector('[data-testid="factory-onboard-project-p-new"]') as HTMLElement;
      assert.ok(newBtn, "unregistered Paseo Project renders");
      assert.match(newBtn.textContent!, /Brand New App/);
      assert.match(newBtn.textContent!, /\/Users\/owner\/work\/new-app/);
      const folderBadge = newBtn.querySelector('[data-testid="factory-onboard-project-badge-p-new"]') as HTMLElement | null;
      assert.ok(folderBadge, "project row renders ToneBadge with testID");
      assert.match(folderBadge.textContent!, /^Folder$/);
      assert.match(folderBadge.getAttribute("data-style") ?? "", /"borderRadius":999/);
      assert.match(folderBadge.getAttribute("data-style") ?? "", /#67717618/);

      // 1-click selection mounts OnboardingWizard inline and runs inspect, never commit.
      await act(() => newBtn.click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));

      assert.ok(container.querySelector('[data-testid="factory-onboarding"]'), "OnboardingWizard mounts inline");
      assert.match(container.querySelector('[data-testid="factory-onboard-selected-folder"]')!.textContent!, /\/Users\/owner\/work\/new-app/);
      assert.ok(rpcCalls.some((c) => c.name === "factory.onboarding.inspect" && c.input.folder === "/Users/owner/work/new-app"));
      assert.equal(rpcCalls.some((c) => c.name === "factory.onboarding.commit"), false, "no commit mutation before Step 4 Start");

      // Change folder returns to the picker.
      const changeBtn = container.querySelector('[data-testid="factory-onboard-change-folder"]') as HTMLElement;
      assert.ok(changeBtn);
      await act(() => changeBtn.click());
      assert.equal(container.querySelector('[data-testid="factory-onboarding"]'), null);
      assert.ok(container.querySelector('[data-testid="factory-onboard-browse"]'));
    } finally {
      await act(() => root.unmount());
      delete (globalThis as any).__onboardScreenTestRpc;
      delete (globalThis as any).__onboardScreenTestProjects;
      delete (globalThis as any).__onboardScreenTestProject;
    }
  });
});

test("Visual Folder Browser starts at $HOME, traverses subdirectories and parent, jumps by path input, surfaces browse errors, and selects folder into a fresh OnboardingWizard", async () => {
  const { OnboardingScreen } = await loadScreenModule("plugin/client/factory/onboarding-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const rpcCalls: { name: string; input: any }[] = [];
  (globalThis as any).__onboardScreenTestProjects = () => [];
  (globalThis as any).__onboardScreenTestProject = () => null;
  (globalThis as any).__onboardScreenTestRpc = async (name: string, input: any) => {
    rpcCalls.push({ name, input });
    if (name === "factory.seats.directory") {
      return { ok: true, daemonError: null, seats: [], projects: [] };
    }
    if (name === "factory.snapshot") {
      return { ok: true, view: makeSnapshotView() };
    }
    if (name === "factory.onboarding.browse") {
      const target = input?.path;
      if (!target || target === "/Users/owner") {
        return {
          ok: true,
          path: "/Users/owner",
          parent: "/Users",
          home: "/Users/owner",
          entries: [
            { name: "repos", path: "/Users/owner/repos", gitRepo: false },
            { name: "dotfiles", path: "/Users/owner/dotfiles", gitRepo: true },
          ],
        };
      }
      if (target === "/Users/owner/repos") {
        return {
          ok: true,
          path: "/Users/owner/repos",
          parent: "/Users/owner",
          home: "/Users/owner",
          entries: [{ name: "my-repo", path: "/Users/owner/repos/my-repo", gitRepo: true }],
        };
      }
      if (target === "/Users") {
        return {
          ok: true,
          path: "/Users",
          parent: "/",
          home: "/Users/owner",
          entries: [{ name: "owner", path: "/Users/owner", gitRepo: false }],
        };
      }
      if (target === "/Users/owner/repos/my-repo") {
        return {
          ok: true,
          path: "/Users/owner/repos/my-repo",
          parent: "/Users/owner/repos",
          home: "/Users/owner",
          entries: [],
        };
      }
      return { ok: false, code: "missing-directory", error: `${target} does not exist on disk` };
    }
    if (name === "factory.onboarding.inspect") {
      return {
        ok: true,
        folder: input.folder,
        gitRepo: true,
        hasCommits: true,
        registered: false,
        existingLead: false,
        existingSupervisor: false,
        prerequisites: [],
        missingPrerequisites: [],
      };
    }
    return { ok: false, error: `unexpected rpc ${name}` };
  };

  await mountDom(async (createRoot, container, act) => {
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          createElement(OnboardingScreen, {
            theme: testTheme,
            host: { id: "h1", label: "Local" },
            layout: { compact: false, platform: "web" },
            params: {},
          }),
        ),
      );
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));

      // Started at $HOME.
      assert.equal(container.querySelector('[data-testid="factory-onboard-current-path"]')?.textContent, "/Users/owner");
      const dotfilesRow = container.querySelector('[data-testid="factory-onboard-entry-dotfiles"]') as HTMLElement;
      assert.ok(dotfilesRow);
      assert.match(dotfilesRow.textContent!, /Git/, "gitRepo entries show Git indicator");
      const gitBadge = dotfilesRow.querySelector('[data-testid="factory-onboard-entry-badge-dotfiles"]') as HTMLElement | null;
      assert.ok(gitBadge, "git browse entry renders ToneBadge with testID");
      assert.match(gitBadge.getAttribute("data-style") ?? "", /"borderRadius":999/);
      assert.match(gitBadge.getAttribute("data-style") ?? "", /#337e5818/);

      // Click subdirectory `repos`.
      await act(() => (container.querySelector('[data-testid="factory-onboard-entry-repos"]') as HTMLElement).click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));
      assert.equal(container.querySelector('[data-testid="factory-onboard-current-path"]')?.textContent, "/Users/owner/repos");
      assert.ok(container.querySelector('[data-testid="factory-onboard-entry-my-repo"]'));

      // Parent traversal goes back to /Users/owner, and again to /Users.
      await act(() => (container.querySelector('[data-testid="factory-onboard-parent"]') as HTMLElement).click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));
      assert.equal(container.querySelector('[data-testid="factory-onboard-current-path"]')?.textContent, "/Users/owner");

      // Quick path jump: invalid path shows error without losing current folder.
      const inputEl = container.querySelector('[data-testid="factory-onboard-path-input"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(inputEl.ownerDocument.defaultView!.HTMLInputElement.prototype, "value")!.set!;
      await act(() => {
        setter.call(inputEl, "/does/not/exist");
        inputEl.dispatchEvent(new inputEl.ownerDocument.defaultView!.Event("input", { bubbles: true }));
      });
      await act(() => (container.querySelector('[data-testid="factory-onboard-path-go"]') as HTMLElement).click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));
      assert.match(container.querySelector('[data-testid="factory-onboard-browse-error"]')!.textContent!, /does not exist/);
      assert.equal(container.querySelector('[data-testid="factory-onboard-current-path"]')?.textContent, "/Users/owner", "previous browse view remains intact on error");

      // Quick path jump to valid repo path.
      await act(() => {
        setter.call(inputEl, "/Users/owner/repos/my-repo");
        inputEl.dispatchEvent(new inputEl.ownerDocument.defaultView!.Event("input", { bubbles: true }));
      });
      await act(() => (container.querySelector('[data-testid="factory-onboard-path-go"]') as HTMLElement).click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));
      assert.equal(container.querySelector('[data-testid="factory-onboard-current-path"]')?.textContent, "/Users/owner/repos/my-repo");

      // Select this folder mounts OnboardingWizard inline and inspects it.
      await act(() => (container.querySelector('[data-testid="factory-onboard-select-folder"]') as HTMLElement).click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));
      assert.ok(container.querySelector('[data-testid="factory-onboarding"]'));
      assert.ok(rpcCalls.some((c) => c.name === "factory.onboarding.inspect" && c.input.folder === "/Users/owner/repos/my-repo"));
      assert.equal(rpcCalls.some((c) => c.name === "factory.onboarding.commit"), false);

      // Change folder -> switch to /Users/owner -> re-inspects the new folder cleanly.
      await act(() => (container.querySelector('[data-testid="factory-onboard-change-folder"]') as HTMLElement).click());
      await act(() => (container.querySelector('[data-testid="factory-onboard-parent"]') as HTMLElement).click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));
      await act(() => (container.querySelector('[data-testid="factory-onboard-select-folder"]') as HTMLElement).click());
      await act(() => new Promise<void>((r) => setTimeout(r, 10)));
      assert.ok(rpcCalls.some((c) => c.name === "factory.onboarding.inspect" && c.input.folder === "/Users/owner/repos"));
    } finally {
      await act(() => root.unmount());
      delete (globalThis as any).__onboardScreenTestRpc;
      delete (globalThis as any).__onboardScreenTestProjects;
      delete (globalThis as any).__onboardScreenTestProject;
    }
  });
});

test("OnboardingScreen mounts safely under an RN-like window on iOS/Android with zero RPCs and no DOM globals", async () => {
  const { OnboardingScreen } = await loadScreenModule("plugin/client/factory/onboarding-screen.tsx", { platformOs: "ios" });
  const { createElement } = await import("react");
  const rpcCalls: string[] = [];
  (globalThis as any).__onboardScreenTestRpc = async (name: string) => {
    rpcCalls.push(name);
    return { ok: true };
  };
  (globalThis as any).__onboardScreenTestProjects = () => [];
  (globalThis as any).__onboardScreenTestProject = () => null;
  await mountDom(async (createRoot, container, act) => {
    const w = (globalThis as Record<string, any>).window;
    for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
      Object.defineProperty(w, key, { value: undefined, configurable: true, writable: true });
    }
    delete (globalThis as Record<string, unknown>).document;
    const root = createRoot(container);
    try {
      for (const platform of ["ios", "android"] as const) {
        await act(() =>
          root.render(
            createElement(OnboardingScreen, {
              theme: testTheme,
              host: { id: "h1", label: "Local" },
              layout: { compact: true, platform },
              params: {},
            }),
          ),
        );
        assert.match(container.innerHTML, /data-testid="factory-onboard-mobile"/, `${platform} shows safe desktop-only notice`);
        assert.doesNotMatch(container.innerHTML, /data-testid="factory-onboard-browse"|data-testid="factory-onboarding"/);
        assert.deepEqual(rpcCalls, [], `${platform} issues zero RPCs`);
      }
    } finally {
      await act(() => root.unmount());
      delete (globalThis as any).__onboardScreenTestRpc;
      delete (globalThis as any).__onboardScreenTestProjects;
      delete (globalThis as any).__onboardScreenTestProject;
    }
  });
});

test("05-commit: isReusableLocalWorkspace reuses active non-worktree local workspaces and excludes worktrees, archiving workspaces, and mismatched roots", async () => {
  const { isReusableLocalWorkspace, selectReusableWorkspace, filterUnregisteredProjects } = await loadScreenModule(
    "plugin/client/factory/onboarding-targets.ts",
    { platformOs: "web" },
  );
  assert.equal(typeof isReusableLocalWorkspace, "function");
  assert.equal(
    isReusableLocalWorkspace(
      { id: "ws-local", directory: "/Users/owner/work/app/", kind: "local_checkout", archivingAt: null },
      "/Users/owner/work/app",
    ),
    true,
  );
  assert.equal(
    isReusableLocalWorkspace(
      { id: "ws-dir", workspaceDirectory: "/Users/owner/work/app", workspaceKind: "directory", archivingAt: null },
      "/Users/owner/work/app/",
    ),
    true,
  );
  assert.equal(
    isReusableLocalWorkspace(
      { id: "ws-wt", directory: "/Users/owner/work/app", kind: "worktree", archivingAt: null },
      "/Users/owner/work/app",
    ),
    false,
    "worktree workspace is never reused as the local workspace",
  );
  assert.equal(
    isReusableLocalWorkspace(
      { id: "ws-arch", directory: "/Users/owner/work/app", kind: "local_checkout", archivingAt: "2026-11-18T00:00:00Z" },
      "/Users/owner/work/app",
    ),
    false,
    "archiving workspace is not reused",
  );
  assert.equal(
    isReusableLocalWorkspace(
      { id: "ws-internal", directory: "/Users/owner/work/app", kind: "directory", archivingAt: null, internal: true },
      "/Users/owner/work/app",
    ),
    false,
  );
  assert.equal(
    isReusableLocalWorkspace(
      { id: "ws-other", directory: "/Users/owner/work/other", kind: "local_checkout", archivingAt: null },
      "/Users/owner/work/app",
    ),
    false,
  );
  assert.equal(
    isReusableLocalWorkspace(
      { id: "ws-bogus", directory: "/Users/owner/work/app", kind: "local" as any, archivingAt: null },
      "/Users/owner/work/app",
    ),
    false,
    "rejects non-SDK kind values",
  );
  assert.equal(
    selectReusableWorkspace(
      [
        { id: "ws-dir", workspaceDirectory: "/Users/owner/work/app", workspaceKind: "directory", archivingAt: null },
        { id: "ws-local", workspaceDirectory: "/Users/owner/work/app", workspaceKind: "local_checkout", archivingAt: null },
      ],
      "/Users/owner/work/app",
    )?.id,
    "ws-local",
  );
  assert.deepEqual(
    filterUnregisteredProjects([{ rootPath: "/a/" }, { rootPath: "/b" }], [{ root: "/a" }]),
    [{ rootPath: "/b" }],
  );
});

test("OnboardingScreen renders factory-onboard-retry when snapshot fails and retries on press", async () => {
  const { OnboardingScreen } = await loadScreenModule("plugin/client/factory/onboarding-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  let snapshotCalls = 0;
  (globalThis as any).__onboardScreenTestProjects = () => [];
  (globalThis as any).__onboardScreenTestProject = () => null;
  (globalThis as any).__onboardScreenTestRpc = async (name: string, input: any) => {
    if (name === "factory.seats.directory") return { ok: true, daemonError: null, seats: [], projects: [] };
    if (name === "factory.snapshot") {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return { ok: false, error: "daemon busy" };
      return { ok: true, view: makeSnapshotView() };
    }
    if (name === "factory.onboarding.browse") return { ok: true, path: "/Users/owner/app", parent: "/Users/owner", home: "/Users/owner", entries: [] };
    if (name === "factory.onboarding.inspect") {
      return { ok: true, folder: input.folder, gitRepo: true, hasCommits: true, registered: false, existingLead: false, existingSupervisor: false, prerequisites: [], missingPrerequisites: [] };
    }
    return { ok: false, error: `unexpected ${name}` };
  };

  try {
    await mountDom(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        await act(() =>
          root.render(
            createElement(OnboardingScreen, {
              theme: testTheme,
              host: { id: "h1", label: "Local" },
              layout: { compact: false, platform: "web" },
              params: { folder: "/Users/owner/app" },
            }),
          ),
        );
        await act(() => new Promise<void>((r) => setTimeout(r, 10)));

        const retryBtn = container.querySelector('[data-testid="factory-onboard-retry"]') as HTMLElement | null;
        assert.ok(retryBtn, "Retry button exposes testID factory-onboard-retry");
        await act(() => retryBtn.click());
        await act(() => new Promise<void>((r) => setTimeout(r, 10)));

        assert.equal(snapshotCalls, 2);
        assert.ok(container.querySelector('[data-testid="factory-onboarding"]'), "wizard mounts after successful retry");
      } finally {
        await act(() => root.unmount());
      }
    });
  } finally {
    delete (globalThis as any).__onboardScreenTestRpc;
    delete (globalThis as any).__onboardScreenTestProjects;
    delete (globalThis as any).__onboardScreenTestProject;
  }
});

async function runWizardStepsToCommit(
  container: HTMLElement,
  act: (fn: () => void | Promise<void>) => Promise<void>,
  options: {
    initGit?: boolean;
    profileId?: string;
    directive?: string;
  } = {},
) {
  const click = async (testId: string) => {
    const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    assert.ok(el, `missing ${testId}`);
    await act(() => el.click());
    await act(() => new Promise<void>((r) => setTimeout(r, 10)));
  };

  if (options.initGit) {
    await click("factory-onboarding-init-git");
  }
  await click("factory-onboarding-next"); // -> Step 2
  await click("factory-onboarding-next"); // -> Step 3
  if (options.profileId) {
    await click(`factory-onboarding-profile-${options.profileId}`);
  }
  await click("factory-onboarding-next"); // -> Step 4
  if (options.directive !== undefined) {
    const textarea = container.querySelector('[data-testid="factory-onboarding-directive"]') as HTMLInputElement | HTMLTextAreaElement;
    assert.ok(textarea, "missing directive input");
    const proto = textarea.tagName === "TEXTAREA"
      ? textarea.ownerDocument.defaultView!.HTMLTextAreaElement.prototype
      : textarea.ownerDocument.defaultView!.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    await act(() => {
      setter.call(textarea, options.directive!);
      textarea.dispatchEvent(new textarea.ownerDocument.defaultView!.Event("input", { bubbles: true }));
    });
  }
  await click("factory-onboarding-start");
}

test("05-commit: Step 4 Start reuses an existing active local workspace and opens workspace + Factory panel when no directive is entered", async () => {
  const desktop = await loadScreenModule("plugin/index.client.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const projects = [
    {
      ref: { kind: "project", key: "h1:p-new", hostId: "h1", id: "p-new" },
      hostId: "h1",
      displayName: "New App",
      rootPath: "/Users/owner/work/new-app",
      kind: "non_git",
      iconRevision: null,
    },
  ];
  const workspaces = [
    { id: "ws-wt-1", hostId: "h1", directory: "/Users/owner/work/new-app", kind: "worktree", archivingAt: null },
    { id: "ws-arch-1", hostId: "h1", directory: "/Users/owner/work/new-app", kind: "local_checkout", archivingAt: "2026-11-18T00:00:00Z" },
    { id: "ws-active-local", hostId: "h1", directory: "/Users/owner/work/new-app/", kind: "local_checkout", archivingAt: null },
  ];

  const rpcCalls: { name: string; input: any }[] = [];
  const createWorkspaceCalls: any[] = [];
  const openedPanels: any[] = [];
  const openedWorkspaces: any[] = [];
  const openedAgents: any[] = [];
  let RegisteredScreen: any;

  const off = desktop.default({
    addWorkspacePanel: () => () => {},
    addSettingsScreen: () => () => {},
    addSidebarFooterItem: () => () => {},
    addScreen: (c: any) => { RegisteredScreen = c.Component; return () => {}; },
    addCommandCenterItem: () => () => {},
    addHeaderButton: () => ({ update() {}, remove() {} }),
    addComposerPill: () => ({ update() {}, remove() {} }),
    addWorkspaceRowBadgeItem: () => () => {},
    subscribe: () => ({ unsubscribe() {} }),
    rpc: async () => ({ ok: true, daemonError: null, projects: [], seats: [] }),
    openPanel: (id: string, options: any) => openedPanels.push({ id, options }),
    openSettings: () => {},
    openScreen: () => {},
  });

  (globalThis as any).__onboardScreenTestProjects = (query: any) =>
    projects.filter((p) => (!query?.hosts || query.hosts.includes(p.hostId)) && (!query?.where || query.where(p))).map((p) => p.ref);
  (globalThis as any).__onboardScreenTestProject = (ref: any) =>
    projects.find((p) => p.ref.key === ref.key) ?? null;
  (globalThis as any).__onboardScreenTestWorkspaces = (query: any) =>
    workspaces
      .filter((w) => (!query?.hosts || query.hosts.includes(w.hostId)) && (!query?.where || query.where(w)))
      .map((w) => ({ kind: "workspace", key: `h1:${w.id}`, hostId: w.hostId, id: w.id }));
  (globalThis as any).__onboardScreenTestPaseo = () => ({
    workspaces: {
      list: async () => ({ entries: [] }),
      create: async (opts: any) => {
        createWorkspaceCalls.push({ kind: "workspaces.create", opts });
        return { id: "ws-should-not-create" };
      },
    },
    projects: {
      ref: (ref: any) => ({
        createWorkspace: async (opts: any) => {
          createWorkspaceCalls.push({ kind: "projects.ref.createWorkspace", ref, opts });
          return { id: "ws-should-not-create" };
        },
      }),
    },
  });
  (globalThis as any).__onboardScreenTestToasts = [];
  (globalThis as any).__onboardScreenTestRpc = async (name: string, input: any) => {
    rpcCalls.push({ name, input });
    if (name === "factory.seats.directory") return { ok: true, daemonError: null, seats: [], projects: [] };
    if (name === "factory.snapshot") {
      return {
        ok: true,
        view: {
          ...makeSnapshotView(),
          profiles: [
            {
              id: "fast",
              name: "Fast",
              description: null,
              lanes: {
                supervisor: "claude/sonnet-4-6",
                lead: "pi/zcode/glm-5.3:low",
                worker: "pi/zcode/glm-5.3:off",
                watch: "claude/haiku-4-5",
                freshEyes: "claude/sonnet-4-6",
              },
              updatedAt: "2026-11-18T00:00:00Z",
            },
          ],
        },
      };
    }
    if (name === "factory.onboarding.browse") {
      return { ok: true, path: "/Users/owner", parent: "/Users", home: "/Users/owner", entries: [] };
    }
    if (name === "factory.onboarding.inspect") {
      return {
        ok: true,
        folder: input.folder,
        gitRepo: false,
        hasCommits: false,
        registered: false,
        existingLead: false,
        existingSupervisor: false,
        prerequisites: [],
        missingPrerequisites: [],
      };
    }
    if (name === "factory.onboarding.commit") {
      return {
        ok: true,
        agentId: "agent-sup-1",
        projectRoot: "/Users/owner/work/new-app",
        slug: "new-app-123456",
        bootstrapped: true,
        summary: "Initialised Git and set up new-app",
      };
    }
    return { ok: false, error: `unexpected rpc ${name}` };
  };

  try {
    await mountDom(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        await act(() =>
          root.render(
            createElement(RegisteredScreen, {
              theme: testTheme,
              host: { id: "h1", label: "Local" },
              layout: { compact: false, platform: "web" },
              params: {},
              navigation: {
                openAgent: (input: any) => openedAgents.push(input),
                openWorkspace: (input: any) => openedWorkspaces.push(input),
              },
            }),
          ),
        );
        await act(() => new Promise<void>((r) => setTimeout(r, 10)));

        await act(() => (container.querySelector('[data-testid="factory-onboard-project-p-new"]') as HTMLElement).click());
        await act(() => new Promise<void>((r) => setTimeout(r, 10)));

        await runWizardStepsToCommit(container, act, { initGit: true, profileId: "fast" });

        const commit = rpcCalls.find((c) => c.name === "factory.onboarding.commit");
        assert.ok(commit, "onboardingCommit called");
        assert.deepEqual(commit!.input, {
          folder: "/Users/owner/work/new-app",
          initGit: true,
          profileId: "fast",
          models: {
            supervisor: "claude/sonnet-4-6",
            lead: "pi/zcode/glm-5.3:low",
            worker: "pi/zcode/glm-5.3:off",
          },
        });
        assert.deepEqual(createWorkspaceCalls, [], "reuses existing active local workspace without creating a duplicate");
        assert.deepEqual(openedAgents, []);
        assert.deepEqual(openedWorkspaces, [{ workspaceId: "ws-active-local", serverId: "h1" }]);
        assert.deepEqual(openedPanels, [{ id: "paseo-factory", options: { workspaceId: "ws-active-local", location: "workspace" } }]);
      } finally {
        await act(() => root.unmount());
      }
    });
  } finally {
    off();
    delete (globalThis as any).__onboardScreenTestRpc;
    delete (globalThis as any).__onboardScreenTestProjects;
    delete (globalThis as any).__onboardScreenTestProject;
    delete (globalThis as any).__onboardScreenTestWorkspaces;
    delete (globalThis as any).__onboardScreenTestPaseo;
    delete (globalThis as any).__onboardScreenTestToasts;
  }
});

test("05-commit: Step 4 Start creates a clean local workspace via projects.ref(ref).createWorkspace (zero dummy agent) when a ProjectRef exists, or workspaces.create for arbitrary folders", async () => {
  const { OnboardingScreen } = await loadScreenModule("plugin/client/factory/onboarding-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const projectRef = { kind: "project", key: "h1:p-zero", hostId: "h1", id: "p-zero" };
  const projects = [
    {
      ref: projectRef,
      hostId: "h1",
      displayName: "Zero Workspace App",
      rootPath: "/Users/owner/work/zero-ws",
      kind: "git",
      iconRevision: null,
    },
  ];

  // Case A: Unregistered Paseo Project with zero active local workspaces (only a worktree exists).
  {
    const createCalls: any[] = [];
    const openedWorkspaces: any[] = [];
    const openedPanels: any[] = [];

    (globalThis as any).__onboardScreenTestProjects = (query: any) =>
      projects.filter((p) => (!query?.hosts || query.hosts.includes(p.hostId)) && (!query?.where || query.where(p))).map((p) => p.ref);
    (globalThis as any).__onboardScreenTestProject = (ref: any) =>
      projects.find((p) => p.ref.key === ref.key) ?? null;
    (globalThis as any).__onboardScreenTestWorkspaces = () => [];
    (globalThis as any).__onboardScreenTestPaseo = () => ({
      workspaces: {
        list: async () => ({
          entries: [{ id: "ws-only-wt", workspaceDirectory: "/Users/owner/work/zero-ws", workspaceKind: "worktree", archivingAt: null }],
        }),
        create: async (opts: any) => {
          createCalls.push({ via: "workspaces.create", opts });
          return { id: "ws-fallback" };
        },
      },
      projects: {
        ref: (ref: any) => ({
          createWorkspace: async (opts: any) => {
            createCalls.push({ via: "projects.ref.createWorkspace", ref, opts });
            return { id: "ws-created-via-project" };
          },
        }),
      },
    });
    (globalThis as any).__onboardScreenTestToasts = [];
    (globalThis as any).__onboardScreenTestRpc = async (name: string, input: any) => {
      if (name === "factory.seats.directory") return { ok: true, daemonError: null, seats: [], projects: [] };
      if (name === "factory.snapshot") return { ok: true, view: makeSnapshotView() };
      if (name === "factory.onboarding.browse") return { ok: true, path: "/Users/owner", parent: "/Users", home: "/Users/owner", entries: [] };
      if (name === "factory.onboarding.inspect") {
        return { ok: true, folder: input.folder, gitRepo: true, hasCommits: true, registered: false, existingLead: false, existingSupervisor: false, prerequisites: [], missingPrerequisites: [] };
      }
      if (name === "factory.onboarding.commit") {
        return { ok: true, agentId: "agent-sup-zero", projectRoot: "/Users/owner/work/zero-ws", slug: "zero-ws-111111", bootstrapped: false, summary: "Set up zero-ws" };
      }
      return { ok: false, error: `unexpected ${name}` };
    };

    try {
      await mountDom(async (createRoot, container, act) => {
        const root = createRoot(container);
        try {
          await act(() =>
            root.render(
              createElement(OnboardingScreen, {
                theme: testTheme,
                host: { id: "h1", label: "Local" },
                layout: { compact: false, platform: "web" },
                params: {},
                navigation: {
                  openAgent: () => {},
                  openWorkspace: (input: any) => openedWorkspaces.push(input),
                },
                openPanel: (id: string, options: any) => openedPanels.push({ id, options }),
              }),
            ),
          );
          await act(() => new Promise<void>((r) => setTimeout(r, 10)));
          await act(() => (container.querySelector('[data-testid="factory-onboard-project-p-zero"]') as HTMLElement).click());
          await act(() => new Promise<void>((r) => setTimeout(r, 10)));
          await runWizardStepsToCommit(container, act);

          assert.equal(createCalls.length, 1);
          assert.equal(createCalls[0].via, "projects.ref.createWorkspace");
          assert.deepEqual(createCalls[0].ref, projectRef);
          assert.equal("agent" in (createCalls[0].opts ?? {}), false, "creates workspace with zero dummy agent session");
          assert.deepEqual(openedWorkspaces, [{ workspaceId: "ws-created-via-project", serverId: "h1" }]);
          assert.deepEqual(openedPanels, [{ id: "paseo-factory", options: { workspaceId: "ws-created-via-project", location: "workspace" } }]);
        } finally {
          await act(() => root.unmount());
        }
      });
    } finally {
      delete (globalThis as any).__onboardScreenTestRpc;
      delete (globalThis as any).__onboardScreenTestProjects;
      delete (globalThis as any).__onboardScreenTestProject;
      delete (globalThis as any).__onboardScreenTestWorkspaces;
      delete (globalThis as any).__onboardScreenTestPaseo;
      delete (globalThis as any).__onboardScreenTestToasts;
    }
  }

  // Case B: Arbitrary folder selected via Folder Browser (no matching ProjectRef) -> workspaces.create({ source: { kind: "directory", path } }).
  {
    const createCalls: any[] = [];
    const openedWorkspaces: any[] = [];
    const openedPanels: any[] = [];

    (globalThis as any).__onboardScreenTestProjects = () => [];
    (globalThis as any).__onboardScreenTestProject = () => null;
    (globalThis as any).__onboardScreenTestWorkspaces = () => [];
    (globalThis as any).__onboardScreenTestPaseo = () => ({
      workspaces: {
        list: async () => ({ entries: [] }),
        create: async (opts: any) => {
          createCalls.push({ via: "workspaces.create", opts });
          return { id: "ws-created-folder" };
        },
      },
      projects: {
        ref: () => ({
          createWorkspace: async () => {
            throw new Error("should not call projects.ref.createWorkspace without matching ProjectRef");
          },
        }),
      },
    });
    (globalThis as any).__onboardScreenTestToasts = [];
    (globalThis as any).__onboardScreenTestRpc = async (name: string, input: any) => {
      if (name === "factory.seats.directory") return { ok: true, daemonError: null, seats: [], projects: [] };
      if (name === "factory.snapshot") return { ok: true, view: makeSnapshotView() };
      if (name === "factory.onboarding.browse") {
        return { ok: true, path: "/Users/owner/folder-app", parent: "/Users/owner", home: "/Users/owner", entries: [] };
      }
      if (name === "factory.onboarding.inspect") {
        return { ok: true, folder: input.folder, gitRepo: true, hasCommits: true, registered: false, existingLead: false, existingSupervisor: false, prerequisites: [], missingPrerequisites: [] };
      }
      if (name === "factory.onboarding.commit") {
        return { ok: true, agentId: "agent-sup-folder", projectRoot: "/Users/owner/folder-app", slug: "folder-app-222222", bootstrapped: false, summary: "Set up folder-app" };
      }
      return { ok: false, error: `unexpected ${name}` };
    };

    try {
      await mountDom(async (createRoot, container, act) => {
        const root = createRoot(container);
        try {
          await act(() =>
            root.render(
              createElement(OnboardingScreen, {
                theme: testTheme,
                host: { id: "h1", label: "Local" },
                layout: { compact: false, platform: "web" },
                params: {},
                navigation: {
                  openAgent: () => {},
                  openWorkspace: (input: any) => openedWorkspaces.push(input),
                },
                openPanel: (id: string, options: any) => openedPanels.push({ id, options }),
              }),
            ),
          );
          await act(() => new Promise<void>((r) => setTimeout(r, 10)));
          await act(() => (container.querySelector('[data-testid="factory-onboard-select-folder"]') as HTMLElement).click());
          await act(() => new Promise<void>((r) => setTimeout(r, 10)));
          await runWizardStepsToCommit(container, act);

          assert.equal(createCalls.length, 1);
          assert.equal(createCalls[0].via, "workspaces.create");
          assert.deepEqual(createCalls[0].opts, { source: { kind: "directory", path: "/Users/owner/folder-app" } });
          assert.equal("agent" in createCalls[0].opts, false, "no dummy agent session");
          assert.deepEqual(openedWorkspaces, [{ workspaceId: "ws-created-folder", serverId: "h1" }]);
          assert.deepEqual(openedPanels, [{ id: "paseo-factory", options: { workspaceId: "ws-created-folder", location: "workspace" } }]);
        } finally {
          await act(() => root.unmount());
        }
      });
    } finally {
      delete (globalThis as any).__onboardScreenTestRpc;
      delete (globalThis as any).__onboardScreenTestProjects;
      delete (globalThis as any).__onboardScreenTestProject;
      delete (globalThis as any).__onboardScreenTestWorkspaces;
      delete (globalThis as any).__onboardScreenTestPaseo;
      delete (globalThis as any).__onboardScreenTestToasts;
    }
  }
});

test("05-commit: Step 4 Start with a directive navigates via openAgent without opening workspace/panel, and handles workspace errors gracefully", async () => {
  const { OnboardingScreen } = await loadScreenModule("plugin/client/factory/onboarding-screen.tsx", { platformOs: "web" });
  const { createElement } = await import("react");

  const openedAgents: any[] = [];
  const openedWorkspaces: any[] = [];
  const openedPanels: any[] = [];
  const toasts: any[] = [];
  let commitCount = 0;

  (globalThis as any).__onboardScreenTestProjects = () => [];
  (globalThis as any).__onboardScreenTestProject = () => null;
  (globalThis as any).__onboardScreenTestWorkspaces = () => [];
  (globalThis as any).__onboardScreenTestPaseo = () => ({
    workspaces: {
      list: async () => { throw new Error("list unavailable"); },
      create: async () => { throw new Error("create unavailable"); },
    },
    projects: {
      ref: () => ({ createWorkspace: async () => { throw new Error("create unavailable"); } }),
    },
  });
  (globalThis as any).__onboardScreenTestToasts = toasts;
  (globalThis as any).__onboardScreenTestRpc = async (name: string, input: any) => {
    if (name === "factory.seats.directory") return { ok: true, daemonError: null, seats: [], projects: [] };
    if (name === "factory.snapshot") return { ok: true, view: makeSnapshotView() };
    if (name === "factory.onboarding.browse") return { ok: true, path: "/Users/owner/dir-app", parent: "/Users/owner", home: "/Users/owner", entries: [] };
    if (name === "factory.onboarding.inspect") {
      return { ok: true, folder: input.folder, gitRepo: true, hasCommits: true, registered: false, existingLead: false, existingSupervisor: false, prerequisites: [], missingPrerequisites: [] };
    }
    if (name === "factory.onboarding.commit") {
      commitCount += 1;
      return { ok: true, agentId: `agent-sup-${commitCount}`, projectRoot: "/Users/owner/dir-app", slug: "dir-app-333333", bootstrapped: false, summary: "Set up dir-app" };
    }
    return { ok: false, error: `unexpected ${name}` };
  };

  try {
    await mountDom(async (createRoot, container, act) => {
      const root = createRoot(container);
      try {
        // 1. With directive: even if workspace lookup/create fails, openAgent still navigates cleanly.
        await act(() =>
          root.render(
            createElement(OnboardingScreen, {
              theme: testTheme,
              host: { id: "h1", label: "Local" },
              layout: { compact: false, platform: "web" },
              params: { folder: "/Users/owner/dir-app" },
              navigation: {
                openAgent: (input: any) => openedAgents.push(input),
                openWorkspace: (input: any) => openedWorkspaces.push(input),
              },
              openPanel: (id: string, options: any) => openedPanels.push({ id, options }),
            }),
          ),
        );
        await act(() => new Promise<void>((r) => setTimeout(r, 10)));
        await runWizardStepsToCommit(container, act, { directive: "Ship onboarding" });

        assert.deepEqual(openedAgents, [{ agentId: "agent-sup-1", serverId: "h1" }]);
        assert.deepEqual(openedWorkspaces, []);
        assert.deepEqual(openedPanels, []);

        // 2. Without directive when workspace create fails: does not throw unhandled rejection, warns via toast, returns cleanly to picker.
        await act(() => (container.querySelector('[data-testid="factory-onboard-change-folder"]') as HTMLElement).click());
        await act(() => (container.querySelector('[data-testid="factory-onboard-select-folder"]') as HTMLElement).click());
        await act(() => new Promise<void>((r) => setTimeout(r, 10)));
        await runWizardStepsToCommit(container, act);

        assert.deepEqual(openedAgents, [{ agentId: "agent-sup-1", serverId: "h1" }]);
        assert.deepEqual(openedWorkspaces, []);
        assert.deepEqual(openedPanels, []);
        assert.ok(toasts.some((t) => /workspace/i.test(t.msg) && (t.error || t.opts?.variant === "warning")));
      } finally {
        await act(() => root.unmount());
      }
    });
  } finally {
    delete (globalThis as any).__onboardScreenTestRpc;
    delete (globalThis as any).__onboardScreenTestProjects;
    delete (globalThis as any).__onboardScreenTestProject;
    delete (globalThis as any).__onboardScreenTestWorkspaces;
    delete (globalThis as any).__onboardScreenTestPaseo;
    delete (globalThis as any).__onboardScreenTestToasts;
  }
});

