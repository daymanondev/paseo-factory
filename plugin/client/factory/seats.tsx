/**
 * Models pane — the interim Seats & Models tab (ADR 0009 §2; v0.6.0 W5,
 * ADR 0056): the Lane Profiles bar (v0.0.38, ADR 0026 §2) above four Lane
 * Cards (Supervisor, Lead, Default Worker, Watch) opening the live
 * provider/model/thinking picker modal, plus the Project usage card. The
 * standing seats moved onto the Project panel's seat rows (project-panel.tsx);
 * the Settings screen (W8) and the panel's `⋯` menu (W6) relocate this pane.
 * A multi-lane card saves through ONE
 * atomic setLanesBatch RPC (v0.0.38, ADR 0026 §5 — the dual-RPC race is
 * gone), and any lane act that moves a live Supervisor/Lead seat crosses
 * the Live-Seat Transition Law first (ADR 0026 §3): no impact → straight
 * through; an impact → the Confirm & Apply modal before the RPC.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { FactoryView, LaneName, LaneProfileView, Lanes, ProjectUsageView, ProviderModelView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_H, MONO_FONT, RADIUS, SPACING, hoveredOf, text, tint } from "../kit/theme.ts";
import { planLiveSeatTransitions } from "../kit/live-seats.ts";
import type { LiveSeatTransition } from "../kit/live-seats.ts";

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

/** One confirmed-pending lane act — the live-seat impact modal's whole world. */
type PendingLaneAct = { transitions: LiveSeatTransition[]; run: () => void };

/** The modal's seat label — the standing seats' own names. */
function seatLabel(seat: "supervisor" | "lead"): string {
  return seat === "supervisor" ? "Supervisor" : "Lead";
}

/** Which lanes a card covers — one value written to every lane the card names. */
export interface LaneCard {
  id: string;
  title: string;
  icon: string;
  tier: string;
  hint: string;
  lanes: LaneName[];
  value: (lanes: Lanes) => string;
}

export const LANE_CARDS: LaneCard[] = [
  {
    id: "supervisor",
    title: "Supervisor",
    icon: "Shield",
    tier: "Reasoning / Pro",
    hint: "Drafts Contracts and relays verdicts to the Owner.",
    lanes: ["supervisor"],
    value: (l) => l.supervisor,
  },
  {
    id: "lead",
    title: "Lead",
    icon: "Compass",
    tier: "Reasoning / Pro",
    hint: "Splits directives into Tasks & Contracts and drives working agents to verified green.",
    lanes: ["lead"],
    value: (l) => l.lead,
  },
  {
    id: "worker",
    title: "Default Worker",
    icon: "Cpu",
    tier: "Coding Workhorse",
    hint: "Coding model for multi-attempt implementation & Gate runs in isolated task worktrees.",
    lanes: ["worker"],
    value: (l) => l.worker,
  },
  {
    id: "watch",
    title: "Watch",
    icon: "Eye",
    tier: "Flash / Fast",
    hint: "Fast, wide-context model for 5-question risk scoring.",
    lanes: ["watch"],
    value: (l) => l.watch,
  },
];

