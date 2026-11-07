/**
 * The Agents & Models screen's contract (T-08a): the `/models` route renders
 * the selected Project's READ-ONLY roster from the snapshot alone — one row
 * per role lane (the SLP six, or the Scrum roster `execution.config.lanes`
 * carries), each row's provider/model[:thinking] split, its Machine-default
 * vs Project-override source, and the live seats the daemon binds to it (the
 * SLP worker row carries the live workers, the Scrum role lanes seat through
 * the run's own task bindings). The saved profile library renders as chips
 * with the active one marked and the "Modified from" suffix where the data
 * says; no profiles says so. A lane with no live seat renders "Vacant" — the
 * passenger lanes (watch, retro, freshEyes) say why, never a fabricated
 * agent. No Project selected answers an honest empty state. The screen
 * carries NO control at all: no Configure, no Rotate/Revoke, no Apply/Save
 * profile, no Reset, no Start Supervisor/Lead (ADR 0017) — this wave is
 * read-only by construction, so the roster renders zero buttons.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryView, ScrumRunView } from "../../../plugin/shared/view.ts";
import { fixtureAgent, fixtureTask, fixtureView } from "../test/fixture-view.ts";
import { modelsScreenModel, splitLane } from "../models-view.ts";
import { ModelsScreen } from "./models.tsx";

afterEach(() => {
  cleanup();
});

// ---- the fixture views ---------------------------------------------------------------------------

/** The scoped SLP Project — a live supervisor and Lead, one running worker, a Lead lane override, one active profile. */
const slpView = (): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[0]!, executionMode: "slp" };
  // The Project's own `lanes.json` overrides Lead and Worker; the machine
  // table (fixtureView's default six) stays what `view.machineLanes` carries.
  view.lanes = {
    ...view.lanes,
    lead: "codex/gpt-5.4:high",
    worker: "codex/gpt-5.4",
  };
  view.hasProjectLaneOverride = true;
  view.supervisor = fixtureAgent("agent-sup-1", { seat: "supervisor", status: "running", title: "Supervisor" });
  view.lead = fixtureAgent("agent-lead-1", { seat: "lead", status: "idle", title: "Lead" });
  view.agents = [
    view.supervisor,
    view.lead,
    fixtureAgent("agent-worker-1", { seat: "agent", status: "running", title: "Worker 1" }),
    fixtureAgent("agent-worker-2", { seat: "agent", status: "idle", title: "Worker 2" }),
  ];
  view.profiles = [
    { id: "balanced", name: "Balanced", description: null, lanes: { ...view.machineLanes }, updatedAt: "2026-11-01T10:00:00.000Z" },
    { id: "fast", name: "Fast Watch", description: null, lanes: { ...view.machineLanes, watch: "pi/zai/glm-5.3-air" }, updatedAt: "2026-11-02T10:00:00.000Z" },
  ];
  view.activeProfileId = "balanced";
  view.activeProfileModified = false;
  return view;
};

const SCRUM_CONFIG: ScrumRunView["config"] = {
  schemaVersion: 1,
  requireUiApproval: true,
  configRevision: 3,
  lanes: {
    supervisor: "pi/zai/glm-5.3",
    lead: "pi/zai/glm-5.3",
    pm: "pi/zai/glm-5.3",
    ux: "pi/zai/glm-5.3",
    architect: "pi/zai/glm-5.3",
    dev: "codex/gpt-5.4:high",
    qa: "pi/zai/glm-5.3",
    watch: "pi/zai/glm-5.3",
    retro: "pi/zai/glm-5.3",
  },
};

