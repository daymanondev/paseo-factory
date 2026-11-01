# 0041 — GUI Open Design Project Link, Dual-Path RPC Studio Relay, and Windows 11 Runtime Parity

- **Date:** 2026-11-01
- **Status:** Accepted
- **Amends:** ADR 0025 (`Factory surface` Header), ADR 0037 & ADR 0040 (`Design overview canvas` & Open Design integration), ADR 0039 (`Helper MCP catalog`)
- **Preserves:** ADR 0001–0036, ADR 0038, ADR 0040

## Context

When the Owner designs an application first in `/Applications/Open Design.app` (`v0.26.1`) on their MacBook and then builds it with `paseo-factory` across either local or remote execution nodes (`andrews-mac-mini` M4 16GB/256GB and a Windows 11 PC 32GB/1TB on the same home LAN), four structural gaps appeared:

1. **No GUI Bridge for Pre-Existing Open Design Projects (`SLP` & `Scrum`):**
   - Open Design stores every project as plain HTML/CSS/JS files (`index.html`, `screens.html`, `styles.css`, `app.js`, `app-data.js`, `screens.css`, `screens.js`, `screens-data.js`, `.od-frames/*`, `assets/*`) at `~/Library/Application Support/Open Design/namespaces/release-stable/data/projects/<id>/` indexed by `app.sqlite` (`TABLE projects`).
   - However, `paseo-factory` had no GUI picker to link an existing Open Design project to a `paseo-factory` Project, forcing manual CLI copy/export commands, and had no automatic re-sync when the Owner updated screens in Open Design.
   - Furthermore, `discoverHelperMcps` (`src/helper-mcp-sync.ts`) did not auto-discover Open Design's built-in MCP server (`daemon-cli.mjs mcp`), and `scopeScrumCapabilities` (`src/scrum/harness.ts`) filtered out `open-design` from Scrum specialist MCP configurations.

2. **Strict `Private vault` Boundary:**
   - `Private vault` (`factory-vault`) is strictly for secrets, credentials, operational lane/MCP configs, and compact run ledger metadata. Storing multi-megabyte HTML/CSS/SVG project UI bundles in `factory-vault` would pollute the secret repository across unrelated projects.

3. **Multi-Machine Design Review & Ephemeral Port Firewalls:**
   - `servePreview` (`src/scrum/preview-server.ts`) binds an ephemeral HTTP port (`0.0.0.0:0`). On Windows 11 (and across NAT/SSH boundaries), Windows Defender Firewall blocks arbitrary ephemeral ports, and `resolveReachableStudioUrl` (`plugin/client/factory/scrum.tsx`) contained a fallback bug (`return firstRemote ?? candidates[1] ?? candidates[0]!`) that returned an unreachable remote URL and opened a dead browser tab when all HTTP probes failed.
   - `SLP` mode also had no 1-click `Open Design Studio` preview for linked `design/` artifacts.

4. **Five Native Windows 11 (`win32`) Runtime Blockers:**
   - Running heavy projects or game builds natively on Windows 11 (`32GB RAM / 1TB SSD`) hit five OS-specific incompatibilities:
     1. `fsyncDirectory` (`src/history-stage.ts`, `src/scrum/selection.ts`) calls `openSync(dirPath, "r")` + `fsyncSync`, which throws `EISDIR` / `EPERM` / `EBADF` on `win32`.
     2. `prepareScrumContract` (`plugin/server/scrum-contract.ts`) wraps command paths in single quotes (`'...'`), which `cmd.exe` (`spawn(cmd, { shell: true })` in `src/gate.ts`) treats as literal characters rather than path quotes.
     3. `src/agy-home.ts` emits POSIX inline env syntax (`ELECTRON_RUN_AS_NODE=1 ...`) in `hooks.json`, and `src/scrum/harness.ts` writes only a POSIX `#!/bin/sh` `od` wrapper without an `od.cmd` shim on Windows.
     4. `buildToolInstallEnv` (`src/scrum/companion-tools.ts`) hardcodes `:` instead of `path.delimiter` (`;` on Windows).
     5. `verifyQaFiles` (`src/scrum/qa-bundle.ts`) hashes working-tree files (`readFileSync`) while `verifyRefs` (`src/scrum/artifacts.ts`) hashes Git blobs (`git show`), which diverges on Windows if `core.autocrlf=true`.

## Decision

