/**
 * Models pane — the interim Seats & Models tab (ADR 0009 §2; v0.6.0 W5,
 * ADR 0056): the Lane Profiles bar (v0.0.38, ADR 0026 §2) above four Lane
 * Cards (Supervisor, Lead, Default Worker, Watch) opening the live
 * provider/model/thinking picker modal, plus the Project usage card. The
 * standing seats moved onto the Project panel's seat rows (project-panel.tsx);
 * the Settings screen (W8) and the panel's `⋯` menu (W6) relocate this pane.
 * A multi-lane card saves through ONE
 * atomic setLanesBatch RPC (v0.0.38, ADR 0026 §5 — the dual-RPC race is
 * gone). Model writes use the same server-owned handoff rules as the
 * inline Project chip editor (ADR 0057 §8).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { FactoryView, LaneName, LaneProfileView, ProjectUsageView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_H, RADIUS, SPACING, text } from "../kit/theme.ts";
import { LANE_CARDS, LaneModalBody, PROJECT_OVERRIDE_CARDS, findModelMeta, splitLaneParts } from "./lane-editor.tsx";
import type { LaneCard } from "./lane-editor.tsx";

/** The Seats tab's whole action surface — the Shell owns the RPC calls. */
export interface SeatsActions {
  setLane(lane: LaneName, value: string): void;
  /**
   * One atomic batch save — every named lane in a single `factory.lanes.setBatch`
   * RPC (v0.0.38, ADR 0026 §5), never concurrent single-lane calls.
   */
  setLanesBatch(lanes: LaneName[], value: string): void;
  /** Save the scope's current lane table as a new named Lane profile. */
  saveProfile(name: string, description?: string): void;
  /** Overwrite one saved profile with the scope's current lane table. */
  updateProfile(profileId: string, name: string): void;
  /** Copy-on-Apply a saved profile's lanes into the selected scope. */
  applyProfile(profileId: string): void;
  /** Remove one saved Lane profile (behind the chip's two-step confirm). */
  deleteProfile(profileId: string): void;
  /** Remove the Project's lane override so it inherits the machine table again. */
  resetLanes(): void;
  busy: boolean;
}

/**
 * The Lane Profiles bar (v0.0.38, ADR 0026 §2) — one chip per saved profile,
 * applied to the selected scope in one click; `+ Save as Profile…` names and
 * saves the current 6-lane table; a modified scope offers `Update "<Profile>"`
 * and `+ Save as New Profile…`; each chip carries a two-step Delete; an
 * overridden Project offers Reset to Machine Default.
 */