const FALLBACK_THINKING_OPTIONS: { id: string; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

/** Parses `provider/model[:thinking]` into display parts. */
function splitLaneParts(raw: string): { provider: string; model: string; thinking: string } {
  const first = raw.split(" · ")[0] ?? raw;
  if (first === "eye.json") return { provider: "eye.json", model: "", thinking: "" };
  const slash = first.indexOf("/");
  if (slash === -1) return { provider: "", model: first, thinking: "" };
  const provider = first.slice(0, slash);
  const rest = first.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  const lastSep = Math.max(rest.lastIndexOf("\\"), rest.lastIndexOf("/"));
  if (colon === -1 || colon < lastSep) return { provider, model: rest, thinking: "" };
  return { provider, model: rest.slice(0, colon), thinking: rest.slice(colon + 1) };
}

/** Finds a model's metadata from `view.providers` when discovered. */
function findModelMeta(view: FactoryView, provider: string, modelId: string): ProviderModelView | undefined {
  const entry = view.providers.find((p) => p.provider === provider);
  return entry?.models?.find((m) => m.id === modelId);
}

/** Extracts sub-vendor prefix from a model id like `zai/glm-5.3` -> `zai`. */
function modelPrefixOf(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash === -1 ? null : modelId.slice(0, slash);
}

/** The live picker: provider buttons, searchable/grouped model list, thinking level selector, and preview. */
export function LaneModalBody({
  theme,
  view,
  card,
  onSave,
  onClose,
  busy,
}: {
  theme: PluginTheme;
  view: FactoryView;
  card: LaneCard;
  onSave: (value: string) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const current = card.value(view.lanes);
  const initial = splitLaneParts(current);
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [thinking, setThinking] = useState(initial.thinking);
  const [search, setSearch] = useState("");
  const [familyFilter, setFamilyFilter] = useState<string>("all");

  const available = view.providers.filter((entry) => entry.available);
  const activeModels = available.find((entry) => entry.provider === provider)?.models ?? null;
  const allowEyeJson = card.id === "fresh-eyes";

  // Extract sub-families (e.g. "zai", "github-copilot", "google-antigravity" for pi)
  const families: { id: string; count: number }[] = [];
  if (activeModels !== null) {
    const counts = new Map<string, number>();
    for (const m of activeModels) {
      const prefix = modelPrefixOf(m.id);
      if (prefix !== null) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    if (counts.size > 1) {
      for (const [id, count] of counts) families.push({ id, count });
      families.sort((a, b) => a.id.localeCompare(b.id));
    }
  }

  const q = search.trim().toLowerCase();
  const filteredModels =
    activeModels === null
      ? []
      : activeModels.filter((m) => {
          if (familyFilter !== "all" && modelPrefixOf(m.id) !== familyFilter) return false;
          if (q === "") return true;
          return m.id.toLowerCase().includes(q) || (m.label !== null && m.label.toLowerCase().includes(q));
        });

  const selectedModelMeta = activeModels?.find((m) => m.id === model.trim());
  const advertisedThinking = selectedModelMeta?.thinkingOptions ?? null;
  const defaultThinking = selectedModelMeta?.defaultThinkingOptionId ?? null;
  const noThinkingSupported = Array.isArray(advertisedThinking) && advertisedThinking.length === 0;
  const thinkingChoices: { id: string; label: string }[] =
    advertisedThinking === null
      ? FALLBACK_THINKING_OPTIONS
      : advertisedThinking.length === 0
        ? []
        : advertisedThinking.map((o) => ({ id: o.id, label: o.label ?? o.id }));

  const trimmedModel = model.trim();
  const trimmedThinking = noThinkingSupported ? "" : thinking.trim();
  const value =
    provider === "eye.json"
      ? "eye.json"
      : provider === "" || trimmedModel === ""
        ? ""
        : trimmedThinking === ""
          ? `${provider}/${trimmedModel}`
          : `${provider}/${trimmedModel}:${trimmedThinking}`;

  const switchProvider = (nextProvider: string): void => {
    setProvider(nextProvider);
    setSearch("");
    setFamilyFilter("all");
    if (nextProvider === "eye.json") {
      setModel("");
      setThinking("");
      return;
    }
    const nextModels = available.find((entry) => entry.provider === nextProvider)?.models ?? null;
    if (nextModels !== null && nextModels.length > 0) {
      const existing = nextModels.find((m) => m.id === model);
      const targetModel =
        existing ??
        nextModels.find((m) => m.id === "GLM-5.3" || m.id === "zai/glm-5.3" || m.id === "builtin:zai-coding-plan\\GLM-5.3") ??
        nextModels[0]!;
      if (!existing) {
        setModel(targetModel.id);
      }
      if (!targetModel.thinkingOptions || targetModel.thinkingOptions.length === 0 || !targetModel.thinkingOptions.some((o) => o.id === thinking)) {
        setThinking("");
      }
    } else {
      setThinking("");
    }
  };

  const selectModel = (nextModel: ProviderModelView): void => {
    setModel(nextModel.id);
    // Keep current thinking only if the new model explicitly advertises support for it; otherwise reset to default ("")
    if (!nextModel.thinkingOptions || nextModel.thinkingOptions.length === 0 || !nextModel.thinkingOptions.some((o) => o.id === thinking)) {
      setThinking("");
    }
  };

  return (
    <View style={{ gap: SPACING[3] }}>
      {/* Role Header Banner */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: SPACING[2],
          padding: SPACING[2.5],
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
            <Icon name={card.icon} size={14} color={theme.colors.accent} />
            <Text style={text(theme, "rowTitle")}>{card.title}</Text>
            <Pill theme={theme} label={card.tier} tone="accent" lit />
          </View>
          <Text style={text(theme, "meta")}>{card.hint}</Text>
        </View>
      </View>

      {/* Step 1: Provider */}
      <View style={{ gap: SPACING[1.5] }}>
        <Text style={text(theme, "badge")}>1. PROVIDER</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
          {available.map((entry) => (
            <Chip
              key={entry.provider}
              theme={theme}
              label={entry.provider}
              active={provider === entry.provider}
              count={entry.models?.length ?? 0}
              onPress={() => switchProvider(entry.provider)}
            />
          ))}
          {allowEyeJson ? (
            <Chip
              theme={theme}
              label="eye.json (HTTP)"
              active={provider === "eye.json"}
              count={0}
              onPress={() => switchProvider("eye.json")}
            />
          ) : null}
          {available.length === 0 ? (
            <Text style={text(theme, "label", "statusWarning")}>No available providers — daemon unreachable.</Text>
          ) : null}
        </View>
      </View>

      {/* Step 2: Model */}
      {provider !== "eye.json" ? (
        <View style={{ gap: SPACING[2] }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Text style={text(theme, "badge")}>
              2. MODEL {activeModels !== null ? `(${filteredModels.length} of ${activeModels.length})` : ""}
            </Text>
            {families.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
                <Chip
                  theme={theme}
                  label="All"
                  active={familyFilter === "all"}
                  count={activeModels?.length ?? 0}
                  onPress={() => setFamilyFilter("all")}
                />
                {families.map((fam) => (
                  <Chip
                    key={fam.id}
                    theme={theme}
                    label={fam.id}
                    active={familyFilter === fam.id}
                    count={fam.count}
                    onPress={() => setFamilyFilter(fam.id)}
                  />
                ))}
              </View>
            ) : null}
          </View>

          {activeModels !== null && activeModels.length > 0 ? (
            <View style={{ gap: SPACING[1.5] }}>
              {/* Search bar */}
              <View
                style={{
                  minHeight: CONTROL_H,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: SPACING[1.5],
                  paddingHorizontal: SPACING[2.5],
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: RADIUS.md,
                  backgroundColor: theme.colors.surface1,
                }}
              >
                <Icon name="Search" size={13} color={theme.colors.foregroundMuted} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder={`Search ${activeModels.length} models (e.g. glm-5.3, sonnet, gpt-5.4)…`}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{ flex: 1, paddingVertical: 5, color: theme.colors.foreground, fontSize: 12 }}
                />
                {search !== "" ? (
                  <Pressable onPress={() => setSearch("")} style={{ padding: 2 }}>
                    <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
                  </Pressable>
                ) : null}
              </View>

              {/* Scrollable Model List (no 16-item cutoff) */}
              <View
                style={{
                  maxHeight: 210,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: RADIUS.lg,
                  backgroundColor: theme.colors.surface1,
                  overflow: "hidden",
                }}
              >
                <ScrollView style={{ maxHeight: 210 }}>
                  {filteredModels.length === 0 ? (
                    <View style={{ padding: SPACING[3] }}>
                      <Text style={text(theme, "meta")}>No models match "{search}" — type a custom model ID below.</Text>
                    </View>
                  ) : (
                    filteredModels.map((m, idx) => {
                      const isSelected = trimmedModel === m.id;
                      const opts = m.thinkingOptions ?? null;
                      return (
                        <Pressable
                          key={m.id}
                          accessibilityRole="button"
                          onPress={() => selectModel(m)}
                          style={(state) => ({
                            minHeight: 36,
                            paddingHorizontal: SPACING[3],
                            paddingVertical: SPACING[1.5],
                            borderTopWidth: idx === 0 ? 0 : 1,
                            borderTopColor: theme.colors.border,
                            backgroundColor: isSelected
                              ? tint(theme.colors.accent, "1f")
                              : state.pressed || hoveredOf(state)
                                ? theme.colors.surface2
                                : "transparent",
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: SPACING[2],
                          })}
                        >
                          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flex: 1 }}>
                            <View
                              style={{
                                width: 16,
                                height: 16,
                                borderRadius: 99,
                                borderWidth: 1,
                                borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                                backgroundColor: isSelected ? theme.colors.accent : "transparent",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {isSelected ? <Icon name="Check" size={10} color={theme.colors.surface0} /> : null}
                            </View>
                            <View style={{ flex: 1, gap: 1 }}>
                              <Text
                                style={{
                                  ...text(theme, "section"),
                                  fontWeight: isSelected ? "600" : "500",
                                  color: isSelected ? theme.colors.accent : theme.colors.foreground,
                                }}
                                numberOfLines={1}
                              >
                                {m.label ?? m.id}
                              </Text>
                              {m.label !== null && m.label !== m.id ? (
                                <Text style={{ ...text(theme, "code"), fontSize: 11, color: theme.colors.foregroundMuted }} numberOfLines={1}>
                                  {m.id}
                                </Text>
                              ) : null}
                            </View>
                          </View>
                          {opts !== null && opts.length > 0 ? (
                            <Pill
                              theme={theme}
                              label={`thinking: ${opts.map((o) => o.id).join("/")}`}
                              tone={isSelected ? "accent" : "foregroundMuted"}
                              lit={isSelected}
                            />
                          ) : null}
                        </Pressable>
                      );
                    })
                  )}
                </ScrollView>
              </View>
            </View>
          ) : null}

          {/* Manual / Custom Model ID Input */}
          <View style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Model ID (select above or type custom):</Text>
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
                value={model}
                onChangeText={setModel}
                placeholder="e.g. zai/glm-5.3 or claude-sonnet-4-6"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: MONO_FONT }}
              />
            </View>
          </View>
        </View>
      ) : null}

      {/* Step 3: Thinking Level / Reasoning Effort */}
      {provider !== "eye.json" ? (
        <View style={{ gap: SPACING[1.5] }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1] }}>
            <Text style={text(theme, "badge")}>3. THINKING LEVEL (REASONING EFFORT)</Text>
            <Text style={text(theme, "label")}>
              {noThinkingSupported
                ? "No thinking variants supported by this model"
                : defaultThinking !== null
                  ? `Model default: ${defaultThinking}`
                  : "Optional — appended as :thinking"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Chip
              theme={theme}
              label={
                noThinkingSupported
                  ? "Default (none)"
                  : defaultThinking !== null
                    ? `Provider default (${defaultThinking})`
                    : "Provider default"
              }
              active={trimmedThinking === ""}
              count={0}
              onPress={() => setThinking("")}
            />
            {thinkingChoices.map((opt) => (
              <Chip
                key={opt.id}
                theme={theme}
                label={opt.label}
                active={trimmedThinking === opt.id}
                count={0}
                onPress={() => setThinking(opt.id)}
              />
            ))}
          </View>
        </View>
      ) : null}

      {/* Preview & Actions */}
      <View
        style={{
          padding: SPACING[2.5],
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: SPACING[2],
        }}
      >
        <View style={{ gap: 2, flex: 1 }}>
          <Text style={text(theme, "badge")}>EFFECTIVE LANE VALUE</Text>
          <Text style={{ ...text(theme, "code"), color: value === "" ? theme.colors.statusWarning : theme.colors.accent }}>
            {value === "" ? "Select a provider and model" : value}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2] }}>
          <Btn theme={theme} label="Cancel" tone="foregroundMuted" onPress={onClose} />
          <Btn theme={theme} icon="Check" label="Save lane" solid disabled={value === "" || busy} onPress={() => onSave(value)} />
        </View>
      </View>
    </View>
  );
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

