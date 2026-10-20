# ADR 0012 — Remote-first `Companion plugin` catalog, Core + Companions `Plugins` view, on-demand update checking, and lifecycle on the `Factory surface`

- **Status:** Accepted — 2026-10-17; amended 2026-10-20 for `v0.0.25` after live UX review (ratified by Andrew over `/grill-with-docs`; words "toàn bộ theo khuyến nghị của bạn, nhưng check lại version, vì giờ version đã khác")
- **Grounded in:** `@getpaseo/protocol@0.11.4` (`messages.d.ts:1468-1660`, `plugin.{list,source.status,source.update.preview,source.install,source.update,directory.install,enable,disable,reload,remove}.request`) · `@getpaseo/client@0.11.4` (`daemon-client.js:3626-3803`) · `plugin/server/daemon-cli.ts` (`daemonWsRequestPayload`) · `plugin/client/factory/plugins.tsx` · `plugin/client/factory/shell.tsx` · `daymanondev/factory-burn-lab` (`package.json`) · `daymanondev/factory-connector` (`package.json`) · `daymanondev/factory-release-lab` (`package.json`)
- **Amends:** ADR 0009 §2 (expands the `Factory surface` `TabBar` from three views to four views by adding `Plugins` for Core + `Companion plugin` version visibility, on-demand update checking, and lifecycle control)

## Context

`paseo-factory` is the verification core of a broader factory plugin family that includes three independent first-party Paseo plugins (ADR 0014):
- **`factory-burn-lab`** — autonomous OpenCode free-model burner (`Scout Pool`, `OSS Lab`, `Proto Arena`, `Night Shift`, `Self-Evolve`) supervised by each Project's `Supervisor` seat.
- **`factory-connector`** — symmetric peer Fleet over Tailscale (`Fleet surface`, 1-click Handoff, cooperative Burst, Fleet pulse, and Git-native Mirror repo / Fleet ref sync).
- **`factory-release-lab`** — sequential 7-phase iOS & Android store-ops and release workflow engine.

Keeping `factory-burn-lab`, `factory-connector`, and `factory-release-lab` in separate repositories and separate Paseo plugins preserves clean fault and bundle boundaries, but forces any user who installs `paseo-factory` (on macOS or Windows) to manually discover and run `paseo plugin install ...` commands for the companion plugins. Conversely, hardcoding or probing host-local sibling paths (`../factory-burn-lab`, `../factory-connector`) would couple the product to the author's local filesystem layout and fail for real users.

Paseo's daemon WebSocket session protocol already exposes first-class, cross-platform plugin management and update-status messages (`plugin.list.request`, `plugin.source.status.request`, `plugin.source.update.preview.request`, `plugin.source.install.request`, `plugin.source.update.request`, `plugin.directory.install.request`, `plugin.enable.request`, `plugin.disable.request`, `plugin.reload.request`, `plugin.remove.request`), which `paseo-factory` can invoke directly over its existing local daemon WebSocket bridge (`<home>/paseo.pid` + `<home>/local-credential`) with zero POSIX shell assumptions.

### Live UX Findings from v0.0.24 Trial (2026-10-20 Amendment)

Auditing the `Plugins` tab on Paseo Desktop exposed four concrete UX problems:
1. **Visual Clutter on Card Faces:** Each companion card stacked 6 separate blocks (`Title + id + status`, `tagline`, `description`, `capabilities` chips, an always-visible bordered `INSTALL` box with raw Git URLs, and 4 always-visible action buttons `Disable` · `Update` · `Reload` · `Remove`), creating heavy visual noise across 3–4 plugins.
2. **Missing Semantic Version (`vX.Y.Z`) & Zero Update Visibility:** Although `plugin.list.request` returns each plugin's `path` (where `<path>/package.json` or `<path>/../package.json` declares `"version"`) and `currentRevision`, the UI never surfaced `vX.Y.Z` (`v0.0.25`, `v0.0.5`, `v0.0.3`, `v0.0.2`) and never queried `plugin.source.status.request` (`updateAvailable`, `latestCommit`, `commitsBehind`). The `Owner` had no way to tell which version was installed or whether a newer version existed on GitHub.
3. **Always-Lit `Update` Button & Misleading Toast:** Every `git`/`npm`-installed plugin rendered an active `Update` button even when `commitsBehind === 0` (`updateAvailable === false`), and `pluginsManageSummary` unconditionally toasted `"updated <id> to the latest revision"` even when `plugin.source.update.response` returned `updated: false`.
4. **Core Plugin (`paseo-factory`) Invisible in `Plugins` Tab:** `paseo-factory` itself was omitted from the `Plugins` tab, leaving the `Owner` no single place to inspect the Core version/revision or check/update/reload `paseo-factory` alongside its 3 companions.

## Decision

1. **Fourth `Plugins` view on the `Factory surface` (`TabBar`) with Compact Toolbar.**
   - `FactoryShell` (`plugin/client/factory/shell.tsx`) and `TabBar` (`plugin/client/kit/pill.tsx`) provide the fourth tab **`Plugins`** (`id: "plugins"`, icon `"Blocks"`), displaying a badge count of currently running `Companion plugin`s (`0..3`) and accessible from the global screen, workspace panel, and settings screen.
   - The `Plugins` tab opens with a compact 1-line toolbar showing ecosystem status (`Core + 3 Companions · N active on this daemon`), last update-check status (`Up to date`, `N update(s) available`, or `Checking updates…`), **`Check for updates`**, conditional **`Update All (N)`** (shown only when $\ge 1$ installed plugin has `updateAvailable === true`), and conditional **`Install All`** (shown when any companion is `not_installed`).

