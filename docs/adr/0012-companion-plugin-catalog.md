# ADR 0012 — Remote-first `Companion plugin` catalog and lifecycle on the `Factory surface`

- **Status:** Accepted — 2026-10-17 (ratified by Andrew over a two-round `/grill-with-docs`, all-recommended; words "toàn bộ theo gợi ý của bạn")
- **Grounded in:** `@getpaseo/protocol@0.11.4` (`messages.d.ts:1468-1660`, `plugin.{list,source.install,source.update,directory.install,enable,disable,reload,remove}.request`) · `@getpaseo/client@0.11.4` (`daemon-client.js:3626-3803`) · `plugin/server/daemon-cli.ts` (`daemonWsRequest`) · `plugin/client/factory/shell.tsx` · `daymanondev/factory-burn-lab` (`plugin/paseo-plugin.json`) · `daymanondev/factory-connector` (`plugin/paseo-plugin.json`)
- **Amends:** ADR 0009 §2 (expands the `Factory surface` `TabBar` from three views to four views by adding `Plugins` for `Companion plugin` discovery and lifecycle control)

## Context

`paseo-factory` is the verification core of a broader factory plugin family that includes two independent first-party Paseo plugins:
- **`factory-burn-lab`** — autonomous OpenCode free-model burner (`Scout Pool`, `OSS Lab`, `Proto Arena`, `Night Shift`, `Self-Evolve`) supervised by each Project's `Supervisor` seat.
- **`factory-connector`** — symmetric peer Fleet over Tailscale (`Fleet surface`, 1-click Handoff, cooperative Burst, Fleet pulse, and Git-native Mirror repo / Fleet ref sync).

Keeping `factory-burn-lab` and `factory-connector` in separate repositories and separate Paseo plugins preserves clean fault and bundle boundaries, but forces any user who installs `paseo-factory` (on macOS or Windows) to manually discover and run `paseo plugin install ...` commands for the companion plugins. Conversely, hardcoding or probing host-local sibling paths (`../factory-burn-lab`, `../factory-connector`) would couple the product to the author's local filesystem layout and fail for real users.

Paseo's daemon WebSocket session protocol already exposes first-class, cross-platform plugin management messages (`plugin.list.request`, `plugin.source.install.request`, `plugin.source.update.request`, `plugin.directory.install.request`, `plugin.enable.request`, `plugin.disable.request`, `plugin.reload.request`, `plugin.remove.request`), which `paseo-factory` can invoke directly over its existing local daemon WebSocket bridge (`<home>/paseo.pid` + `<home>/local-credential`) with zero POSIX shell assumptions.

## Decision

1. **Fourth `Plugins` view on the `Factory surface` (`TabBar`).**
   - `FactoryShell` (`plugin/client/factory/shell.tsx`) and `TabBar` (`plugin/client/kit/pill.tsx`) add a fourth tab **`Plugins`** (`id: "plugins"`, icon `"Blocks"`), displaying a badge count of currently running `Companion plugin`s (`0..2`) and accessible from the global screen, workspace panel, and settings screen.

2. **100% Remote-first, cross-platform (`macOS` & `Windows`) `Companion plugin` catalog.**
   - `paseo-factory` ships a built-in catalog of official `Companion plugin`s anchored to their canonical GitHub sources:
     - `factory-burn-lab` → `git:daymanondev/factory-burn-lab:plugin`
     - `factory-connector` → `git:daymanondev/factory-connector:plugin`
   - Clicking **`Install`** (or **`Install All`**) dispatches `plugin.source.install.request` with the canonical GitHub source over the daemon WebSocket (`daemonWsRequest`), allowing the Paseo daemon to clone and load the plugin into `<home>/plugins/...` identically on macOS and Windows.
   - The server **never** probes or prioritizes `../` sibling directories on the host disk.
   - For developer workflows (testing a branch, fork, or local checkout path), each card offers a compact expandable **`Custom source / ref…`** option (dispatching `plugin.source.install.request` with custom `source`/`ref`, or `plugin.directory.install.request` when given a local filesystem path).

3. **Full lifecycle controls and post-install sidebar guidance.**
   - Every snapshot/poll reads live plugin state from the daemon (`plugin.list.request`), surfacing each `Companion plugin`'s status (`not_installed` | `running` | `disabled` | `failed`), installed source identity (`git` remote + `currentRevision` or `directory` path), and any daemon error message.
   - Each card exposes context-appropriate actions:
     - When `not_installed`: **`Install`** (plus top-level **`Install All`** when any companion is uninstalled) and **`Custom source…`**.
     - When installed: **`Enable`** / **`Disable`**, **`Update`** (via `plugin.source.update.request` when installed from `git`/`npm`), **`Reload`** (`plugin.reload.request`), and **`Remove`** (`plugin.remove.request`).
   - When `status === "running"`, the card displays an **`Active in Sidebar`** badge naming the companion's Paseo sidebar entry and icon (`Burn Lab` · `Flame`, `Fleet Connector` · `Network`) so the `Owner` immediately knows where to open the companion surface.

4. **Strict Daemon Home isolation.**
   - All `Companion plugin` queries and mutations execute strictly against the `home` of the Paseo daemon process hosting that `Factory surface` (`~/.paseo` in production Desktop vs `~/.paseo-factory` in trial runs), preserving the trial/prod boundary.

## Consequences

- `CONTEXT.md` gains **Companion plugin** and updates **Factory surface** to four views (`Tasks`, `Seats & Models`, `Timeline & Retro`, `Plugins`).
- Any user on macOS or Windows who installs `paseo-factory` can install, update, reload, enable/disable, or remove `factory-burn-lab` and `factory-connector` in one click from the `Plugins` tab.
- Once `factory-connector` is pushed to `https://github.com/daymanondev/factory-connector`, both companions install out of the box from GitHub with zero local filesystem setup.
