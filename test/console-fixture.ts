/**
 * The console tests' shared fixture (T-02): a real Factory on a temp home —
 * never `~/.paseo` — its `SurfaceHandlers`, a committed-looking console
 * bundle, and a started sidecar on an ephemeral port. Every listener the
 * fixture opens closes in the caller's teardown.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory, type Factory } from "../plugin/server/core/factory.ts";
import { checkDaemonPluginUpdates, installDaemonPlugin, listDaemonPlugins, manageDaemonPlugin } from "../plugin/server/daemon-cli.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "../plugin/server/surface-rpc.ts";
import { createFactoryRegistry, type FactoryRegistry } from "../plugin/server/projects.ts";
import { createUsageRuntime } from "../plugin/server/usage-rollup.ts";
import { startConsoleSidecar, type ConsoleSidecarStart } from "../plugin/server/console-sidecar.ts";
import { fakeCopilotRunner, gitCommitAll } from "./helpers.ts";

export interface ConsoleFixture {
  homeRoot: string;
  home: string;
  stateDir: string;
  webRoot: string;
  factory: Factory;
  /** The per-Project Factory Registry, wired into the handlers — set only when the fixture was built with `registry: true`. */
  registry: FactoryRegistry | undefined;
  handlers: ReturnType<typeof createSurfaceHandlers>;
  start: (overrides?: Partial<Parameters<typeof startConsoleSidecar>[0]>) => Promise<ConsoleSidecarStart>;
  /** A FetchLike bound to the STARTED sidecar — the console transport's real seam. Build it after `start()`. */
  atSidecar: (sidecar: Extract<ConsoleSidecarStart, { ok: true }>["sidecar"]) => (input: string, init: RequestInit) => Promise<Response>;
}

/** The transport test's daemon: an empty, fully-typed slice — no live seats needed to answer a snapshot. */
export function emptyDaemon(): SurfaceDaemonApi {
  return {
    agents: {
      list: async () => ({ entries: [] }),
      create: async () => ({ id: "unused" }),
      ref: (id: string) => ({
        send: async () => {},
        archive: async () => ({ archivedAt: new Date().toISOString() }),
        timeline: { refetch: async () => ({ entries: [], error: null }) },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
    },
  };
}

export function makeConsoleFixture(
  homeRoot: string,
  options?: {
    daemon?: SurfaceDaemonApi | (() => SurfaceDaemonApi);
    registry?: boolean;
    /** T-07c: wire the per-Project usage rollup runtime the live server runs with. */
    usage?: boolean;
    /**
     * T-08c: the retire path's cancel half rides the CLI in production —
     * injectable so the seat-lifecycle tests never spawn a real paseo
     * process (the same seam `plugin-spool.test.ts` records through).
     */
    stopAgent?: (agentId: string, home?: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /**
     * T-09b: the daemon plugin lifecycle seams (the same overrides
     * `SurfaceDeps` accepts) — injectable so the Integrations write e2e and
     * the door's dispatch assertions never spawn a real daemon bridge; the
     * fakes record every call so refusals can prove no dispatch happened.
     */
    listPlugins?: typeof listDaemonPlugins;
    installPlugin?: typeof installDaemonPlugin;
    managePlugin?: typeof manageDaemonPlugin;
    checkPluginUpdates?: typeof checkDaemonPluginUpdates;
  },
): ConsoleFixture {
  const home = join(homeRoot, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");
  const webRoot = join(homeRoot, "console-bundle");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(
    join(webRoot, "index.html"),
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Factory Console (fixture)</title></head><body><div id=\"root\"></div></body></html>\n",
  );
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log('fixture bundle');\n");
  const retroRunner = fakeCopilotRunner(() => ({ code: 0, stdout: '{"proposals":[]}' }));
  // The eye probe admits fresh-eyes Contracts (T-03's detail fixture sets one);
  // no eye CLI ever runs — the pass's ledger line is appended by the test.
  const factory = createFactory({ stateDir, retroCopilotProbe: () => true, retroCopilotRunner: retroRunner.runner, eyeCliProbe: () => true });
  // T-05: `registry: true` wires the per-Project Factory Registry the live
  // plugin server runs with — the cross-Project inbox e2e registers ≥2
  // Projects and reads through their OWN Factories, never the root's.
  const registry = options?.registry === true ? createFactoryRegistry({ stateDir, root: factory }) : undefined;
  // T-04: the daemon seam is injectable — the transcript e2e drives handlers
  // against a fake daemon shaped like the SDK's timeline API; an unset
  // `daemon` option can also spell "no PaseoApi captured" via a function
  // returning undefined.
  const daemon = options?.daemon ?? emptyDaemon();
  // T-07c: the per-Project usage rollup runtime (v0.0.87, ADR 0043) the live
  // plugin server always wires (plugin/index.server.ts) — opted in by the
  // tests whose Projects carry a usage.json, so their snapshots read the
  // rollup through the REAL `loadOrBackfillProjectUsage`, never a hand stub.
  // Its daemon is the same injectable seam the handlers read.
  const usage = options?.usage === true
    ? createUsageRuntime({ factory, stateDir, daemon: () => (typeof daemon === "function" ? daemon() : daemon), onLog: () => {} })
    : undefined;
  const handlers = createSurfaceHandlers({
    factory,
    stateDir,
    home,
    daemon,
    registry,
    ...(usage === undefined ? {} : { usage }),
    ...(options?.stopAgent === undefined ? {} : { stopAgent: options.stopAgent }),
    ...(options?.listPlugins === undefined ? {} : { listPlugins: options.listPlugins }),
    ...(options?.installPlugin === undefined ? {} : { installPlugin: options.installPlugin }),
    ...(options?.managePlugin === undefined ? {} : { managePlugin: options.managePlugin }),
    ...(options?.checkPluginUpdates === undefined ? {} : { checkPluginUpdates: options.checkPluginUpdates }),
  });
  return {
    homeRoot,
    home,
    stateDir,
    webRoot,
    factory,
    registry,
    handlers,
    start: async (overrides) =>
      startConsoleSidecar({
        handlers,
        stateDir,
        webRoot: () => webRoot,
        // The ephemeral port — never the Owner's stable default during tests.
        ports: [0],
        onLog: () => {},
        ...overrides,
      }),
    atSidecar: (sidecar) => (input, init) => fetch(`${sidecar.url}${input}`, init),
  };
}

/**
 * Contracts a task on a real git workspace and drives its one attempt to a
 * closed green verdict — the fold then reads `ready-to-accept`, exactly the
 * state the Owner's Accept act needs.
 */
export function makeReadyToAcceptTask(factory: Factory, dir: string, task: string): { workspace: string; sha: string } {
  const workspace = join(dir, `${task}-ws`);
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  factory.setContract({ task, workspace, gate: "npm test", artifact: "src/format.ts" });
  factory.ledger.append({ event: "claim_reported", task, attempt: 1, sha });
  factory.ledger.append({ event: "gate_finished", task, attempt: 1, exit: 0, verdict: "green", note: "passed" });
  factory.ledger.append({ event: "report_written", task, attempt: 1, path: `report-${task}-1.md` });
  return { workspace, sha };
}
