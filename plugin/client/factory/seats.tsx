import { SeatNode, Rail, AgentCard } from "./seat-graph.tsx";
import { ScrumSeatsPane } from "./scrum.tsx";
import type { ScrumAction } from "./scrum.tsx";
/**
 * Tab 2 — Seats & Models (ADR 0009 §2; the Lead lane and live Lead seat
 * arrive in v0.0.14, ADR 0010 §2): the Lane Profiles bar (v0.0.38, ADR 0026
 * §2) above four Lane Cards (Supervisor, Lead, Default Worker, Watch &
 * Retro) opening the live provider/model/thinking picker modal,
 * and below them the orthogonal Seat Graph — Owner ⇄ Supervisor ⇄ Lead ⇄
 * Working Agents — with live Timeline Oracle seqEnd, Open
 * (navigation.openAgent), Revoke Supervisor, and Rotate Lead on live seats
 * (v0.0.27, ADR 0017 §3); vacant seats carry their picker hints — the
 * Supervisor starts from Paseo's native New Chat picker, the Lead is spawned
 * automatically by the Supervisor. A multi-lane card saves through ONE
 * atomic setLanesBatch RPC (v0.0.38, ADR 0026 §5 — the dual-RPC race is
 * gone), and any lane act that moves a live Supervisor/Lead seat crosses
 * the Live-Seat Transition Law first (ADR 0026 §3): no impact → straight
 * through; an impact → the Confirm & Apply modal before the RPC.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AgentView, FactoryView, LaneName, LaneProfileView, Lanes, ProviderModelView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill, SegmentedControl } from "../kit/pill.tsx";
import { CONTROL_H, CONTROL_SM, RADIUS, SPACING, hoveredOf, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import { planLiveSeatTransitions } from "../kit/live-seats.ts";
import type { LiveSeatTransition } from "../kit/live-seats.ts";

/** The Seats tab's whole action surface — the Shell owns the RPC calls. */
export interface SeatsActions {
  setMode?(mode: "slp" | "scrum"): void;
  scrum?: ScrumAction;
  setLane(lane: LaneName, value: string): void;
  /**
   * One atomic batch save — every named lane in a single `factory.lanes.setBatch`
   * RPC (v0.0.38, ADR 0026 §5), never concurrent single-lane calls.
   */
  setLanesBatch(lanes: LaneName[], value: string): void;
  /** Save the scope's current 6-lane table as a new named Lane profile. */
  saveProfile(name: string, description?: string): void;
  /** Overwrite one saved profile with the scope's current 6-lane table. */
  updateProfile(profileId: string, name: string): void;
  /** Copy-on-Apply a saved profile's six lanes into the selected scope. */
  applyProfile(profileId: string): void;
  /** Remove one saved Lane profile (behind the chip's two-step confirm). */
  deleteProfile(profileId: string): void;
  /** Remove the Project's lane override so it inherits the machine table again. */
  resetLanes(): void;
  /** Retire the Project's Lead (cancel + archive) so the next dispatch starts fresh. */
  rotateLead(): void;
  revokeSupervisor(): void;
  openAgent(agentId: string): void;
  busy: boolean;
}

/** One confirmed-pending lane act — the live-seat impact modal's whole world. */
type PendingLaneAct = { transitions: LiveSeatTransition[]; run: () => void };

/** The modal's seat label — the standing seats' own names. */
function seatLabel(seat: "supervisor" | "lead"): string {
  return seat === "supervisor" ? "Supervisor" : "Lead";
}

/** Which lanes a card covers — "Watch & Retro" writes both lanes, one value. */
interface LaneCard {
  id: string;
  title: string;
  icon: string;
  tier: string;
  hint: string;
  lanes: LaneName[];
  value: (lanes: Lanes) => string;
}

