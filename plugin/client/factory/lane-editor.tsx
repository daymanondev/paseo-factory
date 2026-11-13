/**
 * The lane editor (split out of seats.tsx, v0.6.0 review S6, ADR 0056): the
 * Lane Cards that name which lanes a card covers, and the live
 * provider/model/thinking picker body — the Settings screen's defaults,
 * inline Project model chips and the onboarding wizard's Models step all
 * edit through `LaneModalBody`.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { FactoryView, LaneName, Lanes, ProviderModelView } from "../../shared/view.ts";
import { Btn, Chip } from "../kit/pill.tsx";
import { CONTROL_H, MONO_FONT, RADIUS, SPACING, hoveredOf, text, tint } from "../kit/theme.ts";

export type LanePickerView = Pick<FactoryView, "lanes" | "providers">;

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

/** Factory's role-routing providers (ADR 0017 §2) — never a lane target of their own. */
const INTERNAL_PROVIDERS: ReadonlySet<string> = new Set(["factory-supervisor", "factory-lead", "factory-peer", "factory-agent"]);

/** Measured body width from which the picker is two columns (providers left, models right); narrower stacks them. */
const WIDE_BODY = 560;
const MODEL_ROW_H = 44;

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

/** The live picker: provider list, searchable model list, thinking level row and a footer with the `current → new` summary and the actions. */
export function LaneModalBody({
  theme,
  view,
  card,
  onSave,
  onClose,
  busy,
  currentValue,
  primaryLabel = () => "Save lane",
  primaryTestID,
  secondaryAction,
  explanation,
  footerExtra,
}: {
  theme: PluginTheme;
  view: LanePickerView;
  card: LaneCard;
  onSave: (value: string) => void;
  onClose: () => void;
  busy: boolean;
  currentValue?: string;
  primaryLabel?: (value: string) => string;
  primaryTestID?: string;
  secondaryAction?: { label: string; testID: string; onSave(value: string): void };
  explanation?: (value: string) => string;
  /** Extra footer actions, left of Cancel (the seat modal's "View last handover"). */
  footerExtra?: ReactNode;
}) {
  const current = currentValue ?? card.value(view.lanes);
  const initial = splitLaneParts(current);
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [thinking, setThinking] = useState(initial.thinking);
  const [search, setSearch] = useState("");
  const [familyFilter, setFamilyFilter] = useState<string>("all");
  // Unmeasured (0) reads as narrow; the first layout pass settles it.
  const [width, setWidth] = useState(0);

  // Factory's own role providers (`factory-supervisor` …) only re-route onto a
  // lane's real provider — a lane pointing at one is circular, so the picker
  // hides them unless the current value already names one.
  const available = view.providers.filter((entry) => entry.available && (!INTERNAL_PROVIDERS.has(entry.provider) || entry.provider === initial.provider));
  const activeModels = available.find((entry) => entry.provider === provider)?.models ?? null;
  const allowEyeJson = card.id === "fresh-eyes";
  /** A provider whose model list could not be read is likely unreachable — a handoff onto it tends to fail. */
  const unverified = provider !== "" && provider !== "eye.json" && available.some((entry) => entry.provider === provider) && (activeModels === null || activeModels.length === 0);
  const [customOpen, setCustomOpen] = useState(
    initial.model !== "" && !(view.providers.find((entry) => entry.provider === initial.provider)?.models ?? []).some((m) => m.id === initial.model),
  );
  const showCustom = customOpen || activeModels === null || activeModels.length === 0;

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

  const laneWords = (raw: string): string => {
    const parts = splitLaneParts(raw);
    return `${parts.model}${parts.thinking === "" ? "" : ` · ${parts.thinking}`}`;
  };
  /** `current → new` in model · thinking words; the provider only shows when it changes. */
  const providerChanged = value !== "" && splitLaneParts(current).provider !== provider;
  const display = (raw: string): string => (providerChanged ? `${splitLaneParts(raw).provider}/${laneWords(raw)}` : laneWords(raw));
  const summary = value === "" ? "Select a provider and model" : value === current ? display(value) : `${current === "" ? "none" : display(current)} → ${display(value)}`;

  const wide = width >= WIDE_BODY;
  const providerEntries = available.map((entry) => ({ id: entry.provider, label: entry.provider, count: entry.models?.length ?? 0, warn: entry.models === null || entry.models.length === 0 }));
  if (allowEyeJson) providerEntries.push({ id: "eye.json", label: "eye.json (HTTP)", count: 0, warn: false });
  const noProviders = available.length === 0 ? <Text style={text(theme, "label", "statusWarning")}>No available providers — daemon unreachable.</Text> : null;
  const providers = wide ? (
    <View style={{ width: 180, gap: SPACING[0.5] }}>
      <Text style={text(theme, "badge")}>PROVIDER</Text>
      {providerEntries.map((entry) => <ProviderRow key={entry.id} theme={theme} label={entry.label} active={provider === entry.id} count={entry.count} warn={entry.warn} onPress={() => switchProvider(entry.id)} />)}
      {noProviders}
    </View>
  ) : (
    <View style={{ gap: SPACING[1.5] }}>
      <Text style={text(theme, "badge")}>PROVIDER</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {providerEntries.map((entry) => <Chip key={entry.id} theme={theme} label={entry.label} active={provider === entry.id} count={entry.count} {...(entry.warn ? { icon: "AlertTriangle" } : {})} onPress={() => switchProvider(entry.id)} />)}
        {noProviders}
      </View>
    </View>
  );

  const listHeight = Math.max(132, Math.min(Math.max(filteredModels.length, 1) * MODEL_ROW_H, 320));
  const models = provider === "eye.json" ? null : (
    <View style={{ flex: 1, minWidth: 0, gap: SPACING[2] }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Text style={text(theme, "badge")}>MODEL {activeModels !== null && activeModels.length > 0 ? `(${filteredModels.length} of ${activeModels.length})` : ""}</Text>
        {families.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
            <Chip theme={theme} label="All" active={familyFilter === "all"} count={activeModels?.length ?? 0} onPress={() => setFamilyFilter("all")} />
            {families.map((fam) => <Chip key={fam.id} theme={theme} label={fam.id} active={familyFilter === fam.id} count={fam.count} onPress={() => setFamilyFilter(fam.id)} />)}
          </View>
        ) : null}
      </View>

      {unverified ? (
        // No list to pick from: say so, warn, and put the custom ID field straight under it.
        <View style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "meta")}>Paseo returned no models for {provider}.</Text>
          <Text testID="lane-picker-unverified-provider" style={text(theme, "label", "statusWarning")}>
            Paseo lists no models for {provider}, so it may not be reachable right now. A handoff onto it can fail — check the provider in Paseo first.
          </Text>
        </View>
      ) : null}

      {activeModels !== null && activeModels.length > 0 ? (
        <View style={{ gap: SPACING[1.5] }}>
          <View style={{ minHeight: CONTROL_H, flexDirection: "row", alignItems: "center", gap: SPACING[1.5], paddingHorizontal: SPACING[2.5], borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.md, backgroundColor: theme.colors.surface1 }}>
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

          {/* An explicit height, never only maxHeight: a bare-maxHeight ScrollView can collapse to nothing inside a host that does not size it. */}
          <View style={{ height: listHeight, borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.lg, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
            <ScrollView style={{ height: listHeight }}>
              {filteredModels.length === 0 ? (
                <View style={{ padding: SPACING[3] }}>
                  <Text style={text(theme, "meta")}>No models match "{search}" — type a custom model ID below.</Text>
                </View>
              ) : (
                filteredModels.map((m, idx) => {
                  const isSelected = trimmedModel === m.id;
                  return (
                    <Pressable
                      key={m.id}
                      accessibilityRole="button"
                      onPress={() => selectModel(m)}
                      style={(state) => ({
                        minHeight: MODEL_ROW_H,
                        paddingHorizontal: SPACING[3],
                        paddingVertical: SPACING[1.5],
                        borderTopWidth: idx === 0 ? 0 : 1,
                        borderTopColor: theme.colors.border,
                        backgroundColor: isSelected ? tint(theme.colors.accent, "1f") : state.pressed || hoveredOf(state) ? theme.colors.surface2 : "transparent",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: SPACING[2],
                      })}
                    >
                      <View style={{ width: 16, height: 16, borderRadius: 99, borderWidth: 1, borderColor: isSelected ? theme.colors.accent : theme.colors.border, backgroundColor: isSelected ? theme.colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                        {isSelected ? <Icon name="Check" size={10} color={theme.colors.surface0} /> : null}
                      </View>
                      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                        <Text style={{ ...text(theme, "section"), fontWeight: isSelected ? "600" : "500", color: isSelected ? theme.colors.accent : theme.colors.foreground }} numberOfLines={1}>
                          {m.label ?? m.id}
                        </Text>
                        {m.label !== null && m.label !== m.id ? (
                          <Text style={{ ...text(theme, "code"), fontSize: 11, color: theme.colors.foregroundMuted }} numberOfLines={1}>
                            {m.id}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      ) : null}

      {/* Custom model ID — tucked behind a link while a list covers it, shown directly when there is none. */}
      {!showCustom ? (
        <Pressable testID="lane-picker-custom-toggle" accessibilityRole="button" onPress={() => setCustomOpen(true)} style={{ alignSelf: "flex-start" }}>
          <Text style={text(theme, "label", "accent")}>Use a custom model ID…</Text>
        </Pressable>
      ) : (
        <View style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "label")}>Custom model ID</Text>
          <View style={{ minHeight: CONTROL_H, justifyContent: "center", borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.md, backgroundColor: theme.colors.surface1 }}>
            <TextInput
              value={model}
              onChangeText={setModel}
              placeholder="e.g. zai/glm-5.3 or claude-sonnet-4-6"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: MONO_FONT }}
            />
          </View>
        </View>
      )}
    </View>
  );

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ alignSelf: "stretch", gap: SPACING[3] }}>
      {wide ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACING[4] }}>
          {providers}
          {models}
        </View>
      ) : (
        <>
          {providers}
          {models}
        </>
      )}

      {/* Thinking: one compact row of the levels the selected model advertises, plus its default. */}
      {provider !== "eye.json" ? (
        <View style={{ gap: SPACING[1.5] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Text style={text(theme, "badge")}>THINKING</Text>
            <Text style={text(theme, "label")}>
              {noThinkingSupported ? "No thinking variants supported by this model" : defaultThinking !== null ? `Model default: ${defaultThinking}` : "Optional — appended as :thinking"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Chip
              theme={theme}
              label={noThinkingSupported ? "Default (none)" : defaultThinking !== null ? `Provider default (${defaultThinking})` : "Provider default"}
              active={trimmedThinking === ""}
              count={0}
              onPress={() => setThinking("")}
            />
            {thinkingChoices.map((opt) => <Chip key={opt.id} theme={theme} label={opt.label} active={trimmedThinking === opt.id} count={0} onPress={() => setThinking(opt.id)} />)}
          </View>
        </View>
      ) : null}

      {explanation === undefined ? null : <Text style={text(theme, "meta")}>{explanation(value)}</Text>}

      {/* Footer: always the last thing in the body. Left the summary; right Cancel, the secondary acts, then the one primary. */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2], paddingTop: SPACING[3], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        <Text testID="lane-picker-summary" style={{ ...text(theme, "code"), flex: 1, minWidth: 160, color: value === "" ? theme.colors.statusWarning : theme.colors.foregroundMuted }} numberOfLines={2}>
          {summary}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
          {footerExtra}
          <Btn theme={theme} variant="ghost" label="Cancel" onPress={onClose} />
          {secondaryAction === undefined ? null : <Btn theme={theme} variant="secondary" testID={secondaryAction.testID} label={secondaryAction.label} disabled={value === "" || busy} onPress={() => secondaryAction.onSave(value)} />}
          <Btn theme={theme} variant="primary" icon="Check" label={primaryLabel(value)} {...(primaryTestID === undefined ? {} : { testID: primaryTestID })} disabled={value === "" || busy} onPress={() => onSave(value)} />
        </View>
      </View>
    </View>
  );
}

/** One provider in the wide layout's left list: the name first, then a muted model count; the selected row carries the accent tint. */
function ProviderRow({ theme, label, active, count, warn, onPress }: { theme: PluginTheme; label: string; active: boolean; count: number; warn: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={(state) => ({
        minHeight: CONTROL_H,
        paddingHorizontal: SPACING[2.5],
        borderRadius: RADIUS.md,
        backgroundColor: active ? tint(theme.colors.accent, "1f") : state.pressed || hoveredOf(state) ? theme.colors.surface2 : "transparent",
        flexDirection: "row",
        alignItems: "center",
        gap: SPACING[1.5],
      })}
    >
      {warn ? <Icon name="AlertTriangle" size={12} color={theme.colors.statusWarning} /> : null}
      <Text style={{ ...text(theme, "label"), flex: 1, fontWeight: active ? "600" : "500", color: active ? theme.colors.accent : theme.colors.foreground }} numberOfLines={1}>
        {label}
      </Text>
      {count > 0 ? <Text style={{ ...text(theme, "badge"), fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
    </Pressable>
  );
}


/** The three lanes a Project may override from its panel's `⋯` menu (v0.6.0 W6, ADR 0056). */
export const PROJECT_OVERRIDE_CARDS: LaneCard[] = LANE_CARDS.filter((card) => card.id === "supervisor" || card.id === "lead" || card.id === "worker");
