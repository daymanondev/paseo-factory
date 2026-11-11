import { OpenDesignControl } from "./open-design.tsx";
/**
 * The minimal Project header (v0.6.0 W4, ADR 0056 — W5 replaces it with the
 * Project panel): a plain-language headline, the freshness dot, the Project
 * bound to this workspace, live Supervisor/Lead seat states with Open jumps
 * (v0.0.27, ADR 0017 §3 — seats start only from Paseo's native New Chat
 * picker, never from a header button), the Open Design link control, and the
 * two-step `Reset Project` / `Delete Project`. There is no Project picking
 * here at all: the Project is the one the workspace is bound to.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import type { FactoryView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { DOT, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import { GRACE_MS, pollEvery } from "../kit/poll.ts";
import { isVaultActName, readAgo, VaultPane, VaultSyncBar } from "./vault.tsx";
import type { VaultActName, VaultImportInput, VaultNote, VaultSyncInput } from "./vault.tsx";

export { isVaultActName, readAgo, VaultPane, VaultSyncBar };
export type { VaultActName, VaultImportInput, VaultNote, VaultSyncInput };

/** The header's whole action surface — the Shell owns the RPC calls. */
export interface HeaderActions {
  refresh?(): void;
  designSourceKey?: string;
  /** Jump to the live Supervisor's conversation (v0.0.27, ADR 0017 §3) — the seat itself starts from Paseo's native New Chat picker, never here. */
  openSupervisor(): void;
  /** Jump to the live Lead's conversation — the Supervisor spawns the seat via supervisor_dispatch_lead. */
  openLead(): void;
  /** Owner-only clean-slate reset of the Project (v0.0.24, ADR 0015 §6). */
  resetProject(): void;
  /** Owner-only permanent deletion of the Project and all its Factory/Paseo records (v0.0.35, ADR 0024/0025). */
  deleteProject(target?: { root?: string; slug?: string }): void;
  busy: boolean;
}

/** Shortens `/Users/<name>/...` or `/home/<name>/...` to `~/...` so long paths fit cleanly on narrow headers. */
export function shortenHomePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

function headlineOf(view: FactoryView): string {
  if (view.kpis.needsHuman > 0) return `${view.kpis.needsHuman} task${view.kpis.needsHuman === 1 ? "" : "s"} need${view.kpis.needsHuman === 1 ? "s" : ""} you`;
  if (view.kpis.running > 0) return `${view.kpis.running} under the gate`;
  if (view.kpis.readyToAccept > 0) return `${view.kpis.readyToAccept} green attempt${view.kpis.readyToAccept === 1 ? "" : "s"} await acceptance`;
  if (view.kpis.accepted > 0) return "Everything accepted";
  return "No tasks yet";
}

/** The Project's label — explicit name, else the root's last path segment, falling back to the slug. */
function projectLabel(slug: string, root: string, name?: string): string {
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  const last = root.split("/").filter((segment) => segment !== "");
  return last.length > 0 ? (last[last.length - 1] as string) : slug;
}

/** One standing seat's live state chip (v0.0.27, ADR 0017 §3) — the daemon's own status while the seat lives. */
function SeatState({ theme, name, status }: { theme: PluginTheme; name: string; status: string }) {
  const running = status === "running";
  return <Pill theme={theme} label={`${name}: ${status}`} tone={running ? "accent" : "foregroundMuted"} lit={running} />;
}

