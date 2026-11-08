/**
 * The Supervisor Live Chat panel's contract (T-13a, ADR 0051 §3/§5): opening
 * the Agent Drawer on the Project's Supervisor seat renders the read-only
 * chat panel as the drawer body's FIRST child — the EXISTING
 * `factory.agent.transcript` read folded to conversation turns ("You
 * (Owner)" / "Supervisor", each keyed on the timeline seq — the transcript
 * carries no wall clock), the provider · model badge from the snapshot, and
 * NO composer: no textbox, no send button, no quick-chip — one line of
 * honest copy says messaging the Supervisor stays in Paseo. The panel stays
 * live while the drawer is open (its own interval plus every snapshot
 * change, both through the one injectable transport) and stops on close.
 * Every arm renders as data: loading, a refusal's code and sentence, the
 * honest unavailable reason, the empty conversation, and a seat gone vacant
 * mid-open. Non-Supervisor seats keep the drawer exactly as it was — no
 * panel at all.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import { fixtureAgent, fixtureView } from "../test/fixture-view.ts";
import type { AgentTranscriptReply } from "../transcript.ts";
import { supervisorChatModel } from "../view-model.ts";
import { FlowScreen } from "./flow.tsx";
import { SUPERVISOR_CHAT_POLL_MS } from "./supervisor-chat.tsx";
import type { LoadAgentTranscript } from "./task-detail.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.pushState({}, "", "/");
});

// ---- the fixture view -------------------------------------------------------------------------------

/** The scoped SLP Project — a live Supervisor and Lead, plus one working Peer for the non-Supervisor assertions. */
const supView = (): FactoryView => {
  const view = fixtureView();
  view.project = { ...view.projects[0]!, executionMode: "slp" };
  view.supervisor = fixtureAgent("agent-sup-1", { seat: "supervisor", status: "running", title: "Supervisor" });
  view.lead = fixtureAgent("agent-lead-1", { seat: "lead", status: "running", title: "Lead" });
  view.agents = [view.supervisor, view.lead, fixtureAgent("agent-peer-1", { seat: "agent", status: "running", title: "Peer 1" })];
  return view;
};

// ---- the fold (pure) ----------------------------------------------------------------------------------

describe("the chat fold (pure)", () => {
  it("folds the transcript tail to conversation turns — owner and supervisor labels, seq as the honest turn position, tool and system chrome folded away", () => {
    const folded = supervisorChatModel({
      ok: true,
      agent: "agent-sup-1",
      entries: [
        { seq: 1, role: "user", kind: "user_message", text: "Plan the wave.", tool: null, summary: null },
        { seq: 2, role: "tool", kind: "tool_call", text: null, tool: "shell", summary: "tool_call/shell: npm test [exit 0]" },
        { seq: 3, role: "assistant", kind: "assistant_message", text: "Dispatching T-07.", tool: null, summary: null },
        { seq: 4, role: "system", kind: "compaction", text: null, tool: null, summary: "compaction" },
        { seq: 5, role: "user", kind: "user_message", text: null, tool: null, summary: "the summary line a text-less turn carries" },
      ],
    });
    expect(folded).toEqual({
      phase: "chat",
      messages: [
        { seq: 1, sender: "owner", label: "You (Owner)", text: "Plan the wave." },
        { seq: 3, sender: "supervisor", label: "Supervisor", text: "Dispatching T-07." },
        { seq: 5, sender: "owner", label: "You (Owner)", text: "the summary line a text-less turn carries" },
      ],
    });
  });

  it("carries the reply's other two envelope arms verbatim — the honest unavailable reason and the refusal's code and sentence", () => {
    expect(supervisorChatModel({ ok: true, agent: "a", unavailable: true, reason: "the daemon holds no timeline" })).toEqual({
      phase: "unavailable",
      reason: "the daemon holds no timeline",
    });
    expect(supervisorChatModel({ ok: false, code: "unknown-agent", error: "not attributed" })).toEqual({
      phase: "failure",
      code: "unknown-agent",
      error: "not attributed",
    });
  });

  it("answers an empty transcript with the empty conversation — no invented greeting", () => {
    expect(supervisorChatModel({ ok: true, agent: "a", entries: [] })).toEqual({ phase: "chat", messages: [] });
  });
});