1. **GUI `Open Design project link` on Project Header (`SLP` & `Scrum`) + Auto-Sync on Dispatch:**
   - Add an **`Open Design project link`** control (`🎨 Link Open Design…` / `🎨 <Project Name> · Synced` / `Update available — Sync` / `Open Design Studio`) to the Project Header (`plugin/client/factory/header.tsx`).
   - Discover Open Design projects directly from `~/Library/Application Support/Open Design/namespaces/release-stable/data/app.sqlite` (`TABLE projects`) and `data/projects/<id>/` (plus Windows `%APPDATA%\Open Design` / Linux `~/.config/Open Design` equivalents) without requiring `Open Design.app` to be running.
   - Linking or syncing copies/pushes the complete Open Design artifact bundle over Paseo RPC into the Project's own Git repository:
     - **`SLP` Mode:** Materializes into `<project-root>/design/` (`index.html`, `screens.html`, `styles.css`, `app.js`, `app-data.js`, `screens.css`, `screens.js`, `screens-data.js`, `.od-frames/*`, `assets/*`, `design-manifest.json`, and `open-design-link.json`) and injects the authoritative design summary into `buildSeatKickoffPacket` (`src/preflight.ts`) and `ROLE_PROMPTS` (`src/roles-contract.ts`).
     - **`Agile Scrum` Mode:** Materializes into `<project-root>/design/` and automatically seeds `.scratch/<initiativeId>/mockups/` when a Scrum run or `UX` task is initialized so `UX`, `Architect`, `Dev`, and `QA` build directly upon the Owner's linked design.
   - Whenever the linked Open Design project has a newer `updated_at` / content digest on the host where Open Design resides, the Header pill surfaces `Update available — Sync`, and dispatching a directive to `Supervisor` or `Lead` **auto-syncs** the latest Open Design bundle before the seat turn begins.
   - **Never store project UI designs in `Private vault` (`factory-vault`)**; designs reside strictly in each Project's Git repository so remote nodes (`andrews-mac-mini`, Windows 11 PC) read them locally with zero runtime dependency on the MacBook's `Open Design.app`.

2. **Auto-Discovery of `open-design` in `Helper MCP catalog` (Default Opt-In Preserved):**
   - Extend `discoverHelperMcps` (`src/helper-mcp-sync.ts`) to auto-discover Open Design's built-in MCP server (`daemon-cli.mjs mcp` with `ELECTRON_RUN_AS_NODE=1`) when `/Applications/Open Design.app` (or `OPEN_DESIGN_RESOURCE_ROOT`) is installed, collapsing `open-design` / `open_design` aliases.
   - Per ADR 0039's Selective Opt-In Law, discovered `open-design` defaults to **`Available on Host` (`enabled: false`)** until the Owner clicks **`+ Sync to Peer`**, and `scopeScrumCapabilities` (`src/scrum/harness.ts`) includes `open-design|open_design` so enabled `open-design` MCP tools work in both `SLP` and `Scrum` Peer sessions.

3. **Dual-Path `Design overview canvas` (`LAN/Tailscale HTTP` + `Zero-Firewall RPC Studio Bundle`):**
   - Fix `resolveReachableStudioUrl` so it returns `null` when all HTTP candidate URLs fail health probing (never opening a dead browser tab), and support optional fixed `PASEO_FACTORY_PREVIEW_PORT` binding on `servePreview`.
   - Add a `preview.bundle` RPC operation (`factory.scrum.command` / `factory.design.preview`) that returns a self-contained `Design overview canvas` payload (`screens.html` Flow Board, `index.html` Prototype in `.od-frames/`, `DESIGN.md` / `design-manifest.json` tokens, and RPC-backed `Approve` / `Request Changes` / `Pin Comment` submission) over Paseo's existing connection whenever direct HTTP to a remote node is blocked by Windows Firewall or NAT, and enable opening `Design Studio` in both `SLP` and `Scrum` modes.

4. **Windows 11 (`win32`) Native Runtime Parity:**
   - Guard `fsyncDirectory` on `win32` (ignoring `EISDIR` / `EPERM` / `EBADF` when fsyncing directories on Windows).
   - Replace single-quote path quoting in `prepareScrumContract` (`plugin/server/scrum-contract.ts`) with cross-platform double-quote quoting compatible with both POSIX `sh` and Windows `cmd.exe`.
   - Use `node -e` / cross-platform wrapper invocation in `src/agy-home.ts` (`hooks.json`) and emit both `od` and `od.cmd` in `src/scrum/harness.ts`.
   - Use `path.delimiter` in `buildToolInstallEnv` (`src/scrum/companion-tools.ts`).
   - Normalize CRLF / Git blob hashing (`core.autocrlf=false` in allocated worktrees and Git-blob-consistent hashing in `verifyQaFiles`) so QA bundle verification is deterministic on Windows 11.