/** The scoped Scrum Project — a frozen r3 roster, one live Dev seated through the run's task binding. */
const scrumView = (): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[1]!, executionMode: "scrum" };
  view.execution = {
    selectedMode: "scrum",
    revision: 2,
    config: SCRUM_CONFIG,
    machineConfig: { ...SCRUM_CONFIG, lanes: { ...SCRUM_CONFIG.lanes, dev: "pi/zai/glm-5.3" } },
    activeRun: {
      runId: "run-web-1",
      phase: "implementation",
      revision: 5,
      configRevision: 3,
      config: SCRUM_CONFIG,
      fixRounds: 1,
      decisions: 0,
      tasks: [
        { task: "T-PM-1", role: "pm" },
        { task: "T-DEV-1", role: "dev" },
      ],
    } satisfies ScrumRunView,
    profiles: [{ id: "sprint", name: "Sprint", config: SCRUM_CONFIG, updatedAt: "2026-11-03T10:00:00.000Z" }],
    activeProfileId: "sprint",
    activeProfileModified: false,
  };
  const devTask = fixtureTask("T-DEV-1", "running");
  devTask.agentId = "agent-dev-1";
  view.tasks = [devTask];
  view.agents = [fixtureAgent("agent-dev-1", { seat: "agent", status: "running", title: "Dev 1", task: "T-DEV-1" })];
  return view;
};

// ---- the fold (pure) -------------------------------------------------------------------------------

describe("the models fold (pure)", () => {
  it("answers null without a selected Project — the screen's own empty state, never a fabricated roster", () => {
    expect(modelsScreenModel(fixtureView())).toBeNull();
  });

  it("splits provider/model[:thinking] — the core parseLane law, eye.json kept whole", () => {
    expect(splitLane("codex/gpt-5.4:high")).toEqual({ provider: "codex", model: "gpt-5.4", thinking: "high" });
    expect(splitLane("pi/zai/glm-5.3")).toEqual({ provider: "pi", model: "zai/glm-5.3", thinking: null });
    expect(splitLane("eye.json")).toEqual({ provider: "eye.json", model: "", thinking: null });
  });

  it("folds the SLP roster — six lanes, override sources, the live seats, the worker crowd", () => {
    const model = modelsScreenModel(slpView())!;
    expect(model.mode).toBe("slp");
    expect(model.scope).toBe("research-slp");
    expect(model.rosterNote).toBe("Project lanes");
    expect(model.rows.map((row) => row.lane)).toEqual(["supervisor", "lead", "worker", "watch", "retro", "freshEyes"]);
    const supervisor = model.rows[0]!;
    expect(supervisor.source).toBe("default");
    expect(supervisor.sourceLabel).toBe("Machine default");
    expect(supervisor.seats.map((seat) => [seat.agentId, seat.state.label])).toEqual([["agent-sup-1", "Live"]]);
    const lead = model.rows[1]!;
    expect(lead.raw).toBe("codex/gpt-5.4:high");
    expect(lead.provider).toBe("codex");
    expect(lead.model).toBe("gpt-5.4");
    expect(lead.thinking).toBe("high");
    expect(lead.source).toBe("override");
    expect(lead.sourceLabel).toBe("Project override");
    expect(lead.seats.map((seat) => [seat.agentId, seat.state.label])).toEqual([["agent-lead-1", "Idle"]]);
    const worker = model.rows[2]!;
    expect(worker.source).toBe("override");
    expect(worker.seats.map((seat) => seat.agentId)).toEqual(["agent-worker-1", "agent-worker-2"]);
    for (const lane of ["watch", "retro", "freshEyes"]) {
      const row = model.rows.find((candidate) => candidate.lane === lane)!;
      expect(row.seats, lane).toEqual([]);
      expect(row.vacantNote, lane).toBe("Spawned per Task");
      expect(row.source, lane).toBe("default");
    }
  });

  it("marks the active Lane profile and carries the modified state", () => {
    const view = slpView();
    view.lanes = { ...view.lanes, watch: "pi/zai/glm-5.3-air" };
    view.activeProfileId = "fast";
    view.activeProfileModified = false;
    const model = modelsScreenModel(view)!;
    expect(model.profiles.map((profile) => [profile.name, profile.active])).toEqual([
      ["Balanced", false],
      ["Fast Watch", true],
    ]);
    expect(model.activeProfileName).toBe("Fast Watch");
    expect(model.activeProfileModified).toBe(false);
    view.activeProfileModified = true;
    expect(modelsScreenModel(view)!.activeProfileModified).toBe(true);
  });

  it("folds the Scrum roster — the frozen config's nine lanes, the run's own seat bindings, its own profiles", () => {
    const model = modelsScreenModel(scrumView())!;
    expect(model.mode).toBe("scrum");
    expect(model.rosterNote).toBe("Run roster r3 · frozen");
    expect(model.rows.map((row) => row.lane)).toEqual(["supervisor", "lead", "pm", "ux", "architect", "dev", "qa", "watch", "retro"]);
    const dev = model.rows.find((row) => row.lane === "dev")!;
    expect(dev.raw).toBe("codex/gpt-5.4:high");
    expect(dev.source).toBe("override");
    expect(dev.seats.map((seat) => [seat.agentId, seat.state.label])).toEqual([["agent-dev-1", "Live"]]);
    const pm = model.rows.find((row) => row.lane === "pm")!;
    expect(pm.seats).toEqual([]);
    expect(pm.vacantNote).toBeNull();
    expect(pm.source).toBe("default");
    expect(model.profiles.map((profile) => [profile.name, profile.active])).toEqual([["Sprint", true]]);
    expect(model.activeProfileName).toBe("Sprint");
  });

  it("degrades a Scrum Project with no recorded roster to the SLP table it still carries", () => {
    const view = scrumView();
    view.execution = { selectedMode: "scrum", revision: 2 };
    const model = modelsScreenModel(view)!;
    expect(model.rosterNote).toBe("Project lanes — no Scrum roster recorded");
    expect(model.rows.map((row) => row.lane)).toEqual(["supervisor", "lead", "worker", "watch", "retro", "freshEyes"]);
  });
});

