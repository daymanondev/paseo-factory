/// <reference types="vitest" />
/**
 * The Web Console's build config (ADR 0051 §2) — the production bundle lands
 * as a committed, generated artifact in `plugin/web/` (installation stays
 * build-free; `scripts/build-web.mjs --check` fails `npm run check` when it
 * drifts). The dev server allows the repo root so the app imports the
 * prototype's CSS straight from `design/` — the design system is reused, not
 * copied.
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: fileURLToPath(new URL("../plugin/web", import.meta.url)),
    emptyOutDir: true,
    target: "es2020",
  },
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
