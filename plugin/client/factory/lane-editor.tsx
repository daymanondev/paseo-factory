/**
 * The lane editor (split out of seats.tsx, v0.6.0 review S6, ADR 0056): the
 * Lane Cards that name which lanes a card covers, and the live
 * provider/model/thinking picker modal every lane write opens — the Settings
 * screen's default models, the Project menu's overrides and the onboarding
 * wizard's Models step all edit through `LaneModalBody`.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { FactoryView, LaneName, Lanes, ProviderModelView } from "../../shared/view.ts";
import { Btn, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_H, MONO_FONT, RADIUS, SPACING, hoveredOf, text, tint } from "../kit/theme.ts";

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
export function splitLaneParts(raw: string): { provider: string; model: string; thinking: string } {
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
export function findModelMeta(view: FactoryView, provider: string, modelId: string): ProviderModelView | undefined {
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


/** The three lanes a Project may override from its panel's `⋯` menu (v0.6.0 W6, ADR 0056). */
export const PROJECT_OVERRIDE_CARDS: LaneCard[] = LANE_CARDS.filter((card) => card.id === "supervisor" || card.id === "lead" || card.id === "worker");