export function Header({
  theme,
  view,
  at,
  now,
  actions,
}: {
  theme: PluginTheme;
  view: FactoryView;
  at: number | null;
  now: number;
  compact?: boolean;
  actions: HeaderActions;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!confirmingReset) return;
    const timer = setTimeout(() => setConfirmingReset(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmingReset]);

  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  const busy = view.kpis.running + view.kpis.needsHuman > 0;
  const fresh = at !== null && now - at <= pollEvery(busy) + GRACE_MS;
  const project = view.project;

  return (
    <View style={{ gap: SPACING[3] }}>
      {/* Top status bar: Headline + Freshness */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexShrink: 1 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 99,
              backgroundColor:
                view.kpis.needsHuman > 0
                  ? theme.colors.statusWarning
                  : view.kpis.running > 0
                    ? theme.colors.accent
                    : view.kpis.readyToAccept > 0
                      ? theme.colors.statusSuccess
                      : theme.colors.foregroundMuted,
            }}
          />
          <Text
            accessibilityRole="header"
            style={{
              ...text(theme, "detailTitle"),
              fontSize: 18,
              lineHeight: 24,
              fontWeight: "600",
              flexShrink: 1,
              color: view.kpis.needsHuman > 0 ? theme.colors.statusWarning : theme.colors.foreground,
            }}
          >
            {headlineOf(view)}
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: SPACING[1.5],
            paddingHorizontal: SPACING[2.5],
            paddingVertical: 3,
            borderRadius: RADIUS.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          {at !== null ? (
            <View
              accessibilityLabel={fresh ? "up to date" : "overdue"}
              style={{
                width: DOT - 2,
                height: DOT - 2,
                borderRadius: DOT,
                backgroundColor: fresh ? theme.colors.statusSuccess : theme.colors.statusWarning,
              }}
            />
          ) : null}
          <Text style={{ ...text(theme, "badge"), fontVariant: ["tabular-nums"] }} numberOfLines={1}>
            {at !== null ? `updated ${readAgo(Math.max(0, Math.round((now - at) / 1000)))}` : "never updated"}
            {view.daemonError === null ? "" : " · daemon unreadable"}
          </Text>
        </View>
      </View>

      <Card theme={theme} gap={SPACING[2.5]}>
        {project === null ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
            <Pill theme={theme} label="No Project" tone="statusWarning" lit />
            <Text style={text(theme, "meta")}>This workspace is not a Factory Project yet.</Text>
          </View>
        ) : null}
        {project && !project.missingRoot ? <OpenDesignControl key={project.root} theme={theme} root={project.root} sourceKey={actions.designSourceKey} onChanged={() => actions.refresh?.()} /> : null}

        {project !== null ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: SPACING[2],
              borderTopWidth: 1,
              borderTopColor: project.missingRoot ? tint(theme.colors.statusDanger, "55") : theme.colors.border,
              paddingTop: SPACING[2],
              ...(project.missingRoot
                ? {
                    padding: SPACING[2.5],
                    borderRadius: RADIUS.md,
                    borderWidth: 1,
                    borderColor: tint(theme.colors.statusDanger, "66"),
                    backgroundColor: tint(theme.colors.statusDanger, "12"),
                  }
                : {}),
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
              <Text style={text(theme, "rowTitle")}>{projectLabel(project.slug, project.root, project.name)}</Text>
              <Pill theme={theme} label={project.slug} mono />
              <Text style={{ ...text(theme, "code"), color: theme.colors.foregroundMuted }} numberOfLines={1}>
                {shortenHomePath(project.root)}
              </Text>
              {project.missingRoot ? (
                <>
                  <Pill theme={theme} label="Missing folder" tone="statusDanger" lit />
                  <Text style={text(theme, "label", "statusDanger")}>
                    Folder deleted on disk — delete this project to purge all tasks, seats, and Paseo records
                  </Text>
                </>
              ) : null}
            </View>

            {/* The seat states (v0.0.27, ADR 0017 §3): a seat starts only from
                Paseo's native New Chat picker ("Supervisor (Factory)") — the
                Supervisor spawns the Lead itself. The Header reports each
                seat's live status with an Open jump to its conversation while
                it lives, and the picker hint while it is vacant (suppressed
                when the project's folder is missing on disk). */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
              {!project.missingRoot ? (
                <>
                  {view.supervisor !== null ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                      <SeatState theme={theme} name="Supervisor" status={view.supervisor.status} />
                      <Btn theme={theme} small icon="Shield" label="Open Supervisor" tone="accent" onPress={() => actions.openSupervisor()} />
                    </View>
                  ) : (
                    <Text style={text(theme, "meta")}>Select "Supervisor (Factory)" in New Chat to start</Text>
                  )}
                  {view.lead !== null ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                      <SeatState theme={theme} name="Lead" status={view.lead.status} />
                      <Btn theme={theme} small icon="Compass" label="Open Lead" tone="accent" onPress={() => actions.openLead()} />
                    </View>
                  ) : (
                    <Text style={text(theme, "meta")}>Spawned automatically by Supervisor</Text>
                  )}
                </>
              ) : null}
              {!project.missingRoot ? (
                confirmingReset ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
                    <Btn
                      theme={theme}
                      small
                      solid
                      icon="RotateCcw"
                      label="Confirm Reset"
                      tone="statusDanger"
                      disabled={actions.busy}
                      onPress={() => {
                        setConfirmingReset(false);
                        actions.resetProject();
                      }}
                    />
                    <Btn
                      theme={theme}
                      small
                      icon="X"
                      label="Cancel"
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => setConfirmingReset(false)}
                    />
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Btn
                      theme={theme}
                      small
                      icon="RotateCcw"
                      label="Reset Project"
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => {
                        setConfirmingDelete(false);
                        setConfirmingReset(true);
                      }}
                    />
                  </View>
                )
              ) : null}
              {confirmingDelete ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
                  <Btn
                    theme={theme}
                    small
                    solid
                    icon="Trash2"
                    label="Confirm Delete"
                    tone="statusDanger"
                    disabled={actions.busy}
                    onPress={() => {
                      setConfirmingDelete(false);
                      actions.deleteProject({ root: project.root, slug: project.slug });
                    }}
                  />
                  <Btn
                    theme={theme}
                    small
                    icon="X"
                    label="Cancel"
                    tone="foregroundMuted"
                    disabled={actions.busy}
                    onPress={() => setConfirmingDelete(false)}
                  />
                </View>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Btn
                    theme={theme}
                    small
                    solid={project.missingRoot === true}
                    icon="Trash2"
                    label="Delete Project"
                    tone={project.missingRoot ? "statusDanger" : "foregroundMuted"}
                    disabled={actions.busy}
                    onPress={() => {
                      setConfirmingReset(false);
                      setConfirmingDelete(true);
                    }}
                  />
                </View>
              )}
            </View>
          </View>
        ) : null}
      </Card>

      {view.daemonError !== null ? (
        <Card theme={theme} style={{ borderColor: tint(theme.colors.statusWarning, "66"), backgroundColor: tint(theme.colors.statusWarning, "12") }}>
          <Text style={text(theme, "label", "statusWarning")}>{view.daemonError}</Text>
        </Card>
      ) : null}
    </View>
  );
}
