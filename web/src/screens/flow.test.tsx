/**
 * The Workspace screen's contract (T-07a): the `/flow` route renders the
 * selected Project's read-only authority graph from the snapshot alone — the
 * SLP chain (Owner → Supervisor → Lead → working Peers, each node's live
 * state, lane, owned Task chips, Lead telemetry) or the Scrum authority tier
 * plus the run's five-stage pipeline strip with the current phase highlighted
 * and blockers carried as a banner. Vacant seats render "Not started", never
 * a fabricated agent; no Project selected answers an honest empty state; a
 * node click selects (aria-pressed + `.selected`) and never opens a drawer;
 * and NO Start Supervisor/Lead control exists anywhere (ADR 0017).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryView, ScrumRunView } from "../../../plugin/shared/view.ts";
import { fixtureAgent, fixtureAttempt, fixtureTask, fixtureView } from "../test/fixture-view.ts";
import { flowScreenModel, flowSeatState } from "../view-model.ts";
import { FlowScreen } from "./flow.tsx";

afterEach(() => {
  cleanup();
});

// ---- the fixture views ---------------------------------------------------------------------------

/** The scoped SLP Project — live supervisor and handing-telemetry Lead, one running Peer. */
const slpView = (): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[0]!, executionMode: "slp" };
  view.supervisor = fixtureAgent("agent-sup-1", { seat: "supervisor", status: "running", title: "Supervisor" });
  view.lead = fixtureAgent("agent-lead-1", {
    seat: "lead",
    status: "running",
    title: "Lead",
    contextUsedTokens: 40000,
    contextMaxTokens: 128000,
    queuedMailCount: 2,
  });
  const peerTask = fixtureTask("T-07", "running", [fixtureAttempt(1, null)]);
  peerTask.agentId = "agent-peer-1";
  view.tasks = [peerTask];
  view.agents = [view.supervisor, view.lead, fixtureAgent("agent-peer-1", { seat: "agent", status: "running", title: "Peer 1", task: "T-07" })];
  return view;
};

const SCRUM_CONFIG: ScrumRunView["config"] = {
  schemaVersion: 1,
  requireUiApproval: true,
  lanes: { supervisor: "pi/z", lead: "pi/z", pm: "pi/z", ux: "pi/z", architect: "pi/z", dev: "pi/z", qa: "pi/z", watch: "pi/z", retro: "pi/z" },
};

/** The scoped Scrum Project's active run — PM accepted, Dev running, mid-implementation. */
const scrumRun = (over: Partial<ScrumRunView> = {}): ScrumRunView => ({
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
  budgets: { maxTasks: 4, maxQaFixRounds: 2 },
  qaResult: { status: "pass", productSha: "abc123", confirmedDefects: 1 },
  blockerDetails: [],
  blockers: [],
  ...over,
});

const scrumView = (run: ScrumRunView): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[1]!, executionMode: "scrum" };
  view.execution = { selectedMode: "scrum", revision: 2, activeRun: run };
  const pmTask = fixtureTask("T-PM-1", "accepted", [fixtureAttempt(1, "green")]);
  const devTask = fixtureTask("T-DEV-1", "running", [fixtureAttempt(1, null)]);
  devTask.agentId = "agent-dev-1";
  view.tasks = [pmTask, devTask];
  view.agents = [fixtureAgent("agent-dev-1", { seat: "agent", status: "running", title: "Dev 1", task: "T-DEV-1" })];
  return view;
};

// ---- the fold (pure) -------------------------------------------------------------------------------

