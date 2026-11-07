/**
 * The Agent Drawer's contract (T-07b, T-07c): clicking a live seat or Peer
 * node on the Workspace opens the read-only, role-aware drawer — header
 * folded from the T-07a fold (role, agent id, lane/model, presence), a Work
 * tab of the owned Tasks (status, Attempt count, deep-link into Task Detail,
 * the Lead's context/queued telemetry), and a Transcript tab through the
 * EXISTING `factory.agent.transcript` client whose three envelope arms
 * render verbatim — entries, `unavailable` with its reason, and a refusal.
 * T-07c adds the remaining role-aware tabs from the snapshot alone: Session
 * (provider/model/lane, presence, attention with its honest reason-absence,
 * the snapshot's own stamp, cwd, the context window where carried),
 * Attempts (each owned Task's ladder — n, verdict, claimed sha,
 * deep-linked), Handoff (the Lead's rotation state, Lead nodes only), and
 * Resources (the rollup's attributed usage rows, or the honest "No usage
 * recorded"). Vacant "Not started" nodes never open it; the drawer closes on
 * Escape and the close button and returns focus to the node; and NO write
 * control exists anywhere inside it (ADR 0017).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import { fixtureAgent, fixtureAttempt, fixtureTask, fixtureView } from "../test/fixture-view.ts";
import { drawerTabsFor, drawerTranscriptModel, flowScreenModel } from "../view-model.ts";
import { FlowScreen } from "./flow.tsx";
import type { LoadAgentTranscript } from "./task-detail.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

// ---- the fixture view -------------------------------------------------------------------------------

/** The scoped SLP Project — live supervisor and telemetry-carrying Lead, one running Peer owning T-07. */
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
  const peerTask = fixtureTask("T-07", "running", [fixtureAttempt(1, "red"), fixtureAttempt(2, "green")]);
  peerTask.agentId = "agent-peer-1";
  view.tasks = [peerTask];
  view.agents = [view.supervisor, view.lead, fixtureAgent("agent-peer-1", { seat: "agent", status: "running", title: "Peer 1", task: "T-07" })];
  // The Project's usage rollup — a Lead seat row and the Peer's Task row; the
  // Supervisor seat carries none (its Resources tab renders the honest absence).
  view.projectUsage = {
    updatedAt: "2026-11-07T09:00:00.000Z",
    totals: { turns: 0, sessionCount: 0, inputUncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, totalCostUsd: null },
    byModel: [],
    bySeat: [
      {
        seat: "lead",
        label: "Lead",
        turns: 4,
        sessionCount: 2,
        inputUncachedTokens: 40_000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 2_000,
        outputTokens: 8_000,
        reasoningTokens: 1_000,
        totalTokens: 60_000,
        totalCostUsd: 0.5,
      },
    ],
    byTask: [
      {
        task: "T-07",
        model: "glm-5.3",
        turns: 3,
        sessionCount: 1,
        inputUncachedTokens: 1_000,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 500,
        outputTokens: 1_500,
        reasoningTokens: 400,
        totalTokens: 5_000,
        totalCostUsd: 0.12,
      },
    ],
  };
  return view;
};

// ---- the pure transcript model -----------------------------------------------------------------------

describe("the drawer's transcript model (pure)", () => {
  it("carries the reply's three envelope arms verbatim — entries, unavailable, and a refusal", () => {
    expect(drawerTranscriptModel({ ok: true, agent: "a", entries: [{ seq: 1, role: "user", kind: "user_message", text: "hi", tool: null, summary: null }] })).toEqual({
      phase: "entries",
      entries: [{ seq: 1, role: "user", kind: "user_message", text: "hi", tool: null, summary: null }],
    });
    expect(drawerTranscriptModel({ ok: true, agent: "a", unavailable: true, reason: "the daemon holds no timeline" })).toEqual({
      phase: "unavailable",
      reason: "the daemon holds no timeline",
    });
    expect(drawerTranscriptModel({ ok: false, code: "unknown-agent", error: "not attributed" })).toEqual({
      phase: "failure",
      code: "unknown-agent",
      error: "not attributed",
    });
  });
});

// ---- the drawer ---------------------------------------------------------------------------------------

