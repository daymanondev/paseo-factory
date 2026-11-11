/**
 * The Project menu (v0.6.0 W6, ADR 0056 §5) — the header `⋯`'s content: this
 * Project's own settings, one section per concern, out of the main view.
 * Models (per-Project Supervisor / Lead / Worker overrides), Skill packs,
 * Open Design (link / unlink), and the two destructive acts Reset Project and
 * Delete Project, each behind a two-step confirm that re-arms after 5 seconds.
 *
 * A pure render with local UI state only: the Shell supplies the models and
 * Open Design slots (they own RPC state of their own) and the pack / reset /
 * delete callbacks. Mobile is view-only — packs read as text, the slots are
 * handed their read-only form by the Shell, and Reset / Delete never mount.
 * A Project whose folder is gone keeps Delete only (nothing else can act on a
 * missing root). Test hooks: `factory-panel-menu-models|skills|od|danger`,
 * `factory-panel-skill-<id>`, `factory-panel-menu-reset|delete`,
 * `factory-panel-menu-confirm-reset|confirm-delete`. Function components
 * only — no class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Btn } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";

/** One Project skill pack as the menu lists it (`view.skillHub.projectPacks`). */
export interface MenuSkillPack {
  id: string;
  label: string;
  enabled: boolean;
  autoDetected: boolean;
}

export type MenuConfirming = "reset" | "delete" | null;

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
  kind: "reset" | "delete";
  icon: "RotateCcw" | "Trash2";
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
  modelsSlot,
  openDesignSlot,
  skillPacks,
  togglePack,
  resetProject,
  deleteProject,
  initialConfirming = null,
}: {
  theme: PluginTheme;
  /** True on Paseo mobile — the whole menu is view-only. */
  mobile: boolean;
  busy: boolean;
  /** The Project's folder is gone: only Delete can act. */
  missingRoot: boolean;
  /** Per-Project Supervisor / Lead / Worker model overrides (read-only form on mobile). */
  modelsSlot: ReactNode;
  /** Open Design link / unlink controls (desktop); null on mobile. */
  openDesignSlot: ReactNode;
  skillPacks: MenuSkillPack[];
  togglePack(id: string, enabled: boolean): void;
  resetProject(): void;
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
      {!missingRoot ? (
        <MenuSection theme={theme} id="models" title="Models for this Project">
          {modelsSlot}
        </MenuSection>
      ) : null}
      {!missingRoot ? (
        <MenuSection theme={theme} id="skills" title="Skill packs">
          {skillPacks.length === 0 ? <Text style={text(theme, "meta")}>No skill packs available.</Text> : null}
          {skillPacks.map((pack) =>
            mobile ? (
              <Text key={pack.id} style={text(theme, "meta")}>
                {pack.label} · {pack.enabled ? "on" : "off"}
                {pack.autoDetected ? " (auto-detected)" : ""}
              </Text>
            ) : (
              <View key={pack.id} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                <Btn
                  theme={theme}
                  small
                  testID={`factory-panel-skill-${pack.id}`}
                  label={`${pack.label} · ${pack.enabled ? "on" : "off"}`}
                  tone={pack.enabled ? "accent" : "foregroundMuted"}
                  disabled={busy}
                  onPress={() => togglePack(pack.id, !pack.enabled)}
                />
                {pack.autoDetected ? <Text style={text(theme, "meta")}>auto-detected</Text> : null}
              </View>
            ),
          )}
        </MenuSection>
      ) : null}
      {!missingRoot && openDesignSlot !== null ? (
        <MenuSection theme={theme} id="od" title="Open Design">
          {openDesignSlot}
        </MenuSection>
      ) : null}
      {!mobile ? (
        <MenuSection theme={theme} id="danger" title="Danger zone">
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
      ) : null}
    </View>
  );
}
