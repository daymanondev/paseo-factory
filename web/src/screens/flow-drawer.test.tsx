/**
 * The Agent Drawer's contract (T-07b): clicking a live seat or Peer node on
 * the Workspace opens the read-only, role-aware drawer — header folded from
 * the T-07a fold (role, agent id, lane/model, presence), a Work tab of the
 * owned Tasks (status, Attempt count, deep-link into Task Detail, the Lead's
 * context/queued telemetry), and a Transcript tab through the EXISTING
 * `factory.agent.transcript` client whose three envelope arms render
 * verbatim — entries, `unavailable` with its reason, and a refusal. Vacant
 * "Not started" nodes never open it; the drawer closes on Escape and the
 * close button and returns focus to the node; and NO write control exists
 * anywhere inside it (ADR 0017).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import { fixtureAgent, fixtureAttempt, fixtureTask, fixtureView } from "../test/fixture-view.ts";
import { drawerTranscriptModel } from "../view-model.ts";
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
  const peerTask = fixtureTask("T-07", "running", [fixtureAttempt(1, null), fixtureAttempt(2, "green")]);
  peerTask.agentId = "agent-peer-1";
  view.tasks = [peerTask];
  view.agents = [view.supervisor, view.lead, fixtureAgent("agent-peer-1", { seat: "agent", status: "running", title: "Peer 1", task: "T-07" })];
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
    expect(labels).toEqual(expect.arrayContaining(["Work", "Transcript", "Refresh"]));
    expect(labels.some((label) => /start|rotate|revoke|respawn|configure/i.test(label))).toBe(false);
  });
});