describe("the flow fold (pure)", () => {
  it("answers null without a selected Project — the screen's own empty state, never a fabricated graph", () => {
    expect(flowScreenModel(fixtureView())).toBeNull();
  });

  it("folds the SLP authority graph — presence, lanes, owned Tasks, Lead telemetry", () => {
    const model = flowScreenModel(slpView())!;
    expect(model.mode).toBe("slp");
    expect(model.scope).toBe("research-slp");
    expect(model.supervisor.agentId).toBe("agent-sup-1");
    expect(model.supervisor.state.label).toBe("Live");
    expect(model.supervisor.laneLabel).toBe("pi · glm-5.3");
    expect(model.lead.state.label).toBe("Live");
    expect(model.lead.contextLabel).toBe("40k / 128k");
    expect(model.lead.queuedMailCount).toBe(2);
    expect(model.peers.map((peer) => [peer.title, peer.state.label])).toEqual([["Peer 1", "Live"]]);
    expect(model.peers[0]!.tasks.map((chip) => [chip.task, chip.statusLabel])).toEqual([["T-07", "running"]]);
    expect(model.mail.lead.queued).toBe(2);
    expect(model.mail.lead.locked).toBe(false);
    expect(model.scrum).toBeNull();
  });

  it("renders a vacant seat as Not started with its configured lane — never a fabricated agent", () => {
    const view = slpView();
    view.supervisor = null;
    view.lead = null;
    const model = flowScreenModel(view)!;
    expect(model.supervisor.agentId).toBeNull();
    expect(model.supervisor.state.label).toBe("Not started");
    expect(model.supervisor.laneLabel).toBe(view.lanes.supervisor);
    expect(model.lead.state.label).toBe("Not started");
    expect(model.lead.tasks).toEqual([]);
  });

  it("walks the presence ladder — the daemon's own fields, verbatim", () => {
    const agent = (over: Parameters<typeof fixtureAgent>[1]) => fixtureAgent("agent-x", over);
    expect(flowSeatState(null, "supervisor").label).toBe("Not started");
    expect(flowSeatState(agent({ status: "running" }), "peer").label).toBe("Live");
    expect(flowSeatState(agent({ status: "idle" }), "peer").label).toBe("Idle");
    expect(flowSeatState(agent({ status: "error" }), "peer").label).toBe("Error");
    expect(flowSeatState(agent({ status: "closed" }), "peer").label).toBe("Dormant");
    expect(flowSeatState(agent({ status: "idle", requiresAttention: true }), "peer").label).toBe("Needs you");
    expect(flowSeatState(agent({ status: "running", rotationState: "handing_over" }), "lead").label).toBe("Handoff");
    expect(flowSeatState(agent({ status: "running", rotationState: "rotation_pending" }), "lead").label).toBe("Rotation pending");
    // A Lead's rotation state is Lead-only — the same fields never touch a Peer.
    expect(flowSeatState(agent({ status: "running", rotationState: "handing_over" }), "peer").label).toBe("Live");
    // An unrecognized daemon status renders verbatim, muted — never a guess.
    expect(flowSeatState(agent({ status: "transitioning" }), "peer")).toMatchObject({ label: "transitioning", tone: "muted" });
  });

  it("folds the Scrum pipeline strip — five stages, the current phase highlighted, statuses joined", () => {
    const model = flowScreenModel(scrumView(scrumRun()))!;
    expect(model.mode).toBe("scrum");
    const strip = model.scrum!;
    expect(strip.runId).toBe("run-web-1");
    expect(strip.phase).toBe("implementation");
    expect(strip.fixSummary).toBe("Fix 1/2 · 1 defects");
    expect(strip.stages.map((stage) => [stage.id, stage.state, stage.current])).toEqual([
      ["planning", "Completed", false],
      ["design", "Waiting", false],
      ["readiness", "Waiting", false],
      ["implementation", "Running", true],
      ["qa", "Waiting", false],
    ]);
    // The PM's accepted Task completed planning; the Dev's running Task runs implementation.
    expect(strip.stages[0]!.columns[0]!.tasks.map((task) => [task.task, task.statusLabel])).toEqual([["T-PM-1", "Done"]]);
    expect(strip.stages[3]!.columns[0]!.tasks.map((task) => [task.task, task.statusLabel])).toEqual([["T-DEV-1", "Running"]]);
    // The gate: the run moved past readiness, the design waits on the Owner.
    expect(strip.stages[2]!.gate).toMatchObject({ readiness: { label: "Pass" }, ui: { label: "Awaiting Owner" }, revision: null });
  });

  it("maps the real phase vocabulary onto the strip — awaiting-ui-approval lights the gate, blocked lights none", () => {
    const awaiting = flowScreenModel(scrumView(scrumRun({ phase: "awaiting-ui-approval" })))!.scrum!;
    expect(awaiting.stages[2]!.current).toBe(true);
    expect(awaiting.stages[2]!.state).toBe("Needs you");
    expect(awaiting.stages[2]!.gate!.readiness).toEqual({ label: "Pass", tone: "green" });

    const blocked = flowScreenModel(
      scrumView(
        scrumRun({
          phase: "blocked",
          blockerDetails: [{ id: "reserve-qa:exhausted", reason: "Task capacity exhausted: 4/4 Tasks used.", causes: ["tasks"] }],
        }),
      ),
    )!.scrum!;
    expect(blocked.stages.every((stage) => stage.current)).toBe(false);
    expect(blocked.blockers).toEqual(["Task capacity exhausted: 4/4 Tasks used."]);
    // A decided design completes the UI gate's half.
    const approved = flowScreenModel(scrumView(scrumRun({ design: { revision: 2, digest: "d", decision: "approved" } })))!.scrum!;
    expect(approved.stages[2]!.gate!.ui).toEqual({ label: "Approved", tone: "green" });
  });

  it("carries a skipped design stage and the QA fixing loop as their own state words", () => {
    const run = scrumRun({
      phase: "fixing",
      skippedPhases: [{ phase: "design", reason: "Small track: no UX work" }],
    });
    const model = flowScreenModel(scrumView(run))!.scrum!;
    expect(model.stages[1]!.state).toBe("Skipped");
    expect(model.stages[1]!.skipped).toBe(true);
    expect(model.stages[4]!.current).toBe(true);
    expect(model.stages[4]!.state).toBe("Waiting"); // no QA Task reserved yet — the loop's phase, not a card
  });
});

