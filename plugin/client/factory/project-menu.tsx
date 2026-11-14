/** The reduced Project menu (W10, ADR 0057 §8): Reset, Rotate seats, Delete and Open Settings.
 * Reset/Rotate/Delete retain their two-step confirmation; a missing folder keeps Delete only.
 * Mobile mounts no menu writes. Model, pack and design controls live in the tab.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Btn } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";

/** One Project skill pack exposed by `view.skillHub.projectPacks`. */
export interface MenuSkillPack {
  id: string;
  label: string;
  enabled: boolean;
  autoDetected: boolean;
}

export type MenuConfirming = "reset" | "rotate" | "delete" | null;

function MenuSection({ theme, id, title, children }: { theme: PluginTheme; id: string; title: string; children: ReactNode }) {
  return (
    <View testID={`factory-panel-menu-${id}`} style={{ gap: SPACING[1.5] }}>
      <Text style={text(theme, "section")}>{title}</Text>
      {children}
    </View>
  );
}

/**
 * One destructive act behind its two-step confirm: the idle button arms it,
 * the armed pair is Confirm / Cancel. `emphasised` draws the idle button solid
 * red — Delete on a Project whose folder is gone, where it is the only act left.
 */
function ConfirmableDanger({
  theme,
  kind,
  icon,
  label,
  confirmLabel,
  busy,
  emphasised = false,
  confirming,
  setConfirming,
  onConfirm,
}: {
  theme: PluginTheme;
  kind: "reset" | "rotate" | "delete";
  icon: "RotateCcw" | "RefreshCw" | "Trash2";
  label: string;
  confirmLabel: string;
  busy: boolean;
  emphasised?: boolean;
  confirming: boolean;
  setConfirming(on: boolean): void;
  onConfirm(): void;
}) {
  if (confirming) {
    return (
      <>
        <Btn
          theme={theme}
          small
          solid
          testID={`factory-panel-menu-confirm-${kind}`}
          icon={icon}
          label={confirmLabel}
          tone="statusDanger"
          disabled={busy}
          onPress={() => {
            setConfirming(false);
            onConfirm();
          }}
        />
        <Btn theme={theme} small label="Cancel" tone="foregroundMuted" disabled={busy} onPress={() => setConfirming(false)} />
      </>
    );
  }
  return (
    <Btn
      theme={theme}
      small
      solid={emphasised}
      testID={`factory-panel-menu-${kind}`}
      icon={icon}
      label={label}
      tone={emphasised ? "statusDanger" : "foregroundMuted"}
      disabled={busy}
      onPress={() => setConfirming(true)}
    />
  );
}

export function ProjectMenu({
  theme,
  mobile,
  busy,
  missingRoot,
  openSettings,
  resetProject,
  rotateSeats,
  deleteProject,
  initialConfirming = null,
}: {
  theme: PluginTheme;
  /** True on Paseo mobile — the whole menu is view-only. */
  mobile: boolean;
  busy: boolean;
  /** The Project's folder is gone: only Delete can act. */
  missingRoot: boolean;
  openSettings(): void;
  resetProject(): void;
  rotateSeats(): void;
  deleteProject(): void;
  /** Seeds the two-step confirm — hosts and tests; the live state is local. */
  initialConfirming?: MenuConfirming;
}) {
  const [confirming, setConfirming] = useState<MenuConfirming>(initialConfirming);

  // The two-step confirm re-arms after 5s — the Header's Reset/Delete law.
  useEffect(() => {
    if (confirming === null) return;
    const timer = setTimeout(() => setConfirming(null), 5000);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <View testID="factory-panel-menu-body" style={{ gap: SPACING[3] }}>
      {!mobile ? (
        <MenuSection theme={theme} id="danger" title="Project">
          {!missingRoot ? <Btn theme={theme} small testID="factory-panel-open-settings" label="Open Settings" onPress={openSettings} /> : null}
          {missingRoot ? (
            <Text style={text(theme, "label", "statusDanger")}>
              The folder is gone — delete this Project to purge its tasks, seats and Paseo records.
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
            {!missingRoot ? (
              <ConfirmableDanger
                theme={theme}
                kind="reset"
                icon="RotateCcw"
                label="Reset Project"
                confirmLabel="Confirm Reset"
                busy={busy}
                confirming={confirming === "reset"}
                setConfirming={(on) => setConfirming(on ? "reset" : null)}
                onConfirm={resetProject}
              />
            ) : null}
            {!missingRoot ? (
              <ConfirmableDanger
                theme={theme}
                kind="rotate"
                icon="RefreshCw"
                label="Rotate seats"
                confirmLabel="Confirm Rotate"
                busy={busy}
                confirming={confirming === "rotate"}
                setConfirming={(on) => setConfirming(on ? "rotate" : null)}
                onConfirm={rotateSeats}
              />
            ) : null}
            <ConfirmableDanger
              theme={theme}
              kind="delete"
              icon="Trash2"
              label="Delete Project"
              confirmLabel="Confirm Delete"
              busy={busy}
              emphasised={missingRoot}
              confirming={confirming === "delete"}
              setConfirming={(on) => setConfirming(on ? "delete" : null)}
              onConfirm={deleteProject}
            />
          </View>
        </MenuSection>
      ) : <Text style={text(theme, "meta")}>Manage Project settings, Reset, Rotate and Delete on Paseo Desktop.</Text>}
    </View>
  );
}