function LaneProfilesBar({
  theme,
  view,
  actions,
  deletingProfileId,
  onRequestDelete,
  onApplyProfile,
  onUpdateProfile,
  onSaveAsProfile,
  onResetLanes,
}: {
  theme: PluginTheme;
  view: FactoryView;
  actions: SeatsActions;
  deletingProfileId: string | null;
  /** Two-step Delete's armer — `null` disarms (Confirm fired / Cancel). */
  onRequestDelete: (profileId: string | null) => void;
  onApplyProfile: (profile: LaneProfileView) => void;
  onUpdateProfile: (profile: LaneProfileView) => void;
  onSaveAsProfile: () => void;
  onResetLanes: () => void;
}) {
  const activeProfile = view.profiles.find((profile) => profile.id === view.activeProfileId) ?? null;
  return (
    <Card theme={theme} gap={SPACING[2.5]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ gap: 2, flex: 1 }}>
          <Text style={text(theme, "section")}>Lane Profiles</Text>
          <Text style={text(theme, "meta")}>
            One click copies a saved Lane profile into {view.project === null ? "the machine-wide Lane config" : `project ${view.project.slug}`} — Copy-on-Apply, no live pointer.
          </Text>
        </View>
        {view.activeProfileModified && activeProfile !== null ? (
          <Pill theme={theme} label={`Modified from "${activeProfile.name}"`} tone="statusWarning" lit />
        ) : null}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2.5], alignItems: "stretch" }}>
        {view.profiles.map((profile) => (
          <View key={profile.id} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
            <Chip
              theme={theme}
              label={profile.name}
              active={profile.id === view.activeProfileId}
              count={0}
              onPress={() => onApplyProfile(profile)}
            />
            {deletingProfileId === profile.id ? (
              <>
                <Btn
                  theme={theme}
                  small
                  solid
                  icon="Trash2"
                  label="Confirm Delete"
                  tone="statusDanger"
                  disabled={actions.busy}
                  onPress={() => {
                    onRequestDelete(null);
                    actions.deleteProfile(profile.id);
                  }}
                />
                <Btn theme={theme} small icon="X" label="Cancel" tone="foregroundMuted" disabled={actions.busy} onPress={() => onRequestDelete(null)} />
              </>
            ) : (
              <Btn
                theme={theme}
                small
                icon="Trash2"
                label="Delete"
                tone="foregroundMuted"
                disabled={actions.busy}
                onPress={() => onRequestDelete(profile.id)}
              />
            )}
          </View>
        ))}
        {view.profiles.length === 0 ? (
          <Text style={text(theme, "meta")}>No Lane profiles yet — configure the cards below and save your first profile.</Text>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {view.activeProfileModified && activeProfile !== null ? (
          <>
            <Btn
              theme={theme}
              small
              icon="Save"
              label={`Update "${activeProfile.name}"`}
              disabled={actions.busy}
              onPress={() => onUpdateProfile(activeProfile)}
            />
            <Btn theme={theme} small icon="Plus" label="+ Save as New Profile…" disabled={actions.busy} onPress={onSaveAsProfile} />
          </>
        ) : (
          <Btn theme={theme} small icon="Plus" label="+ Save as Profile…" disabled={actions.busy} onPress={onSaveAsProfile} />
        )}
        {view.hasProjectLaneOverride ? (
          <Btn theme={theme} small icon="RotateCcw" label="Reset to Machine Default" tone="statusWarning" disabled={actions.busy} onPress={onResetLanes} />
        ) : null}
      </View>
    </Card>
  );
}

