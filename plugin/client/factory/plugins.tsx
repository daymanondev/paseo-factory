/**
 * Tab 4 — Plugins, the Core + `Companion plugin` catalog (v0.0.17, ADR 0012;
 * redesigned in v0.0.25, ADR 0012 §1–§4; amended in v0.0.30 for the private
 * companion tier, ADR 0012/0014):
 * - Compact 1-line ecosystem toolbar with active count, update-check status,
 *   `Check for updates`, conditional `Update All (N)` (only when updates exist),
 *   and conditional `Install All` (when any `access === "public"` companion is
 *   uninstalled — a private invite-only companion never keeps it lit).
 * - Core plugin card (`paseo-factory`, `CORE` badge, protected against
 *   `Disable`/`Remove`) at the top, followed by the 3 `Companion plugin` cards.
 * - Compact 2-row card face (Header row with the `Private · Invite-only` pill
 *   for `access === "private"` companions, semantic version `vX.Y.Z · sha`,
 *   status pill, update pill, and conditional primary `Install`/`Update` CTA;
 *   plus 1-line `tagline`), with a collapsible `⋯ Manage` / `Custom source…`
 *   drawer housing source metadata, capabilities, and secondary lifecycle acts.
 * The Shell owns the RPC calls — this pane is a pure render of the view plus
 * action callbacks.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { CompanionCatalogEntry, ManageablePluginId } from "../../shared/companions.ts";
import type { CompanionPluginView, CompanionStatus, FactoryView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { CONTROL_H, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import {
  DEFAULT_CORE_RESTART_TIMEOUT_MS,
  formatPluginCardProgressPill,
  formatToolbarProgressPill,
  isCoreSelfRestartError,
  isPluginTargetedByAct,
  resolveCoreRestartWatch,
} from "./plugin-feedback.ts";
import type { ActivePluginAct, PluginsNote } from "./plugin-feedback.ts";

export {
  DEFAULT_CORE_RESTART_TIMEOUT_MS,
  formatPluginCardProgressPill,
  formatToolbarProgressPill,
  isCoreSelfRestartError,
  isPluginTargetedByAct,
  resolveCoreRestartWatch,
};
export type { ActivePluginAct, PluginsNote };

/** The companion ids the catalog carries — the install RPC targets minus "all". */
type CompanionId = CompanionCatalogEntry["id"];

/** The Plugins tab's whole action surface — the Shell owns the RPC calls. */
export interface PluginsActions {
  /** Install or switch the source of a plugin (Core or Companion, canonical source by default or custom source/ref) or every uninstalled companion ("all"). */
  install(target: ManageablePluginId | "all", source?: string, ref?: string): void;
  /** One lifecycle act on an installed plugin (Core or Companion, or "all" for batch update). */
  manage(pluginId: ManageablePluginId | "all", action: "enable" | "disable" | "reload" | "update" | "remove"): void;
  /** Trigger an on-demand remote update check across installed plugins (v0.0.25, ADR 0012 §4). */
  checkUpdates(): void;
  /** True while an on-demand update check is in flight. */
  checkingUpdates?: boolean;
  busy: boolean;
}

/** The status pill's four faces — Running green, Failed danger, the rest muted (the tasks.tsx statusTone law). */
const STATUS: Record<CompanionStatus, { label: string; tone: Colour; lit: boolean }> = {
  running: { label: "Running", tone: "statusSuccess", lit: true },
  disabled: { label: "Disabled", tone: "foregroundMuted", lit: false },
  failed: { label: "Failed", tone: "statusDanger", lit: true },
  not_installed: { label: "Not Installed", tone: "foregroundMuted", lit: false },
};

/** Formats the compact semantic version + short revision label (`v0.0.5 · 7f8a5cc` or `v0.0.25 · local`). */
function formatVersionBadge(companion: CompanionPluginView, shortRevision: string | null): string | null {
  const ver = companion.version !== null ? `v${companion.version.replace(/^v/, "")}` : null;
  if (companion.installKind === "directory") {
    return ver !== null ? `${ver} · local` : "local";
  }
  if (ver !== null && shortRevision !== null) return `${ver} · ${shortRevision}`;
  if (ver !== null) return ver;
  if (shortRevision !== null) return shortRevision;
  return null;
}