const LANE_CARDS: LaneCard[] = [
  {
    id: "supervisor",
    title: "Supervisor",
    icon: "Shield",
    tier: "Reasoning / Pro",
    hint: "Drafts Contracts, reviews ratified Retro proposals, and relays verdicts to the Owner.",
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
    id: "watch-retro",
    title: "Watch & Retro",
    icon: "Eye",
    tier: "Flash / Fast",
    hint: "Fast, wide-context model for 5-question risk scoring & daily ledger retrospective.",
    lanes: ["watch", "retro"],
    value: (l) => (l.watch === l.retro ? l.watch : `${l.watch} · ${l.retro}`),
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
  if (colon === -1) return { provider, model: rest, thinking: "" };
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
function LaneModalBody({
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
      const targetModel = existing ?? nextModels.find((m) => m.id === "zai/glm-5.3") ?? nextModels[0]!;
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
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
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
  const [machineRoster, setMachineRoster] = useState<"slp" | "scrum">("slp");
  /** The save-as-profile drawer's two fields (v0.0.38, ADR 0026 §2). */
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  /** The chip two-step Delete's armed profile (the header Reset/Delete pattern). */
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  /** The Live-Seat Transition Law's parked act (v0.0.38, ADR 0026 §3). */
  const [pending, setPending] = useState<PendingLaneAct | null>(null);
  const workers = view.agents.filter((agent) => agent.id !== view.supervisor?.id && agent.id !== view.lead?.id);

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
    // RPC — the two concurrent single-lane saves raced (the Watch & Retro
    // defect); a single-lane card keeps the single setLane act.
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

  const readOnly = view.project === null;
  const effectiveActions: SeatsActions = readOnly ? { ...actions, busy: true } : actions;
  const machineControls = view.project === null ? (
    <Card theme={theme} gap={SPACING[2.5]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
        <Pill theme={theme} label="All projects · View-only" tone="statusWarning" lit />
        <Text style={text(theme, "section")}>Read-only Overview</Text>
      </View>
      <Text style={text(theme, "meta")}>
        Mode switching and lane/profile edits are disabled in All projects to protect existing projects. Select a specific project in the Project Switcher above to change its mode or lanes.
      </Text>
      <SegmentedControl
        theme={theme}
        options={[
          { value: "slp", label: "View SLP Lanes (6)" },
          { value: "scrum", label: "View Agile Scrum Roster (8)" },
        ]}
        value={machineRoster}
        onChange={setMachineRoster}
      />
    </Card>
  ) : null;
  if ((view.project ? view.execution?.selectedMode : machineRoster) === "scrum") return <View style={{ gap: SPACING[4] }}>{machineControls}<ScrumSeatsPane theme={theme} view={view} busy={actions.busy || readOnly} action={readOnly ? undefined : actions.scrum} actions={effectiveActions} renderEditor={(title, current, save, close) => <Modal open onOpenChange={open => { if (!open) close(); }} title={title}><Modal.Content><LaneModalBody theme={theme} view={view} card={{ id: "scrum", title, icon: "Cpu", tier: "Specialist", hint: "Independent Scrum lane", lanes: [], value: () => current }} onSave={save} onClose={close} busy={actions.busy || readOnly} /></Modal.Content></Modal>} /></View>;

  return (
    <View style={{ gap: SPACING[4] }}>
      {machineControls}
      {/* Section 1: Lane Switcher Grid */}
      <View style={{ gap: SPACING[2.5] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ gap: 2 }}>
            <Text style={text(theme, "section")}>Model & Thinking Lanes</Text>
            <Text style={text(theme, "label")}>
              {view.project === null
                ? "Read-only machine default lanes — select a project above to configure project lanes."
                : `Configure provider, model, and thinking level per role (project override: ${view.project.slug}).`}
            </Text>
          </View>
          {modelSyncNote !== null ? <Pill theme={theme} label={modelSyncNote} tone="accent" lit /> : null}
        </View>

        <LaneProfilesBar
          theme={theme}
          view={view}
          actions={effectiveActions}
          deletingProfileId={deletingProfileId}
          onRequestDelete={setDeletingProfileId}
          onApplyProfile={(profile) => {
            if (readOnly) return;
            requestLaneChange(profile.lanes, () => actions.applyProfile(profile.id));
          }}
          onUpdateProfile={(profile) => {
            if (readOnly) return;
            actions.updateProfile(profile.id, profile.name);
          }}
          onSaveAsProfile={() => {
            if (readOnly) return;
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
                  <Btn theme={theme} small icon="Sliders" label="Configure" disabled={actions.busy || readOnly} onPress={() => { if (!readOnly) setEditing(card); }} />
                </View>
              </Card>
            );
          })}
        </View>
      </View>

      {/* Section 2: Seat Graph */}
      <View style={{ gap: SPACING[1.5] }}>
        <View style={{ gap: 2, paddingBottom: SPACING[1] }}>
          <Text style={text(theme, "section")}>Seat Graph</Text>
          <Text style={text(theme, "label")}>
            Orthogonal hierarchy: Owner ⇄ Supervisor ⇄ Lead ⇄ Working Agents.
          </Text>
        </View>
        <SeatNode
          theme={theme}
          title="Owner"
          icon="User"
          subtitle="You — the only seat that accepts verified attempts and ratifies retro proposals."
          pills={[{ label: `$${view.kpis.totalCostUsd.toFixed(2)} metered`, mono: true }]}
        />
        <Rail theme={theme} />
        {view.supervisor !== null ? (
          <AgentCard
            theme={theme}
            agent={view.supervisor}
            actions={effectiveActions}
            retireLabel="Revoke Supervisor"
            onRetire={actions.revokeSupervisor}
          />
        ) : (
          <SeatNode
            theme={theme}
            title="Supervisor — not started"
            icon="Shield"
            subtitle={'Select "Supervisor (Factory)" in New Chat to start'}
            pills={[{ label: "seat=supervisor", tone: "foregroundMuted" }, { label: view.lanes.supervisor, mono: true }]}
          />
        )}
        <Rail theme={theme} />
        {view.lead !== null ? (
          <AgentCard
            theme={theme}
            agent={view.lead}
            actions={effectiveActions}
            retireLabel="Rotate Lead"
            onRetire={actions.rotateLead}
          />
        ) : (
          <SeatNode
            theme={theme}
            title="Lead — not started"
            icon="Compass"
            subtitle="Spawned automatically by Supervisor"
            pills={[{ label: "seat=lead", tone: "foregroundMuted" }, { label: view.lanes.lead, mono: true }]}
          />
        )}
        <Rail theme={theme} />
        {workers.length === 0 ? (
          <SeatNode
            theme={theme}
            title="Working Agents — none active"
            icon="Cpu"
            subtitle="Spawned task agents appear here as the ledger binds them."
            pills={[{ label: view.lanes.worker, mono: true }]}
          />
        ) : (
          <View style={{ gap: SPACING[2] }}>
            {workers.map((agent) => (
              <AgentCard key={agent.id} theme={theme} agent={agent} actions={actions} />
            ))}
          </View>
        )}
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
              {(["supervisor", "lead", "worker", "watch", "retro"] as LaneName[]).map((lane) => (
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
    </View>
  );
}