/** `166,621,161` → `166.6M` — the one token format the usage surfaces print. */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** `cacheRead / gross-input` as a whole-percent string — `–` when nothing was read. */
function cacheHitPercent(buckets: { inputUncachedTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): string {
  const gross = buckets.inputUncachedTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
  if (gross <= 0) return "–";
  return `${Math.round((buckets.cacheReadTokens / gross) * 100)}%`;
}

/**
 * The Project Token & Model Usage card (v0.0.87, ADR 0043 §4): the scoped
 * Project's grand totals, cache-hit ratio, By Seat / Role rows, and By
 * Model / Provider rows — the rollup's whole world, rendered from
 * `view.projectUsage` alone (zero provider reads at render time). Renders
 * nothing when no session was recorded.
 */
export function ProjectUsageCard({ theme, usage }: { theme: PluginTheme; usage: ProjectUsageView | null }) {
  if (usage === null) return null;
  return (
    <Card theme={theme} gap={SPACING[2.5]}>
      <View style={{ gap: 2 }}>
        <Text style={text(theme, "section")}>Project Token Usage</Text>
        <Text style={text(theme, "label")}>
          {`${formatTokenCount(usage.totals.totalTokens)} tokens · ${usage.totals.sessionCount} session(s) · ${usage.totals.turns.toLocaleString("en-US")} turn(s) · cache-hit ${cacheHitPercent(usage.totals)}`}${usage.totals.totalCostUsd === null ? "" : ` · $${usage.totals.totalCostUsd.toFixed(2)}`}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
        <Pill theme={theme} icon="Coins" label={`${formatTokenCount(usage.totals.totalTokens)} tok`} tone="accent" lit mono />
        <Pill theme={theme} label={`in ${formatTokenCount(usage.totals.inputUncachedTokens)}`} mono />
        <Pill theme={theme} label={`cache-read ${formatTokenCount(usage.totals.cacheReadTokens)}`} mono />
        <Pill theme={theme} label={`out ${formatTokenCount(usage.totals.outputTokens)}`} mono />
        <Pill theme={theme} label={`reasoning ${formatTokenCount(usage.totals.reasoningTokens)}`} mono />
      </View>
      <View style={{ gap: SPACING[1.5] }}>
        <Text style={{ ...text(theme, "badge") }}>BY SEAT / ROLE</Text>
        {usage.bySeat.map((row) => (
          <View key={row.label} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
            <Text style={text(theme, "code")} numberOfLines={1}>
              {row.label}
            </Text>
            <Text style={{ ...text(theme, "code"), color: theme.colors.foregroundMuted }} numberOfLines={1}>
              {`${formatTokenCount(row.totalTokens)} tok · ${row.sessionCount} session(s)${row.totalCostUsd === null ? "" : ` · $${row.totalCostUsd.toFixed(2)}`}`}
            </Text>
          </View>
        ))}
      </View>
      <View style={{ gap: SPACING[1.5] }}>
        <Text style={{ ...text(theme, "badge") }}>BY MODEL / PROVIDER</Text>
        {usage.byModel.map((row) => (
          <View key={`${row.provider}/${row.model}`} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
            <Text style={text(theme, "code")} numberOfLines={1}>
              {`${row.provider}/${row.model}`}
            </Text>
            <Text style={{ ...text(theme, "code"), color: theme.colors.foregroundMuted }} numberOfLines={1}>
              {`${formatTokenCount(row.totalTokens)} tok · ${row.turns.toLocaleString("en-US")} turn(s)`}
            </Text>
          </View>
        ))}
      </View>
      <Text style={text(theme, "label")}>
        {`Per-task totals ride each task card. Updated ${usage.updatedAt.slice(0, 19).replace("T", " ")}Z${usage.backfilledAt === undefined ? "" : " · history backfilled"}.`}
      </Text>
    </Card>
  );
}

/**
 * Per-Project Supervisor / Lead / Worker model overrides — the Project menu's
 * Models section (v0.6.0 W6, ADR 0056). Compact rows over the same picker
 * modal and `lanes.set` act the Models pane
 * uses; every write targets the Project's own override file. `readOnly` is the
 * mobile form: the effective models are listed, nothing is editable.
 */
export function ProjectModelOverrides({
  theme,
  view,
  actions,
  modelSyncNote,
  readOnly,
}: {
  theme: PluginTheme;
  view: FactoryView;
  actions: Pick<SeatsActions, "setLane" | "resetLanes" | "busy">;
  modelSyncNote: string | null;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState<LaneCard | null>(null);
  const save = (card: LaneCard, value: string): void => {
    const lane = card.lanes[0]!;
    actions.setLane(lane, value);
    setEditing(null);
  };
  return (
    <View testID="factory-panel-menu-lanes" style={{ gap: SPACING[1.5] }}>
      {PROJECT_OVERRIDE_CARDS.map((card) => {
        const raw = card.value(view.lanes);
        return (
          <View key={card.id} testID={`factory-panel-lane-${card.id}`} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
            <Text style={{ ...text(theme, "label"), minWidth: 76 }}>{card.title}</Text>
            <Text style={{ ...text(theme, "code"), flexShrink: 1 }} numberOfLines={1}>{raw}</Text>
            {readOnly ? null : (
              <Btn theme={theme} small testID={`factory-panel-lane-change-${card.id}`} label="Change" tone="foregroundMuted" disabled={actions.busy} onPress={() => setEditing(card)} />
            )}
          </View>
        );
      })}
      {modelSyncNote !== null ? <Text style={text(theme, "meta")}>{modelSyncNote}</Text> : null}
      <Text style={text(theme, "meta")}>
        {view.hasProjectLaneOverride ? "This Project overrides the machine defaults." : "Inheriting the machine defaults."}
      </Text>
      {!readOnly && view.hasProjectLaneOverride ? (
        <Btn theme={theme} small testID="factory-panel-lane-reset" label="Reset to machine default" tone="foregroundMuted" disabled={actions.busy} onPress={actions.resetLanes} />
      ) : null}
      {readOnly ? null : (
        <>
          <Modal
            open={editing !== null}
            onOpenChange={(open) => (open ? undefined : setEditing(null))}
            title={editing === null ? "" : `Configure ${editing.title} Lane`}
            icon={undefined}
          >
            <Modal.Content>
              {editing === null ? null : (
                <LaneModalBody theme={theme} view={view} card={editing} busy={actions.busy} onSave={(value) => save(editing, value)} onClose={() => setEditing(null)} />
              )}
            </Modal.Content>
          </Modal>
        </>
      )}
    </View>
  );
}

export function SeatsPane({
  theme,
  view,
  actions,
  modelSyncNote,
}: {
  theme: PluginTheme;
  view: FactoryView;
  actions: SeatsActions;
  modelSyncNote: string | null;
}) {
  const [editing, setEditing] = useState<LaneCard | null>(null);
  /** The save-as-profile drawer's two fields (v0.0.38, ADR 0026 §2). */
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  /** The chip two-step Delete's armed profile (the header Reset/Delete pattern). */
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);

  // The two-step confirm auto-rearms after 5s — the header's Reset/Delete law.
  useEffect(() => {
    if (deletingProfileId === null) return;
    const timer = setTimeout(() => setDeletingProfileId(null), 5000);
    return () => clearTimeout(timer);
  }, [deletingProfileId]);

  /** Reset returns this scope to the machine lane table. */
  const requestResetLanes = (): void => {
    actions.resetLanes();
  };

  const save = (card: LaneCard, value: string): void => {
    // v0.0.38 (ADR 0026 §5): a multi-lane card rides ONE atomic setLanesBatch
    // RPC — two concurrent single-lane saves raced; a single-lane card keeps
    // the single setLane act.
    const commit = (): void => {
      if (card.lanes.length === 1) actions.setLane(card.lanes[0]!, value);
      else actions.setLanesBatch(card.lanes, value);
    };
    commit();
    setEditing(null);
  };

  const openSaveAsProfile = (): void => {
    setNameDraft("");
    setDescriptionDraft("");
    setNaming(true);
  };

  const saveAsProfile = (): void => {
    const name = nameDraft.trim();
    if (name === "") return;
    actions.saveProfile(name, descriptionDraft.trim() === "" ? undefined : descriptionDraft.trim());
    setNaming(false);
  };

  return (
    <View style={{ gap: SPACING[4] }}>
      {/* Section 1: Lane Switcher Grid */}
      <View style={{ gap: SPACING[2.5] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ gap: 2 }}>
            <Text style={text(theme, "section")}>Model & Thinking Lanes</Text>
            <Text style={text(theme, "label")}>
              {view.project === null
                ? "Machine default lanes — every new Project starts on these. A Project overrides them from its model chips."
                : `Configure provider, model, and thinking level per role (project override: ${view.project.slug}).`}
            </Text>
          </View>
          {modelSyncNote !== null ? <Pill theme={theme} label={modelSyncNote} tone="accent" lit /> : null}
        </View>

        <LaneProfilesBar
          theme={theme}
          view={view}
          actions={actions}
          deletingProfileId={deletingProfileId}
          onRequestDelete={setDeletingProfileId}
          onApplyProfile={(profile) => {
            actions.applyProfile(profile.id);
          }}
          onUpdateProfile={(profile) => {
            actions.updateProfile(profile.id, profile.name);
          }}
          onSaveAsProfile={() => {
            openSaveAsProfile();
          }}
          onResetLanes={requestResetLanes}
        />

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2.5], alignItems: "stretch" }}>
          {LANE_CARDS.map((card) => {
            const rawValue = card.value(view.lanes);
            const parts = splitLaneParts(rawValue);
            const meta = findModelMeta(view, parts.provider, parts.model);
            const thinkingBadge =
              parts.provider === "eye.json"
                ? null
                : parts.thinking !== ""
                  ? { label: `thinking: ${parts.thinking}`, lit: true }
                  : meta?.defaultThinkingOptionId
                    ? { label: `thinking: ${meta.defaultThinkingOptionId} (default)`, lit: false }
                    : { label: "thinking: default", lit: false };
            return (
              <Card
                key={card.id}
                theme={theme}
                gap={SPACING[2]}
                style={{ flexBasis: 270, flexGrow: 1, justifyContent: "space-between" }}
              >
                <View style={{ gap: SPACING[2] }}>
                  {/* Card Header: Role Name + Tier Badge */}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[1.5], flexWrap: "wrap" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                      <Icon name={card.icon} size={14} color={theme.colors.accent} />
                      <Text style={text(theme, "rowTitle")}>{card.title}</Text>
                    </View>
                    <Pill theme={theme} label={card.tier} tone="accent" lit />
                  </View>

                  {/* Recessed Model & Thinking Display Box */}
                  <View
                    style={{
                      paddingHorizontal: SPACING[2.5],
                      paddingVertical: SPACING[2],
                      borderRadius: RADIUS.md,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surface0,
                      gap: SPACING[1.5],
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                      {parts.provider !== "" ? <Pill theme={theme} label={parts.provider} tone="accent" lit /> : null}
                      <Text style={{ ...text(theme, "code"), flex: 1 }} numberOfLines={1}>
                        {parts.model !== "" ? parts.model : rawValue}
                      </Text>
                    </View>
                    {thinkingBadge !== null ? (
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                        <Pill
                          theme={theme}
                          label={thinkingBadge.label}
                          tone={thinkingBadge.lit ? "accent" : "foregroundMuted"}
                          lit={thinkingBadge.lit}
                        />
                      </View>
                    ) : null}
                  </View>

                  <Text style={text(theme, "meta")} numberOfLines={2}>
                    {card.hint}
                  </Text>
                </View>

                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: SPACING[1] }}>
                  <Text style={{ ...text(theme, "code"), fontSize: 11, color: theme.colors.foregroundMuted }} numberOfLines={1}>
                    {card.lanes.join(" + ")}
                  </Text>
                  <Btn theme={theme} small icon="Sliders" label="Configure" disabled={actions.busy} onPress={() => setEditing(card)} />
                </View>
              </Card>
            );
          })}
        </View>
      </View>

      <Modal
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        title={editing === null ? "" : `Configure ${editing.title} Lane`}
        icon={undefined}
      >
        <Modal.Content>
          {editing === null ? null : (
            <LaneModalBody
              theme={theme}
              view={view}
              card={editing}
              busy={actions.busy}
              onSave={(value) => save(editing, value)}
              onClose={() => setEditing(null)}
            />
          )}
        </Modal.Content>
      </Modal>

      {/* The save-as-profile drawer (v0.0.38, ADR 0026 §2): name (and an
          optional description) for the current Lane config, with the active lanes
          itself previewed — what confirming persists. */}
      <Modal open={naming} onOpenChange={(open) => (open ? undefined : setNaming(false))} title="Save Lane profile">
        <Modal.Content>
          <View style={{ gap: SPACING[3] }}>
            <View style={{ gap: SPACING[1.5] }}>
              <Text style={text(theme, "badge")}>PROFILE NAME</Text>
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
                  value={nameDraft}
                  onChangeText={setNameDraft}
                  placeholder="e.g. Fast & Cheap"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12 }}
                />
              </View>
            </View>
            <View style={{ gap: SPACING[1.5] }}>
              <Text style={text(theme, "badge")}>DESCRIPTION (OPTIONAL)</Text>
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
                  value={descriptionDraft}
                  onChangeText={setDescriptionDraft}
                  placeholder="What this lane setup is for"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12 }}
                />
              </View>
            </View>
            <View style={{ gap: SPACING[1] }}>
              <Text style={text(theme, "badge")}>ACTIVE LANES</Text>
              {(["supervisor", "lead", "worker", "watch"] as LaneName[]).map((lane) => (
                <Text key={lane} style={text(theme, "code")}>
                  {lane}={view.lanes[lane]}
                </Text>
              ))}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: SPACING[2] }}>
              <Btn theme={theme} label="Cancel" tone="foregroundMuted" onPress={() => setNaming(false)} />
              <Btn theme={theme} solid icon="Save" label="Save Profile" disabled={nameDraft.trim() === "" || actions.busy} onPress={saveAsProfile} />
            </View>
          </View>
        </Modal.Content>
      </Modal>

      {/* Section 3: Project Token & Model Usage (v0.0.87, ADR 0043 §4) */}
      <ProjectUsageCard theme={theme} usage={view.projectUsage ?? null} />
    </View>
  );
}