/**
 * The Live-Seat Transition Law's confirmation modal (v0.0.38, ADR 0026 §3):
 * each affected standing seat, its fromLane → toLane, and whether confirming
 * updates the model in-place or retires/rotates the session. Confirm &
 * Apply dispatches the parked RPC; Cancel drops it.
 */
function LiveSeatConfirmModal({ theme, pending, busy, onConfirm, onCancel }: { theme: PluginTheme; pending: PendingLaneAct | null; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const rows: { seat: "supervisor" | "lead"; agentId: string; fromLane: string; toLane: string; impact: string; danger: boolean }[] =
    pending === null
      ? []
      : pending.transitions.map((transition) => ({
          seat: transition.seat,
          agentId: transition.agentId,
          fromLane: transition.fromLane,
          toLane: transition.toLane,
          impact:
            transition.mode === "in-place"
              ? "Update model in-place (keeps current session)"
              : "Retire/Rotate live seat (provider family changed — current session will be archived and recreated on next turn)",
          danger: transition.mode === "retire",
        }));
  return (
    <Modal open={pending !== null} onOpenChange={(open) => (open ? undefined : onCancel())} title="Confirm live seat impact">
      <Modal.Content>
        {pending === null ? null : (
          <View style={{ gap: SPACING[3] }}>
            <Text style={text(theme, "meta")}>
              This lane change moves a live standing seat — Confirm & Apply executes it; Cancel leaves every lane and session untouched.
            </Text>
            {rows.map((row) => (
              <Card key={`${row.seat}-${row.agentId}`} theme={theme} gap={SPACING[1.5]}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                  <Icon name={row.seat === "supervisor" ? "Shield" : "Compass"} size={14} color={theme.colors.accent} />
                  <Text style={text(theme, "rowTitle")}>{seatLabel(row.seat)}</Text>
                  <Pill theme={theme} label={row.agentId.slice(0, 12)} mono />
                </View>
                <Text style={text(theme, "code")}>
                  {row.fromLane} → {row.toLane}
                </Text>
                <Text style={text(theme, "label", row.danger ? "statusDanger" : "statusWarning")}>{row.impact}</Text>
              </Card>
            ))}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: SPACING[2] }}>
              <Btn theme={theme} label="Cancel" tone="foregroundMuted" disabled={busy} onPress={onCancel} />
              <Btn
                theme={theme}
                solid
                icon="Check"
                label="Confirm & Apply"
                tone={rows.some((row) => row.danger) ? "statusDanger" : "statusWarning"}
                disabled={busy}
                onPress={onConfirm}
              />
            </View>
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}

/** `166,621,161` → `166.6M` — the one token format the usage surfaces print. */
export function formatTokenCount(value: number): string {
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

/** The three lanes a Project may override from its panel's `⋯` menu (v0.6.0 W6, ADR 0056). */
export const PROJECT_OVERRIDE_CARDS: LaneCard[] = LANE_CARDS.filter((card) => card.id === "supervisor" || card.id === "lead" || card.id === "worker");

/**
 * Per-Project Supervisor / Lead / Worker model overrides — the Project menu's
 * Models section (v0.6.0 W6, ADR 0056). Compact rows over the same picker
 * modal, Live-Seat Transition Law gate and `lanes.set` act the Models pane
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
  const [pending, setPending] = useState<PendingLaneAct | null>(null);
  const requestLaneChange = (nextLanes: Lanes, run: () => void): void => {
    const transitions = planLiveSeatTransitions(view.lanes, nextLanes, { supervisor: view.supervisor, lead: view.lead });
    if (transitions.length === 0) run();
    else setPending({ transitions, run });
  };
  const save = (card: LaneCard, value: string): void => {
    const lane = card.lanes[0]!;
    requestLaneChange({ ...view.lanes, [lane]: value }, () => actions.setLane(lane, value));
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
        <Btn theme={theme} small testID="factory-panel-lane-reset" label="Reset to machine default" tone="foregroundMuted" disabled={actions.busy} onPress={() => requestLaneChange(view.machineLanes, actions.resetLanes)} />
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
          <LiveSeatConfirmModal
            theme={theme}
            pending={pending}
            busy={actions.busy}
            onConfirm={() => {
              const run = pending?.run;
              setPending(null);
              if (run !== undefined) run();
            }}
            onCancel={() => setPending(null)}
          />
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
  /** The Live-Seat Transition Law's parked act (v0.0.38, ADR 0026 §3). */
  const [pending, setPending] = useState<PendingLaneAct | null>(null);

  // The two-step confirm auto-rearms after 5s — the header's Reset/Delete law.
  useEffect(() => {
    if (deletingProfileId === null) return;
    const timer = setTimeout(() => setDeletingProfileId(null), 5000);
    return () => clearTimeout(timer);
  }, [deletingProfileId]);

  /**
   * The Live-Seat Transition Law's gate (v0.0.38, ADR 0026 §3): on a Project
   * scope, an act that changes supervisor/lead while that seat is live parks
   * behind the Confirm & Apply modal; everything else — and every act on the
   * machine-wide scope — goes straight through with no modal.
   */
  const requestLaneChange = (nextLanes: Lanes, run: () => void): void => {
    if (view.project === null) {
      run();
      return;
    }
    const transitions = planLiveSeatTransitions(view.lanes, nextLanes, { supervisor: view.supervisor, lead: view.lead });
    if (transitions.length === 0) {
      run();
      return;
    }
    setPending({ transitions, run });
  };

  /**
   * Reset rides the same exact gate (v0.0.38, ADR 0026 §3, Implementation
   * Decision 4): the machine table the Project re-inherits rides the view
   * (`machineLanes`), so the reset plans its live-seat transitions like every
   * other act — an override that leaves supervisor/lead untouched runs
   * immediately with no modal (User Story 17).
   */
  const requestResetLanes = (): void => {
    requestLaneChange(view.machineLanes, actions.resetLanes);
  };

  const save = (card: LaneCard, value: string): void => {
    const next: Lanes = { ...view.lanes };
    for (const lane of card.lanes) next[lane] = value;
    // v0.0.38 (ADR 0026 §5): a multi-lane card rides ONE atomic setLanesBatch
    // RPC — two concurrent single-lane saves raced; a single-lane card keeps
    // the single setLane act.
    const commit = (): void => {
      if (card.lanes.length === 1) actions.setLane(card.lanes[0]!, value);
      else actions.setLanesBatch(card.lanes, value);
    };
    requestLaneChange(next, commit);
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
                ? "Machine default lanes — every new Project starts on these. A Project overrides them from its panel's ⋯ menu."
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
            requestLaneChange(profile.lanes, () => actions.applyProfile(profile.id));
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

      <LiveSeatConfirmModal
        theme={theme}
        pending={pending}
        busy={actions.busy}
        onConfirm={() => {
          const run = pending?.run;
          setPending(null);
          if (run !== undefined) run();
        }}
        onCancel={() => setPending(null)}
      />

      {/* Section 3: Project Token & Model Usage (v0.0.87, ADR 0043 §4) */}
      <ProjectUsageCard theme={theme} usage={view.projectUsage ?? null} />
    </View>
  );
}