// ---- the screen ------------------------------------------------------------------------------------

describe("the Workspace screen", () => {
  it("renders the SLP chain from the snapshot — nodes, telemetry, and the owned Task chip", () => {
    render(<FlowScreen view={slpView()} />);
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByText("SLP authority graph")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Owner: Human" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lead: Live, pi · glm-5.3" })).toBeTruthy();
    expect(screen.getByText("40k / 128k")).toBeTruthy();
    expect(screen.getByText("T-07 · running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lead Mailbox: 2 queued" })).toBeTruthy();
  });

  it("renders a vacant Peer slot as Not started when no working Peer exists", () => {
    const view = slpView();
    view.agents = [view.supervisor!, view.lead!];
    render(<FlowScreen view={view} />);
    expect(screen.getByRole("button", { name: "Peer: Not started" })).toBeTruthy();
  });

  it("renders the Scrum pipeline strip — run summary, stage states, the current phase highlighted", () => {
    render(<FlowScreen view={scrumView(scrumRun())} />);
    expect(screen.getByText("Scrum pipeline")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run run-web-1: phase implementation" })).toBeTruthy();
    expect(screen.getByText("Roster r3 · frozen")).toBeTruthy();
    const implementation = screen.getByRole("button", { name: "4. Senior Dev: Running (current phase)" });
    expect(implementation.className).toContain("console-flow-current");
    expect(screen.getByRole("button", { name: "1. PM / Analyst: Completed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "PM · T-PM-1: Done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DEV · T-DEV-1: Running" })).toBeTruthy();
    expect(screen.getByText("Fix 1/2 · 1 defects")).toBeTruthy();
    // The gate cell renders both halves — the run passed readiness, the design waits.
    expect(screen.getByText("Pass")).toBeTruthy();
    expect(screen.getByText("Awaiting Owner")).toBeTruthy();
  });

  it("carries the run's blockers as a banner when the phase is blocked", () => {
    render(
      <FlowScreen
        view={scrumView(
          scrumRun({
            phase: "blocked",
            blockerDetails: [{ id: "reserve-qa:exhausted", reason: "Task capacity exhausted: 4/4 Tasks used.", causes: ["tasks"] }],
          }),
        )}
      />,
    );
    expect(screen.getByText("Task capacity exhausted: 4/4 Tasks used.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "4. Senior Dev: Running (current phase)" })).toBeNull();
  });

  it("answers an honest empty state when no Project is selected", () => {
    render(<FlowScreen view={fixtureView()} />);
    expect(screen.getByText(/No Project selected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Owner: Human" })).toBeNull();
  });

  it("surfaces the daemon degrade line as data — the graph renders the last known snapshot", () => {
    const view = slpView();
    view.daemonError = "daemon unavailable: boom";
    render(<FlowScreen view={view} />);
    expect(screen.getByText(/Live agent states are degraded \(daemon unavailable: boom\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" })).toBeTruthy();
  });

  it("selects a node on click — aria-pressed and .selected — and never opens a drawer", () => {
    render(<FlowScreen view={slpView()} />);
    const supervisor = screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" });
    fireEvent.click(supervisor);
    expect(supervisor.getAttribute("aria-pressed")).toBe("true");
    expect(supervisor.className).toContain("selected");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".agent-drawer")).toBeNull();
    // A second click clears the selection — a toggle, never a stuck state.
    fireEvent.click(supervisor);
    expect(supervisor.getAttribute("aria-pressed")).toBe("false");
  });

  it("deep-links a Scrum Task card into the existing Task Detail journey", () => {
    render(<FlowScreen view={scrumView(scrumRun())} />);
    fireEvent.click(screen.getByRole("button", { name: "DEV · T-DEV-1: Running" }));
    expect(window.location.pathname).toBe("/tasks");
    expect(window.location.search).toBe("?task=T-DEV-1");
    window.history.pushState({}, "", "/");
  });

  it("renders no Start Supervisor / Start Lead control anywhere (ADR 0017)", () => {
    render(<FlowScreen view={slpView()} />);
    expect(screen.queryAllByRole("button", { name: /^Start (Supervisor|Lead)/i })).toEqual([]);
    render(<FlowScreen view={scrumView(scrumRun())} />);
    expect(screen.queryAllByRole("button", { name: /^Start (Supervisor|Lead)/i })).toEqual([]);
    expect(screen.queryAllByRole("button", { name: /rotate|revoke|respawn/i })).toEqual([]);
  });
});