// ---- the screen ------------------------------------------------------------------------------------

describe("the Agents & Models screen", () => {
  it("answers the honest empty state without a selected Project", () => {
    render(<ModelsScreen view={fixtureView()} />);
    expect(screen.getByRole("heading", { name: "Agents & Models" })).toBeTruthy();
    expect(screen.getByText(/No Project selected/)).toBeTruthy();
  });

  it("renders the roster from the snapshot — lanes, sources, live seats, profile chips", () => {
    render(<ModelsScreen view={slpView()} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Default Worker")).toBeTruthy();
    expect(within(table).getAllByText("Project override").length).toBe(2);
    expect(within(table).getAllByText("Machine default").length).toBe(4);
    expect(within(table).getByText("agent-sup-1 · Live")).toBeTruthy();
    expect(within(table).getByText("agent-lead-1 · Idle")).toBeTruthy();
    expect(within(table).getAllByText("Spawned per Task").length).toBe(3);
    expect(within(table).getByText("high")).toBeTruthy();
    const strip = screen.getByRole("group", { name: "Saved profiles" });
    expect(within(strip).getByText("Balanced · active")).toBeTruthy();
    expect(within(strip).getByText("Fast Watch")).toBeTruthy();
    expect(within(strip).queryByText("No saved profiles")).toBeNull();
  });

  it("says so when no profile is saved", () => {
    render(<ModelsScreen view={scrumView()} />);
    const strip = screen.getByRole("group", { name: "Saved profiles" });
    expect(within(strip).getByText("Sprint · active")).toBeTruthy();
    const bare = slpView();
    bare.profiles = [];
    bare.activeProfileId = null;
    cleanup();
    render(<ModelsScreen view={bare} />);
    expect(screen.getByText("No saved profiles")).toBeTruthy();
  });

  it("renders the eye.json lane as the external config it is — never a fabricated model", () => {
    const view = slpView();
    view.lanes = { ...view.lanes, freshEyes: "eye.json" };
    render(<ModelsScreen view={view} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("External config")).toBeTruthy();
  });

  it("carries NO control — read-only by construction, no Configure/Rotate/Revoke/Apply/Start (ADR 0017)", () => {
    render(<ModelsScreen view={slpView()} />);
    expect(screen.queryAllByRole("button")).toEqual([]);
    for (const word of ["Configure", "Rotate", "Revoke", "Apply", "Save", "Reset", "Start Supervisor", "Start Lead"]) {
      expect(screen.queryByText(new RegExp(word, "i")), word).toBeNull();
    }
  });
});