/** One plugin's compact 2-row card — serves both the Core plugin (`isCore`) and each Companion plugin. */
function CompanionCard({
  theme,
  companion,
  actions,
  isCore = false,
  activeAct = null,
  elapsedSeconds = 0,
  cardError,
  onDismissError,
}: {
  theme: PluginTheme;
  companion: CompanionPluginView;
  actions: PluginsActions;
  isCore?: boolean;
  activeAct?: ActivePluginAct | null;
  elapsedSeconds?: number;
  cardError?: string;
  onDismissError?: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switchSourceOpen, setSwitchSourceOpen] = useState(false);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const status = STATUS[companion.status];
  const id = companion.id as CompanionId;
  const manageId = companion.id as ManageablePluginId;
  const installed = companion.status !== "not_installed";
  const remote = companion.installKind === "git" || companion.installKind === "npm";
  const shortRevision = companion.currentRevision === null ? null : companion.currentRevision.slice(0, 7);
  const shortLatest = companion.latestRevision === null ? null : companion.latestRevision.slice(0, 7);
  const versionBadge = installed || isCore ? formatVersionBadge(companion, shortRevision) : null;
  const progressPill = formatPluginCardProgressPill(companion, activeAct, elapsedSeconds);
  const isRestartingThisCore = isCore && isPluginTargetedByAct(companion, activeAct, { kind: "restarting-core" });
  const isRestartingCoreForReload = isRestartingThisCore && activeAct?.action === "reload";
  const isRestartingCoreForInstall = isRestartingThisCore && activeAct?.action === "install";
  const isRestartingCoreForUpdate = isRestartingThisCore && activeAct?.action !== "reload" && activeAct?.action !== "install";
  const isUpdatingThis = isPluginTargetedByAct(companion, activeAct, { kind: "manage", action: "update" });
  const isInstallingThis = isPluginTargetedByAct(companion, activeAct, { kind: "install" });
  const isReloadingThis = isPluginTargetedByAct(companion, activeAct, { kind: "manage", action: "reload" });
  const isEnablingThis = isPluginTargetedByAct(companion, activeAct, { kind: "manage", action: "enable" });
  const isDisablingThis = isPluginTargetedByAct(companion, activeAct, { kind: "manage", action: "disable" });
  const isRemovingThis = isPluginTargetedByAct(companion, activeAct, { kind: "manage", action: "remove" });
  const trimmedSource = source.trim();
  const trimmedRef = ref.trim();

  return (
    <Card theme={theme} gap={SPACING[1.5]}>
      {/* Row 1 (Compact Header): Icon + Title + Badges/Version/Status/Update pills on left, Primary CTA + Drawer toggle on right. */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
          <Icon name={companion.sidebarIcon} size={15} color={theme.colors.accent} />
          <Text style={text(theme, "rowTitle")}>{companion.title}</Text>
          {isCore ? <Pill theme={theme} label="CORE" tone="accent" lit /> : null}
          {!isCore && companion.access === "private" ? (
            <Pill theme={theme} label="Private · Invite-only" tone="statusWarning" />
          ) : null}
          <Pill theme={theme} label={companion.id} mono />
          {versionBadge !== null ? <Pill theme={theme} label={versionBadge} mono /> : null}
          <Pill theme={theme} label={status.label} tone={status.tone} lit={status.lit} />
          {companion.status === "running" ? (
            <Pill theme={theme} label={`Active in Sidebar · ${companion.sidebarLabel}`} tone="accent" lit />
          ) : null}
          {installed && companion.installKind === "directory" ? (
            <Pill theme={theme} label="Local checkout" tone="foregroundMuted" />
          ) : null}
          {installed && remote && companion.updateAvailable === true ? (
            <Pill
              theme={theme}
              label={
                shortRevision !== null && shortLatest !== null && shortRevision !== shortLatest
                  ? `Update available · ${shortRevision} → ${shortLatest}`
                  : "Update available"
              }
              tone="statusWarning"
              lit
            />
          ) : null}
          {installed && remote && companion.updateAvailable === false ? (
            <Pill theme={theme} label="Up to date" tone="statusSuccess" />
          ) : null}
          {progressPill !== null ? <Pill theme={theme} label={progressPill} tone="accent" lit /> : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          {!installed ? (
            <>
              {isInstallingThis ? (
                <Btn theme={theme} small label={`Installing… (${elapsedSeconds}s)`} solid disabled={actions.busy} onPress={() => actions.install(id)} />
              ) : (
                <Btn theme={theme} small label="Install" solid disabled={actions.busy} onPress={() => actions.install(id)} />
              )}
              <Btn
                theme={theme}
                small
                label={drawerOpen ? "Hide" : "Custom source…"}
                tone="foregroundMuted"
                disabled={actions.busy}
                onPress={() => setDrawerOpen(!drawerOpen)}
              />
            </>
          ) : (
            <>
              {companion.installKind === "directory" ? (
                <Btn
                  theme={theme}
                  small
                  label={
                    isRestartingCoreForInstall
                      ? `Reloading Core… (${elapsedSeconds}s)`
                      : isInstallingThis
                        ? `Switching… (${elapsedSeconds}s)`
                        : "Switch to GitHub"
                  }
                  tone="accent"
                  disabled={actions.busy}
                  onPress={() => actions.install(manageId)}
                />
              ) : null}
              {(remote && companion.updateAvailable === true) || isUpdatingThis || isRestartingCoreForUpdate ? (
                <Btn
                  theme={theme}
                  small
                  label={
                    isRestartingCoreForUpdate
                      ? `Reloading Core… (${elapsedSeconds}s)`
                      : isUpdatingThis
                        ? `Updating… (${elapsedSeconds}s)`
                        : "Update"
                  }
                  solid
                  disabled={actions.busy}
                  onPress={() => actions.manage(manageId, "update")}
                />
              ) : null}
              <Btn
                theme={theme}
                small
                label={drawerOpen ? "Hide" : "⋯ Manage"}
                tone="foregroundMuted"
                disabled={actions.busy}
                onPress={() => setDrawerOpen(!drawerOpen)}
              />
            </>
          )}
        </View>
      </View>

      {/* Row 2 (Concise 1-line Subtitle): Tagline only — no redundant multi-line description or noisy INSTALL box on the card face. */}
      <Text style={text(theme, "meta")} numberOfLines={2}>
        {companion.tagline}
      </Text>

      {companion.error !== null || cardError !== undefined ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: SPACING[2],
            borderWidth: 1,
            borderColor: tint(theme.colors.statusDanger, "66"),
            borderRadius: RADIUS.md,
            backgroundColor: tint(theme.colors.statusDanger, "12"),
            padding: SPACING[2],
          }}
        >
          <Text style={{ ...text(theme, "label", "statusDanger"), flexShrink: 1 }}>
            {[companion.error, cardError].filter(Boolean).join(" · ")}
          </Text>
          {cardError !== undefined && onDismissError !== undefined ? (
            <Btn theme={theme} small label="Dismiss" tone="foregroundMuted" onPress={onDismissError} />
          ) : null}
        </View>
      ) : null}

      {/* Collapsible ⋯ Manage / Custom source… drawer — keeps secondary actions, install source, and capability chips one click away. */}
      {drawerOpen ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: SPACING[2],
            gap: SPACING[2],
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
            {companion.capabilities.map((capability) => (
              <Pill key={capability} theme={theme} label={capability} mono />
            ))}
          </View>

          <View
            style={{
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: RADIUS.md,
              backgroundColor: theme.colors.surface0,
              padding: SPACING[2],
              gap: SPACING[0.5],
            }}
          >
            <Text style={text(theme, "badge")}>SOURCE</Text>
            {!installed ? (
              <Text style={text(theme, "code")} numberOfLines={1}>
                {companion.canonicalSource}
              </Text>
            ) : (
              <Text style={text(theme, "code")} numberOfLines={1}>
                {companion.installKind ?? "local"} · {companion.installedSource ?? companion.canonicalSource}
                {shortRevision !== null ? ` · ${shortRevision}` : ""}
                {shortLatest !== null && companion.updateAvailable === true ? ` → ${shortLatest}` : ""}
              </Text>
            )}
          </View>

          {!installed ? (
            <View style={{ gap: SPACING[1.5] }}>
              <View style={{ gap: SPACING[1] }}>
                <Text style={text(theme, "label")}>Source</Text>
                <View
                  style={{
                    minHeight: CONTROL_H,
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: RADIUS.md,
                    backgroundColor: theme.colors.surface1,
                  }}
                >
                  <TextInput
                    value={source}
                    onChangeText={setSource}
                    placeholder={`git:daymanondev/${companion.id}:plugin or /path/to/plugin`}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
                  />
                </View>
              </View>
              <View style={{ gap: SPACING[1] }}>
                <Text style={text(theme, "label")}>Ref (branch/tag/commit) — optional</Text>
                <View
                  style={{
                    minHeight: CONTROL_H,
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: RADIUS.md,
                    backgroundColor: theme.colors.surface1,
                  }}
                >
                  <TextInput
                    value={ref}
                    onChangeText={setRef}
                    placeholder="e.g. feat/x, v0.2.0, 9f3b2c1"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
                  />
                </View>
              </View>
              <Btn
                theme={theme}
                small
                label={isInstallingThis ? `Installing… (${elapsedSeconds}s)` : "Install Custom"}
                disabled={actions.busy || trimmedSource === ""}
                onPress={() => actions.install(id, trimmedSource, trimmedRef === "" ? undefined : trimmedRef)}
              />
            </View>
          ) : (
            <View style={{ gap: SPACING[2] }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                {!isCore ? (
                  companion.enabled ? (
                    isDisablingThis ? (
                      <Btn theme={theme} small label="Disabling…" disabled={actions.busy} onPress={() => actions.manage(id, "disable")} />
                    ) : (
                      <Btn theme={theme} small label="Disable" disabled={actions.busy} onPress={() => actions.manage(id, "disable")} />
                    )
                  ) : isEnablingThis ? (
                    <Btn theme={theme} small label="Enabling…" disabled={actions.busy} onPress={() => actions.manage(id, "enable")} />
                  ) : (
                    <Btn theme={theme} small label="Enable" disabled={actions.busy} onPress={() => actions.manage(id, "enable")} />
                  )
                ) : null}
                {isReloadingThis || isRestartingCoreForReload ? (
                  <Btn
                    theme={theme}
                    small
                    label={isRestartingCoreForReload ? `Reloading Core… (${elapsedSeconds}s)` : "Reloading…"}
                    tone="foregroundMuted"
                    disabled={actions.busy}
                    onPress={() => actions.manage(manageId, "reload")}
                  />
                ) : (
                  <Btn theme={theme} small label="Reload" tone="foregroundMuted" disabled={actions.busy} onPress={() => actions.manage(manageId, "reload")} />
                )}
                {companion.installKind === "git" || companion.installKind === "npm" ? (
                  isRestartingCoreForUpdate ? (
                    <Btn
                      theme={theme}
                      small
                      label={`Reloading Core… (${elapsedSeconds}s)`}
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => actions.manage(manageId, "update")}
                    />
                  ) : isUpdatingThis ? (
                    <Btn
                      theme={theme}
                      small
                      label={`Updating… (${elapsedSeconds}s)`}
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => actions.manage(manageId, "update")}
                    />
                  ) : (
                    <Btn
                      theme={theme}
                      small
                      label="Update"
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => actions.manage(manageId, "update")}
                    />
                  )
                ) : null}
                {companion.installKind === "directory" ? (
                  <Btn
                    theme={theme}
                    small
                    label={
                      isRestartingCoreForInstall
                        ? `Reloading Core… (${elapsedSeconds}s)`
                        : isInstallingThis
                          ? `Switching… (${elapsedSeconds}s)`
                          : "Switch to GitHub"
                    }
                    tone="accent"
                    disabled={actions.busy}
                    onPress={() => actions.install(manageId)}
                  />
                ) : null}
                <Btn
                  theme={theme}
                  small
                  label={switchSourceOpen ? "Cancel source…" : "Switch source…"}
                  tone="foregroundMuted"
                  disabled={actions.busy}
                  onPress={() => setSwitchSourceOpen(!switchSourceOpen)}
                />
                {!isCore ? (
                  isRemovingThis ? (
                    <Btn theme={theme} small label="Removing…" tone="statusDanger" disabled={actions.busy} onPress={() => actions.manage(id, "remove")} />
                  ) : (
                    <Btn theme={theme} small label="Remove" tone="statusDanger" disabled={actions.busy} onPress={() => actions.manage(id, "remove")} />
                  )
                ) : (
                  <Pill theme={theme} label="Core plugin protected (Disable/Remove locked)" tone="foregroundMuted" />
                )}
              </View>

              {switchSourceOpen ? (
                <View style={{ gap: SPACING[1.5] }}>
                  <View style={{ gap: SPACING[1] }}>
                    <Text style={text(theme, "label")}>Source</Text>
                    <View
                      style={{
                        minHeight: CONTROL_H,
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: RADIUS.md,
                        backgroundColor: theme.colors.surface1,
                      }}
                    >
                      <TextInput
                        value={source}
                        onChangeText={setSource}
                        placeholder={`git:daymanondev/${companion.id}:plugin or /path/to/plugin`}
                        placeholderTextColor={theme.colors.foregroundMuted}
                        style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
                      />
                    </View>
                  </View>
                  <View style={{ gap: SPACING[1] }}>
                    <Text style={text(theme, "label")}>Ref (branch/tag/commit) — optional</Text>
                    <View
                      style={{
                        minHeight: CONTROL_H,
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: RADIUS.md,
                        backgroundColor: theme.colors.surface1,
                      }}
                    >
                      <TextInput
                        value={ref}
                        onChangeText={setRef}
                        placeholder="e.g. feat/x, v0.2.0, 9f3b2c1"
                        placeholderTextColor={theme.colors.foregroundMuted}
                        style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
                      />
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                    <Btn
                      theme={theme}
                      small
                      label={
                        isRestartingCoreForInstall
                          ? `Reloading Core… (${elapsedSeconds}s)`
                          : isInstallingThis
                            ? `Switching… (${elapsedSeconds}s)`
                            : "Switch Source"
                      }
                      solid
                      disabled={actions.busy || trimmedSource === ""}
                      onPress={() => actions.install(manageId, trimmedSource, trimmedRef === "" ? undefined : trimmedRef)}
                    />
                    <Btn
                      theme={theme}
                      small
                      label={`Use Canonical (${companion.canonicalSource})`}
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => actions.install(manageId)}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </Card>
  );
}

export function PluginsPane({
  theme,
  view,
  actions,
  activeAct = null,
  elapsedSeconds = 0,
  pluginsNote = null,
  cardErrors = {},
  dismissNote,
  dismissCardError,
}: {
  theme: PluginTheme;
  view: FactoryView;
  actions: PluginsActions;
  activeAct?: ActivePluginAct | null;
  elapsedSeconds?: number;
  pluginsNote?: PluginsNote | null;
  cardErrors?: Readonly<Record<string, string>>;
  dismissNote?: () => void;
  dismissCardError?: (pluginId: string) => void;
}) {
  const running = view.companions.filter((c) => c.status === "running").length;
  const companionTools = view.companionTools ?? [];
  const toolsRunning = companionTools.filter((t) => t.status === "running").length;
  // Public companions & companion tools — a private invite-only companion (factory-release-lab) that stays
  // not_installed must never keep the Install All button lit (v0.0.30, ADR 0012 §2; ADR 0036 §5).
  const anyUninstalled =
    view.companions.some((c) => c.access === "public" && c.status === "not_installed") ||
    companionTools.some((t) => t.access === "public" && (t.status === "not_installed" || t.status === "failed"));
  const allPlugins = [view.corePlugin, ...view.companions, ...companionTools];
  const updatableCount = allPlugins.filter(
    (p) => p.status !== "not_installed" && (p.installKind === "git" || p.installKind === "npm") && p.updateAvailable === true,
  ).length;
  const toolbarProgress = formatToolbarProgressPill(activeAct, actions.checkingUpdates === true, elapsedSeconds);
  const isUpdatingAll = activeAct !== null && activeAct.kind === "manage" && activeAct.target === "all" && activeAct.action === "update";
  const isInstallingAll = activeAct !== null && activeAct.kind === "install" && activeAct.target === "all";

  return (
    <View style={{ gap: SPACING[2.5] }}>
      {/* Compact 1-line ecosystem toolbar */}
      <Card theme={theme} gap={SPACING[1.5]}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
            <Text style={text(theme, "section")}>Factory plugins</Text>
            <Pill theme={theme} label={`Core + ${view.companions.length} Companions`} />
            <Pill theme={theme} label={`${running} of ${view.companions.length} active on this daemon`} tone={running > 0 ? "statusSuccess" : "foregroundMuted"} />
            {toolbarProgress !== null ? (
              <Pill theme={theme} label={toolbarProgress} tone="accent" lit />
            ) : updatableCount > 0 ? (
              <Pill theme={theme} label={`${updatableCount} update${updatableCount > 1 ? "s" : ""} available`} tone="statusWarning" lit />
            ) : view.pluginsCheckedAt !== null ? (
              <Pill theme={theme} label="All up to date" tone="statusSuccess" />
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Btn
              theme={theme}
              small
              label={actions.checkingUpdates === true ? "Checking…" : "Check for updates"}
              tone="foregroundMuted"
              disabled={actions.busy || actions.checkingUpdates === true}
              onPress={() => actions.checkUpdates()}
            />
            {updatableCount > 0 || isUpdatingAll ? (
              <Btn
                theme={theme}
                small
                label={isUpdatingAll ? `Updating All… (${elapsedSeconds}s)` : `Update All (${updatableCount})`}
                solid
                disabled={actions.busy}
                onPress={() => actions.manage("all", "update")}
              />
            ) : null}
            {anyUninstalled || isInstallingAll ? (
              isInstallingAll ? (
                <Btn theme={theme} small label={`Installing All… (${elapsedSeconds}s)`} solid disabled={actions.busy} onPress={() => actions.install("all")} />
              ) : (
                <Btn theme={theme} small label="Install All" solid disabled={actions.busy} onPress={() => actions.install("all")} />
              )
            ) : null}
          </View>
        </View>

        {pluginsNote !== null ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: SPACING[2],
              borderWidth: 1,
              borderColor: tint(theme.colors[pluginsNote.tone], "66"),
              borderRadius: RADIUS.md,
              backgroundColor: tint(theme.colors[pluginsNote.tone], "12"),
              paddingHorizontal: SPACING[2.5],
              paddingVertical: SPACING[1.5],
            }}
          >
            <Text style={{ ...text(theme, "label", pluginsNote.tone), flexShrink: 1 }}>{pluginsNote.text}</Text>
            {dismissNote !== undefined ? (
              <Btn theme={theme} small label="Dismiss" tone="foregroundMuted" onPress={dismissNote} />
            ) : null}
          </View>
        ) : null}
      </Card>

      {/* Core plugin card at top, followed by the 3 Companion plugin cards */}
      <CompanionCard
        key={view.corePlugin.id}
        theme={theme}
        companion={view.corePlugin}
        actions={actions}
        isCore
        activeAct={activeAct}
        elapsedSeconds={elapsedSeconds}
        cardError={cardErrors[view.corePlugin.id]}
        onDismissError={dismissCardError ? () => dismissCardError(view.corePlugin.id) : undefined}
      />
      {view.companions.map((companion) => (
        <CompanionCard
          key={companion.id}
          theme={theme}
          companion={companion}
          actions={actions}
          activeAct={activeAct}
          elapsedSeconds={elapsedSeconds}
          cardError={cardErrors[companion.id]}
          onDismissError={dismissCardError ? () => dismissCardError(companion.id) : undefined}
        />
      ))}
      {companionTools.length > 0 ? (
        <View style={{ gap: SPACING[2], marginTop: SPACING[1] }}>
          <Card theme={theme} gap={SPACING[1]}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                <Text style={text(theme, "section")}>Companion Tools & Skill Packs</Text>
                <Pill theme={theme} label={`${toolsRunning} of ${companionTools.length} active on host`} tone={toolsRunning === companionTools.length ? "statusSuccess" : "statusWarning"} />
                <Pill theme={theme} label="Auto-provisioned & Vault-synced" tone="foregroundMuted" />
              </View>
            </View>
          </Card>
          {companionTools.map((tool) => (
            <CompanionCard
              key={tool.id}
              theme={theme}
              companion={tool}
              actions={actions}
              activeAct={activeAct}
              elapsedSeconds={elapsedSeconds}
              cardError={cardErrors[tool.id]}
              onDismissError={dismissCardError ? () => dismissCardError(tool.id) : undefined}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
