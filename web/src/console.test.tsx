/**
 * The Web Console shell's contract (T-01): the eight-screen nav renders, the
 * Overview's Project list comes from the real snapshot shape, and the URL
 * route names the screen so a reload keeps it (the prototype's
 * boot-redirect defect, fixed).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { navigate } from "./router.ts";
import { fixtureView } from "./test/fixture-view.ts";
import { pollEvery, snapshotIsBusy } from "./useSnapshot.ts";

const fixtureSnapshot = async () => ({ ok: true as const, view: fixtureView() });

afterEach(() => {
  cleanup();
  navigate("/");
});

describe("the console shell", () => {
  it("renders all eight screens in the left nav", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    const labels = ["All projects", "Workspace", "Tasks", "Activity", "Agents & Models", "Integrations", "Settings", "Inbox"];
    for (const label of labels) {
      expect(await screen.findByRole("button", { name: label }), `nav item "${label}"`).toBeTruthy();
    }
  });

  it("renders the Overview's Project list from the fixture snapshot", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    expect(await screen.findByText("research-slp")).toBeTruthy();
    expect(screen.getByText("web-console-fixture")).toBeTruthy();
    expect(screen.getByText("Agile Scrum")).toBeTruthy();
    expect(screen.getByText("Supervisor live · Lead live")).toBeTruthy();
    expect(screen.getByText("Supervisor vacant · Lead vacant")).toBeTruthy();
  });

  it("feeds the Project switcher from the snapshot", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    const switcher = await screen.findByRole("combobox", { name: "Project" });
    const options = Array.from(switcher.querySelectorAll("option")).map((option) => option.textContent ?? "");
    expect(options[0]).toContain("All projects (2)");
    expect(options.some((text) => text.includes("research-slp · SLP"))).toBe(true);
    expect(options.some((text) => text.includes("web-console-fixture · Agile Scrum"))).toBe(true);
  });

  it("keeps the screen across a reload — the path names the screen", () => {
    window.history.pushState({}, "", "/tasks");
    render(<App loadSnapshot={fixtureSnapshot} />);
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    window.history.pushState({}, "", "/inbox");
    cleanup();
    render(<App loadSnapshot={fixtureSnapshot} />);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
  });

  it("navigating the nav pushes the route", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    fireEvent.click(await screen.findByRole("button", { name: "Integrations" }));
    expect(window.location.pathname).toBe("/integrations");
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Integrations" }).className).toContain("active");
  });

  it("carries no seat-start controls (ADR 0017)", async () => {
    render(<App loadSnapshot={fixtureSnapshot} />);
    await screen.findByText("research-slp");
    const buttons = screen.queryAllByRole("button").map((button) => button.textContent ?? "");
    for (const label of buttons) {
      expect(label.toLowerCase()).not.toContain("start supervisor");
      expect(label.toLowerCase()).not.toContain("start lead");
    }
  });

  it("holds the adaptive poll law — 5s busy, 30s quiet", () => {
    const quiet = fixtureView();
    quiet.kpis = { needsHuman: 0, running: 0, readyToAccept: 1, accepted: 3, totalCostUsd: 0, totalTokens: 0 };
    expect(pollEvery(snapshotIsBusy(quiet))).toBe(30000);
    const busy = fixtureView();
    busy.kpis = { ...busy.kpis, running: 1 };
    expect(pollEvery(snapshotIsBusy(busy))).toBe(5000);
    const needsOwner = fixtureView();
    needsOwner.kpis = { ...needsOwner.kpis, needsHuman: 2 };
    expect(pollEvery(snapshotIsBusy(needsOwner))).toBe(5000);
  });
});
