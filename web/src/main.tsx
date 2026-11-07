/**
 * The Web Console entry — mounts the shell and applies the Open Design
 * tokens from `design/design-manifest.json` to `:root` so the committed
 * design system (CSS + tokens, ADR 0051 §6) stays the one source of visual
 * truth. The prototype's JS wiring is discarded; its CSS is imported.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import manifest from "../../design/design-manifest.json";
import "../../design/styles.css";
import "../../design/fleet.css";
import "../../design/team-space.css";
import "./console.css";
import { App } from "./App.tsx";

function applyDesignTokens(tokens: Record<string, string>): void {
  for (const [name, value] of Object.entries(tokens)) {
    if (name.startsWith("--")) document.documentElement.style.setProperty(name, value);
  }
}

applyDesignTokens(manifest.tokens as Record<string, string>);
const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<StrictMode><App /></StrictMode>);