describe("the Agent Drawer", () => {
  it("opens on a live seat's click — the header folds role, agent id, lane/model, and presence from the snapshot", () => {
    render(<FlowScreen view={slpView()} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Agent details for Supervisor");
    const header = within(dialog);
    expect(header.getByRole("heading", { level: 2, name: "Supervisor" })).toBeTruthy();
    expect(header.getByText("Live")).toBeTruthy();
    expect(header.getByText("pi · glm-5.3")).toBeTruthy();
    expect(header.getByText("agent-sup-1")).toBeTruthy();
    // The drawer takes focus at its close button — the prototype's open law.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close agent details");
  });

  it("never opens for a vacant Not started node", () => {
    const view = slpView();
    view.agents = [view.supervisor!, view.lead!];
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Peer: Not started" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".agent-drawer")).toBeNull();
  });

  it("renders the Work tab — owned Tasks with status, Attempt count, and the deep-link; the Lead's telemetry on Lead nodes", () => {
    const view = slpView();
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: /^Peer 1: Live/ }));
    const task = screen.getByRole("button", { name: "T-07: running, 2 attempts" });
    expect(screen.getByText("2 attempts")).toBeTruthy();
    fireEvent.click(task);
    expect(window.location.pathname).toBe("/tasks");
    expect(window.location.search).toBe("?task=T-07");

    cleanup();
    window.history.pushState({}, "", "/");
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Lead: Live, pi · glm-5.3" }));
    const work = within(screen.getByRole("dialog"));
    expect(work.getByText("Context")).toBeTruthy();
    expect(work.getByText("40k / 128k")).toBeTruthy();
    expect(work.getByText("Queued mail")).toBeTruthy();
    expect(work.getByText("2", { selector: ".drawer-work-counts strong" })).toBeTruthy();
  });

  it("answers the Work tab's honest empty when the seat owns no Task", () => {
    render(<FlowScreen view={slpView()} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(screen.getByText(/No Tasks are bound to this seat/)).toBeTruthy();
  });

  it("renders the Transcript tab's entries arm — readable messages, the compact tool row", async () => {
    const load: LoadAgentTranscript = () =>
      Promise.resolve({
        ok: true,
        agent: "agent-peer-1",
        entries: [
          { seq: 1, role: "user", kind: "user_message", text: "Claim T-07 and run the gate.", tool: null, summary: null },
          { seq: 2, role: "tool", kind: "tool_call", text: null, tool: "shell", summary: "tool_call/shell: npm test [exit 0]" },
          { seq: 3, role: "assistant", kind: "assistant_message", text: "The gate is green.", tool: null, summary: null },
        ],
      });
    render(<FlowScreen view={slpView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: /^Peer 1: Live/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(await screen.findByText("Claim T-07 and run the gate.")).toBeTruthy();
    expect(screen.getByText("The gate is green.")).toBeTruthy();
    expect(document.querySelector(".console-tr-tool details summary")!.textContent).toBe("shell");
    // The tab loads lazily — only on its first open, through the one client seam.
    expect(screen.getByRole("tab", { name: "Work", selected: false })).toBeTruthy();
  });

  it("renders the Transcript tab's unavailable arm — the honest reason verbatim", async () => {
    const load: LoadAgentTranscript = () => Promise.resolve({ ok: true, agent: "agent-sup-1", unavailable: true, reason: "the daemon holds no timeline for agent agent-sup-1 — a restart wiped the in-memory store" });
    render(<FlowScreen view={slpView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(await screen.findByText(/a restart wiped the in-memory store/)).toBeTruthy();
  });

  it("renders the Transcript tab's refusal arm — the code and sentence as data, never a throw", async () => {
    const load: LoadAgentTranscript = () => Promise.resolve({ ok: false, code: "unknown-agent", error: "agent agent-sup-1 is not attributed to any Task Attempt or Project seat the Factory knows" });
    render(<FlowScreen view={slpView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/The transcript refused \(unknown-agent\)/)).toBeTruthy();
    expect(screen.getByText(/is not attributed to any Task Attempt/)).toBeTruthy();
  });

  it("closes on Escape and returns focus to the node — the selection clears with it", () => {
    render(<FlowScreen view={slpView()} />);
    const supervisor = screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" });
    fireEvent.click(supervisor);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(supervisor);
    expect(supervisor.getAttribute("aria-pressed")).toBe("false");
  });

  it("closes via the close button as well", () => {
    render(<FlowScreen view={slpView()} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    fireEvent.click(document.querySelector(".agent-drawer .icon-btn")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders no write control anywhere inside the drawer (ADR 0017)", async () => {
    const load: LoadAgentTranscript = () => Promise.resolve({ ok: true, agent: "agent-peer-1", unavailable: true, reason: "no timeline" });
    render(<FlowScreen view={slpView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: /^Peer 1: Live/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    await waitFor(() => expect(screen.getByText("no timeline")).toBeTruthy());
    const drawer = document.querySelector(".agent-drawer")!;
    const labels = [...drawer.querySelectorAll("button")].map((button) => button.textContent ?? button.getAttribute("aria-label") ?? "");
    expect(labels).toEqual(expect.arrayContaining(["Work", "Transcript", "Session", "Attempts", "Resources", "Refresh"]));
    expect(labels.some((label) => /start|rotate|revoke|respawn|configure/i.test(label))).toBe(false);
  });

  // ---- the role-aware tabs (T-07c) ------------------------------------------------------------------

  it("renders the Session tab — provider/model/lane, presence, attention, the snapshot's stamp, cwd, and the honest context absence", () => {
    const view = slpView();
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Session" }));
    const session = within(screen.getByRole("tabpanel"));
    expect(session.getByText("Provider")).toBeTruthy();
    expect(session.getByText("pi")).toBeTruthy();
    expect(session.getByText("Model")).toBeTruthy();
    expect(session.getByText("glm-5.3")).toBeTruthy();
    expect(session.getByText("Lane")).toBeTruthy();
    expect(session.getByText("pi/zai/glm-5.3")).toBeTruthy();
    expect(session.getByText("Presence")).toBeTruthy();
    expect(session.getByText("Live")).toBeTruthy();
    expect(session.getByText("Daemon status")).toBeTruthy();
    expect(session.getByText("running")).toBeTruthy();
    expect(session.getByText("Attention")).toBeTruthy();
    expect(session.getByText("Clear")).toBeTruthy();
    expect(session.getByText("Last read")).toBeTruthy();
    expect(session.getByText("2026-11-07T09:00:00.000Z")).toBeTruthy();
    expect(session.getByText("Working directory")).toBeTruthy();
    expect(session.getByText("/Users/owner/code/research-slp")).toBeTruthy();
    // The daemon reports the context pair on the Lead only — the honest absence, never a zero.
    expect(session.getByText("Context window")).toBeTruthy();
    expect(session.getByText("Not carried for this seat")).toBeTruthy();
  });

  it("answers the Session tab's attention arm — Required with the honest reason-absence sentence, and the Lead's carried context window", () => {
    const view = slpView();
    view.supervisor = { ...view.supervisor!, requiresAttention: true };
    view.agents = [view.supervisor!, view.lead!, ...view.agents.slice(2)];
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Needs you, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Session" }));
    const session = within(screen.getByRole("tabpanel"));
    expect(session.getByText("Required")).toBeTruthy();
    expect(session.getByText("The snapshot carries no attention reason.")).toBeTruthy();

    cleanup();
    window.history.pushState({}, "", "/");
    render(<FlowScreen view={slpView()} />);
    fireEvent.click(screen.getByRole("button", { name: "Lead: Live, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Session" }));
    expect(within(screen.getByRole("tabpanel")).getByText("40k / 128k")).toBeTruthy();
  });

  it("renders the Attempts tab — the owned Task's ladder with verdicts and claimed shas, deep-linked into Task Detail", () => {
    render(<FlowScreen view={slpView()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Peer 1: Live/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Attempts" }));
    const panel = within(screen.getByRole("tabpanel"));
    expect(panel.getByText("Attempt ladders")).toBeTruthy();
    const rungs = panel.getAllByRole("listitem");
    expect(rungs.map((rung) => rung.textContent)).toEqual(["#1Gate red1a2c3d4e5f…", "#2Gate green2a2c3d4e5f…"]);
    fireEvent.click(panel.getByRole("button", { name: "T-07: running, 2 attempts — open the Attempt ladder" }));
    expect(window.location.pathname).toBe("/tasks");
    expect(window.location.search).toBe("?task=T-07");
  });

  it("renders the Handoff tab on the Lead only — rotation, queued mail, the locked mailbox, and the context ceiling", () => {
    const view = slpView();
    view.lead = { ...view.lead!, rotationState: "handing_over" };
    view.agents = [view.agents[0]!, view.lead!, view.agents[2]!];
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Lead: Handoff, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Handoff" }));
    const handoff = within(screen.getByRole("tabpanel"));
    expect(handoff.getByText("Rotation")).toBeTruthy();
    expect(handoff.getByText("Handing over")).toBeTruthy();
    expect(handoff.getByText("Queued mail")).toBeTruthy();
    expect(handoff.getByText("2")).toBeTruthy();
    expect(handoff.getByText("Mailbox")).toBeTruthy();
    expect(handoff.getByText("Locked during handoff")).toBeTruthy();
    expect(handoff.getByText("Context used")).toBeTruthy();
    expect(handoff.getByText("40k")).toBeTruthy();
    expect(handoff.getByText("Context ceiling")).toBeTruthy();
    expect(handoff.getByText("128k")).toBeTruthy();

    // The unrecorded rotation state is its own honest spelling — absent reads as normal.
    cleanup();
    window.history.pushState({}, "", "/");
    render(<FlowScreen view={slpView()} />);
    fireEvent.click(screen.getByRole("button", { name: "Lead: Live, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Handoff" }));
    const unrecorded = within(screen.getByRole("tabpanel"));
    expect(unrecorded.getByText("Not recorded")).toBeTruthy();
    expect(unrecorded.getByText("Open")).toBeTruthy();
    expect(unrecorded.getByText(/an absent record reads as normal/)).toBeTruthy();

    // No other role shows the tab at all.
    cleanup();
    window.history.pushState({}, "", "/");
    render(<FlowScreen view={slpView()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Peer 1: Live/ }));
    expect(screen.queryByRole("tab", { name: "Handoff" })).toBeNull();
  });

  it("renders the Resources tab — the rollup's attributed usage rows, and the honest no-usage notice", () => {
    const view = slpView();
    render(<FlowScreen view={view} />);
    // The Lead's seat row — the meter's own sentence over the four disjoint buckets, reasoning shown as a subset.
    fireEvent.click(screen.getByRole("button", { name: "Lead: Live, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    const lead = within(screen.getByRole("tabpanel"));
    expect(lead.getByText("Lead seat")).toBeTruthy();
    expect(lead.getByText("60.0k tokens — in 40.0k · cache read 10.0k · cache write 2.0k · out 8.0k (incl. 1.0k reasoning in output)")).toBeTruthy();
    expect(lead.getByText("4 turns · 2 sessions · $0.50")).toBeTruthy();

    // The Peer's Task row — the rollup attributes a Peer's sessions through the Tasks the ledger binds to it.
    cleanup();
    window.history.pushState({}, "", "/");
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: /^Peer 1: Live/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    const peer = within(screen.getByRole("tabpanel"));
    expect(peer.getByText("Task T-07")).toBeTruthy();
    expect(peer.getByText("5.0k tokens — in 1.0k · cache read 2.0k · cache write 500 · out 1.5k (incl. 400 reasoning in output)")).toBeTruthy();

    // The Supervisor's seat carries no usage row — the honest notice, never an invented zero.
    cleanup();
    window.history.pushState({}, "", "/");
    render(<FlowScreen view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    expect(screen.getByText(/No usage recorded/)).toBeTruthy();
  });
});

// ---- the tabs law (pure) -----------------------------------------------------------------------------

describe("the drawer's role-aware tab law (pure)", () => {
  it("offers Attempts only where the ledger binds Tasks, and Handoff on the Lead only", () => {
    const folded = flowScreenModel(slpView());
    expect(folded).not.toBeNull();
    expect(drawerTabsFor(folded!.supervisor)).toEqual(["work", "transcript", "session", "resources"]);
    expect(drawerTabsFor(folded!.lead)).toEqual(["work", "transcript", "session", "handoff", "resources"]);
    expect(drawerTabsFor(folded!.peers[0]!)).toEqual(["work", "transcript", "session", "attempts", "resources"]);
  });
});