2. **100% Remote-first, cross-platform (`macOS` & `Windows`) catalog: Core (`paseo-factory`) + 3 `Companion plugin`s.**
   - `paseo-factory` ships `CORE_PLUGIN_ENTRY` (`paseo-factory` → `git:daymanondev/paseo-factory:plugin`) plus the built-in `COMPANION_CATALOG` of three official `Companion plugin`s anchored to their canonical GitHub sources:
     - `factory-burn-lab` → `git:daymanondev/factory-burn-lab:plugin`
     - `factory-connector` → `git:daymanondev/factory-connector:plugin`
     - `factory-release-lab` → `git:daymanondev/factory-release-lab:plugin`
   - `FactoryView` carries `corePlugin` (`paseo-factory`) alongside `companions` (`factory-burn-lab`, `factory-connector`, `factory-release-lab`) and `pluginsCheckedAt`.
   - Clicking **`Install`** (or **`Install All`**) dispatches `plugin.source.install.request` with the canonical GitHub source over the daemon WebSocket (`daemonWsRequestPayload`), allowing the Paseo daemon to clone and load the plugin into `<home>/plugins/...` identically on macOS and Windows.
   - The server **never** probes or prioritizes `../` sibling directories on the host disk.
   - On the Core (`paseo-factory`) card (`CORE` badge), `Update` (when installed from `git`/`npm`) and `Reload` are enabled, while **`Disable` and `Remove` are forbidden** (`core-plugin-protected` on `factory.plugins.manage` and omitted in the UI) so the `Owner` cannot accidentally disable or remove the active `Factory surface`.

3. **Compact 2-Row Card Layout with Version/Update Pills, Conditional Primary `Update` CTA, and Collapsible `⋯` (`Manage`) Drawer.**
   - Every plugin card (`Core` and `Companion`) renders a scannable 2-row face:
     - **Row 1 (Header):** Sidebar icon + Title + `CORE` badge (for `paseo-factory`) + Version & Revision pill (`v0.0.5 · 7f8a5cc` for remote installs, `v0.0.25 · local` for directory installs) + Status pill (`Running`, `Disabled`, `Failed`, `Not Installed`) + `Active in Sidebar · <sidebarLabel>` pill (when `running`) + Update status pill (`Up to date`, `Update available · 7f8a5cc → a91c3f2`, or `Local`) + right-aligned Primary CTA + `⋯` (`Manage` / `Custom source…`) toggle button.
     - **Row 2 (Subtitle):** Concise 1-line `tagline` (plus daemon error banner if `error !== null`).
   - **Conditional Primary CTA Law:**
     - When `status === "not_installed"`: primary solid CTA is **`Install`**.
     - When installed and `updateAvailable === true`: primary solid CTA is **`Update`**.
     - When installed and `updateAvailable !== true`: **no primary `Update` button** is shown on the main card header — eliminating the always-lit `Update` anti-pattern.
   - **Collapsible `⋯` (`Manage` / `Custom source…`) Drawer:**
     - For installed plugins: reveals the 1-line install source metadata (`installKind · installedSource · shortRevision`), `capabilities` pills, and secondary lifecycle buttons (`Disable` / `Enable`, `Reload`, muted manual `Update` for remote installs, and `Remove` in `statusDanger` for companions).
     - For uninstalled companions (`not_installed`): reveals `canonicalSource`, `capabilities` pills, and the custom `Source` / `Ref (branch/tag/commit)` inputs + `Install Custom` button.

4. **On-Demand Update Check (`factory.plugins.check.updates`) & Honest Update Summaries.**
   - Normal 5s `factory.snapshot` polls **never** run network `git ls-remote` calls; they read the 15s-cached local `plugin.list.request` (enriched with `version` from `<plugin.path>/package.json` or `<plugin.path>/../package.json`) and join any cached update status for `home`.
   - `factory.plugins.check.updates` (`pluginsCheckUpdates`) invokes `checkDaemonPluginUpdates(home)` over the daemon WebSocket (`plugin.source.status.request`, with CLI fallback `paseo --home <home> plugin update --all --check --json`), caches per-`home` update rows (`updateAvailable`, `latestRevision`, `commitsBehind`, `checkedAt`), and invalidates on any plugin install or manage call.
   - `FactoryShell` automatically triggers `pluginsCheckUpdates` once when the `Owner` opens `tab === "plugins"` (when `pluginsCheckedAt === null` or older than 5 minutes) and whenever the `Owner` clicks **`Check for updates`**.
   - `pluginsManage` supports `pluginId: "paseo-factory" | "factory-burn-lab" | "factory-connector" | "factory-release-lab" | "all"` (where `"all"` applies only to `action: "update"`, updating all installed remote plugins with `updateAvailable === true`, or all remote plugins if none are cached).
   - `pluginsManageSummary` inspects `reply.update` from `manageDaemonPlugin`: when `updated === true`, it returns `"updated <id> (<prevSha> → <currSha>)"`; when `updated === false`, it returns `"<id> is already up to date (<sha>)"`.

5. **Strict Daemon Home isolation.**
   - All plugin list, update-check, install, and manage calls execute strictly against the `home` of the Paseo daemon process hosting that `Factory surface` (`~/.paseo` in production Desktop vs `~/.paseo-factory` in trial runs), preserving the trial/prod boundary.

## Consequences

- `CONTEXT.md` updates **Factory surface** and **Companion plugin** to reflect the Core + 3 Companions `Plugins` view, semantic version + revision pills, on-demand update checking (`factory.plugins.check.updates`), conditional `Update` / `Update All` CTAs, and honest update summaries.
- Every card in the `Plugins` tab stays compact (2 rows by default), clearly answers what version is installed (`vX.Y.Z · <sha>`) and whether a remote update exists, and only lights up `Update` when a newer revision is genuinely available.