// ---- the panel ------------------------------------------------------------------------------------------

describe("the Supervisor Live Chat panel", () => {
  it("renders on the Supervisor seat as the drawer body's first child — turns, the provider · model badge, and NO composer", async () => {
    const load: LoadAgentTranscript = () =>
      Promise.resolve({
        ok: true,
        agent: "agent-sup-1",
        entries: [
          { seq: 1, role: "user", kind: "user_message", text: "Plan the wave.", tool: null, summary: null },
          { seq: 2, role: "tool", kind: "tool_call", text: null, tool: "shell", summary: "tool_call/shell: factory ledger tail [exit 0]" },
          { seq: 3, role: "assistant", kind: "assistant_message", text: "Dispatching T-07.", tool: null, summary: null },
        ],
      });
    render(<FlowScreen view={supView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(await screen.findByText("Dispatching T-07.")).toBeTruthy();
    // The design's placement law: the panel is the drawer body's first child, above the tabs.
    const body = document.querySelector(".agent-drawer-body")!;
    expect(body.firstElementChild!.classList.contains("sup-chat-panel")).toBe(true);
    const panel = within(document.querySelector(".sup-chat-panel")!);
    expect(panel.getByText("Supervisor Chat")).toBeTruthy();
    expect(panel.getByText("pi · glm-5.3")).toBeTruthy();
    expect(panel.getByText("You (Owner) · seq 1")).toBeTruthy();
    expect(panel.getByText("Supervisor · seq 3")).toBeTruthy();
    expect(panel.getByText("Plan the wave.")).toBeTruthy();
    // Tool calls are not conversation turns — the Transcript tab keeps the full tail.
    expect(document.querySelector(".sup-chat-panel")!.textContent).not.toContain("factory ledger tail");
    // NO composer anywhere in the panel: no textbox, no send button, no quick-chip, no input element at all.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector(".sup-chat-panel input, .sup-chat-panel textarea")).toBeNull();
    expect(document.querySelector(".sup-chat-compose")).toBeNull();
    expect(document.querySelector(".sup-chat-chip")).toBeNull();
    expect([...document.querySelector(".sup-chat-panel")!.querySelectorAll("button")]).toEqual([]);
    expect(screen.getByText(/Read-only — messaging the Supervisor stays in Paseo for now\./)).toBeTruthy();
  });

  it("renders no panel on the Lead or a Peer drawer — non-Supervisor seats keep the drawer exactly as it was", () => {
    const load: LoadAgentTranscript = () => Promise.resolve({ ok: true, agent: "x", unavailable: true, reason: "no timeline" });
    render(<FlowScreen view={supView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Lead: Live, pi · glm-5.3" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector(".sup-chat-panel")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /^Peer 1: Live/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector(".sup-chat-panel")).toBeNull();
  });

  it("stays live while the drawer is open — its own interval re-reads, and the clock stops on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const replies: AgentTranscriptReply[] = [
      { ok: true, agent: "agent-sup-1", entries: [{ seq: 1, role: "user", kind: "user_message", text: "Plan the wave.", tool: null, summary: null }] },
      {
        ok: true,
        agent: "agent-sup-1",
        entries: [
          { seq: 1, role: "user", kind: "user_message", text: "Plan the wave.", tool: null, summary: null },
          { seq: 3, role: "assistant", kind: "assistant_message", text: "Dispatching T-07.", tool: null, summary: null },
        ],
      },
    ];
    const load = vi.fn(() => Promise.resolve(replies.shift()!));
    render(<FlowScreen view={supView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(await screen.findByText("Plan the wave.")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    // The live cadence: one interval tick, one re-read — the new turn lands without a flash of loading.
    await act(async () => {
      vi.advanceTimersByTime(SUPERVISOR_CHAT_POLL_MS);
    });
    expect(await screen.findByText("Dispatching T-07.")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    // Close stops the clock — no further read fires, however long the drawer stays shut.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SUPERVISOR_CHAT_POLL_MS * 3);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("re-reads when the snapshot changes — the fold's own stamp is the effect's key", async () => {
    const view = supView();
    const load = vi.fn<LoadAgentTranscript>(() =>
      Promise.resolve({
        ok: true,
        agent: "agent-sup-1",
        entries: [{ seq: 1, role: "user", kind: "user_message", text: "Plan the wave.", tool: null, summary: null }],
      }),
    );
    const { rerender } = render(<FlowScreen view={view} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(await screen.findByText("Plan the wave.")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    // A fresh snapshot (its `generatedAt` stamp moved) re-reads the chat — no interval needed.
    rerender(<FlowScreen view={{ ...view, generatedAt: "2026-11-07T09:00:05.000Z" }} loadTranscript={load} />);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("answers the refusal arm — the code and sentence as data, never a throw", async () => {
    const load: LoadAgentTranscript = () =>
      Promise.resolve({ ok: false, code: "unknown-agent", error: "agent agent-sup-1 is not attributed to any Task Attempt or Project seat the Factory knows" });
    render(<FlowScreen view={supView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toBe("The Supervisor chat read refused (unknown-agent): agent agent-sup-1 is not attributed to any Task Attempt or Project seat the Factory knows");
  });

  it("answers the unavailable arm — the honest reason verbatim", async () => {
    const load: LoadAgentTranscript = () =>
      Promise.resolve({ ok: true, agent: "agent-sup-1", unavailable: true, reason: "the daemon holds no timeline for agent agent-sup-1 — a restart wiped the in-memory store" });
    render(<FlowScreen view={supView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(await screen.findByText(/a restart wiped the in-memory store/)).toBeTruthy();
  });

  it("answers the empty transcript — the honest empty conversation, never an invented greeting", async () => {
    const load: LoadAgentTranscript = () => Promise.resolve({ ok: true, agent: "agent-sup-1", entries: [] });
    render(<FlowScreen view={supView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(await screen.findByText(/The Supervisor conversation is empty/)).toBeTruthy();
  });

  it("answers a seat gone vacant mid-open — no live Supervisor seat, and no read fires for a dead id", async () => {
    const view = supView();
    const load = vi.fn<LoadAgentTranscript>(() =>
      Promise.resolve({
        ok: true,
        agent: "agent-sup-1",
        entries: [{ seq: 1, role: "user", kind: "user_message", text: "Plan the wave.", tool: null, summary: null }],
      }),
    );
    const { rerender } = render(<FlowScreen view={view} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(await screen.findByText("Plan the wave.")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    // The next snapshot carries no Supervisor — the panel tracks the seat, and the honest state replaces the chat.
    const vacant = supView();
    vacant.supervisor = null;
    vacant.agents = [vacant.lead!];
    rerender(<FlowScreen view={vacant} loadTranscript={load} />);
    expect(await screen.findByText(/No live Supervisor seat/)).toBeTruthy();
    // A vacant seat keeps no clock and reads no dead id — the call count stays where the live seat left it.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows its loading state until the first reply lands", async () => {
    let resolve!: (reply: AgentTranscriptReply) => void;
    const load: LoadAgentTranscript = () => new Promise<AgentTranscriptReply>((done) => (resolve = done));
    render(<FlowScreen view={supView()} loadTranscript={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Supervisor: Live, pi · glm-5.3" }));
    expect(screen.getByText("Loading the Supervisor chat…")).toBeTruthy();
    resolve({ ok: true, agent: "agent-sup-1", entries: [{ seq: 1, role: "user", kind: "user_message", text: "Plan the wave.", tool: null, summary: null }] });
    expect(await screen.findByText("Plan the wave.")).toBeTruthy();
  });
});
