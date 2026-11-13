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

export type LanePickerView = Pick<FactoryView, "lanes" | "providers" | "providersLoading">;

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

const MODEL_ROW_H = 40;
/** The model list's floor when it flexes (`fill`), and its fixed height when the host scrolls the body. */
const LIST_MIN_H = 120;
const LIST_FIXED_H = 280;
/** Rows rendered at once — `All` can list every provider's models and the ScrollView is not virtualised. */
const MAX_ROWS = 200;

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

/** An action tucked behind the footer's `⋯` — the seat modal's machine default and last handover. */
export interface LaneMoreAction {
  label: string;
  testID: string;
  onPress(value: string): void;
}

/**
 * The live picker, one screen: a search across every provider, a one-line provider filter, the model list,
 * the thinking row and a footer (`summary · ⋯ Cancel primary`) that is always the last thing in the body.
 * `fill` = a flex column that takes the height of a bounded host (the seat modal's `Modal.Content
 * scrollable={false}`); otherwise the list gets a fixed height for hosts that scroll the whole body.
 */
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
  moreActions = [],
  explanation,
  summary: summaryOf,
  fill = false,
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
  /** Secondary acts, shown in the `⋯` row above the footer. */
  moreActions?: LaneMoreAction[];
  /** One sentence on what confirming does; lives in the `⋯` row (above the footer when there is no `⋯`). */
  explanation?: (value: string) => string;
  /** The footer's short summary of the act (`pi → antigravity · new session`); defaults to `current → new`. */
  summary?: (value: string) => string;
  fill?: boolean;
}) {
  const current = currentValue ?? card.value(view.lanes);
  const initial = splitLaneParts(current);
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [thinking, setThinking] = useState(initial.thinking);
  const [search, setSearch] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // Factory's own role providers (`factory-supervisor` …) only re-route onto a
  // lane's real provider — a lane pointing at one is circular, so the picker
  // hides them unless the current value already names one.
  const available = view.providers.filter((entry) => entry.available && (!INTERNAL_PROVIDERS.has(entry.provider) || entry.provider === initial.provider));
  const allowEyeJson = card.id === "fresh-eyes";
  /** The first provider listing is still in flight: `providers` is empty because nothing has loaded, not because there are none. */
  const loading = view.providersLoading === true && available.length === 0;
  // The filter starts on the current provider (familiar ground); `all` lists every provider's models.
  const [filter, setFilter] = useState<string>(() => (available.some((entry) => entry.provider === initial.provider) ? initial.provider : "all"));
  const activeModels = available.find((entry) => entry.provider === provider)?.models ?? null;
  /** A provider whose model list could not be read is likely unreachable — a handoff onto it tends to fail. */
  const unverified = !loading && provider !== "" && provider !== "eye.json" && available.some((entry) => entry.provider === provider) && (activeModels === null || activeModels.length === 0);
  const trimmedModel = model.trim();
  // A model the list does not carry is a custom ID — show the field it lives in. Never because the lists have not loaded yet.
  const customInUse = !loading && trimmedModel !== "" && activeModels !== null && activeModels.length > 0 && !activeModels.some((m) => m.id === trimmedModel);
  const listEmpty = !loading && provider !== "eye.json" && (activeModels === null || activeModels.length === 0);
  const showCustom = provider !== "eye.json" && (customOpen || customInUse || listEmpty);

  const q = search.trim().toLowerCase();
  const rows: { provider: string; model: ProviderModelView }[] = [];
  for (const entry of available) {
    if (filter !== "all" && entry.provider !== filter) continue;
    for (const m of entry.models ?? []) {
      if (q === "" || m.id.toLowerCase().includes(q) || (m.label !== null && m.label.toLowerCase().includes(q))) rows.push({ provider: entry.provider, model: m });
    }
  }
  const shownRows = rows.slice(0, MAX_ROWS);

  const selectedModelMeta = activeModels?.find((m) => m.id === trimmedModel);
  const advertisedThinking = selectedModelMeta?.thinkingOptions ?? null;
  const defaultThinking = selectedModelMeta?.defaultThinkingOptionId ?? null;
  const noThinkingSupported = Array.isArray(advertisedThinking) && advertisedThinking.length === 0;
  const thinkingChoices: { id: string; label: string }[] =
    advertisedThinking === null
      ? FALLBACK_THINKING_OPTIONS
      : advertisedThinking.length === 0
        ? []
        : advertisedThinking.map((o) => ({ id: o.id, label: o.label ?? o.id }));

  const trimmedThinking = noThinkingSupported ? "" : thinking.trim();
  const value =
    provider === "eye.json"
      ? "eye.json"
      : provider === "" || trimmedModel === ""
        ? ""
        : trimmedThinking === ""
          ? `${provider}/${trimmedModel}`
          : `${provider}/${trimmedModel}:${trimmedThinking}`;

  /** A provider chip filters the list and moves the selection onto that provider (keeping the model when it has one by that id). */
  const switchProvider = (nextProvider: string): void => {
    setProvider(nextProvider);
    setFilter(nextProvider);
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

  /** A row sets provider and model together, so picking from `All` switches provider. */
  const selectModel = (nextProvider: string, nextModel: ProviderModelView): void => {
    setProvider(nextProvider);
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
  const defaultSummary = value === current ? display(value) : `${current === "" ? "none" : display(current)} → ${display(value)}`;
  const summary = value === "" ? "Select a provider and model" : summaryOf === undefined ? defaultSummary : summaryOf(value);
  const now = splitLaneParts(current);

  const providerEntries = available.map((entry) => ({ id: entry.provider, label: entry.provider, count: entry.models?.length ?? 0, warn: entry.models === null || entry.models.length === 0 }));
  if (allowEyeJson) providerEntries.push({ id: "eye.json", label: "eye.json (HTTP)", count: 0, warn: false });
  const totalModels = providerEntries.reduce((sum, entry) => sum + entry.count, 0);

  // fill: the list takes whatever height the bounded host leaves; otherwise an explicit height (never only maxHeight — a bare-maxHeight ScrollView can collapse to nothing).
  const listBox = fill ? { flex: 1, minHeight: LIST_MIN_H } : { height: LIST_FIXED_H };
  const listBlock = (body: ReactNode) => <View style={{ ...listBox, borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.lg, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>{body}</View>;

  const filterEntry = available.find((entry) => entry.provider === filter);
  const emptyFilter = filter !== "all" && filter !== "eye.json" && (filterEntry?.models ?? []).length === 0;
  const listBody = loading ? (
    <View testID="lane-picker-loading" style={{ ...listBox, alignItems: "center", justifyContent: "center", gap: SPACING[1], padding: SPACING[3] }}>
      <Text style={text(theme, "label")}>Loading providers…</Text>
      <Text style={text(theme, "meta")}>Your current choice stays selected.</Text>
    </View>
  ) : filter === "eye.json" ? null : listBlock(
    <ScrollView style={fill ? { flex: 1 } : { height: LIST_FIXED_H }}>
      {available.length === 0 ? (
        <View style={{ padding: SPACING[3] }}><Text style={text(theme, "label", "statusWarning")}>No available providers — daemon unreachable.</Text></View>
      ) : emptyFilter ? (
        // No list to pick from: say so; the warning and the custom ID field sit right under it.
        <View style={{ padding: SPACING[3] }}><Text style={text(theme, "meta")}>Paseo returned no models for {filter}.</Text></View>
      ) : shownRows.length === 0 ? (
        <View style={{ padding: SPACING[3] }}><Text style={text(theme, "meta")}>No models match "{search}" — type a custom model ID instead.</Text></View>
      ) : (
        <>
          {shownRows.map((row, idx) => {
            const m = row.model;
            const isSelected = provider === row.provider && trimmedModel === m.id;
            return (
              <Pressable
                key={`${row.provider}/${m.id}`}
                accessibilityRole="button"
                onPress={() => selectModel(row.provider, m)}
                style={(state) => ({
                  minHeight: MODEL_ROW_H,
                  paddingHorizontal: SPACING[3],
                  paddingVertical: SPACING[1],
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
                {filter === "all" ? <Text style={text(theme, "meta")} numberOfLines={1}>{row.provider}</Text> : null}
              </Pressable>
            );
          })}
          {rows.length > shownRows.length ? <View style={{ padding: SPACING[2.5] }}><Text style={text(theme, "meta")}>Showing {shownRows.length} of {rows.length} — type to narrow the list.</Text></View> : null}
        </>
      )}
    </ScrollView>,
  );

  const customToggleInMore = fill && !showCustom && provider !== "eye.json" && !loading;
  const hasMore = moreActions.length > 0 || customToggleInMore;
  const explanationText = explanation === undefined || value === "" ? null : explanation(value);

  return (
    <View style={{ alignSelf: "stretch", gap: SPACING[2.5], ...(fill ? { flex: 1, minHeight: 0 } : {}) }}>
      {current === "" ? null : <Text testID="lane-picker-now" style={text(theme, "meta")} numberOfLines={1}>{`Now: ${[now.provider, now.model, now.thinking === "" ? "" : now.thinking].filter((part) => part !== "").join(" · ")}`}</Text>}

      {loading || filter === "eye.json" ? null : (
        <View style={{ minHeight: CONTROL_H, flexDirection: "row", alignItems: "center", gap: SPACING[1.5], paddingHorizontal: SPACING[2.5], borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.md, backgroundColor: theme.colors.surface1 }}>
          <Icon name="Search" size={13} color={theme.colors.foregroundMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search models across all providers…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{ flex: 1, paddingVertical: 5, color: theme.colors.foreground, fontSize: 12 }}
          />
          {search !== "" ? (
            <Pressable onPress={() => setSearch("")} style={{ padding: 2 }}>
              <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      )}

      {/* One line of provider chips that scrolls sideways — never wraps into a second row. */}
      {loading ? null : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], paddingRight: SPACING[2] }}>
          <Chip theme={theme} label="All" active={filter === "all"} count={totalModels} onPress={() => setFilter("all")} />
          {providerEntries.map((entry) => <Chip key={entry.id} theme={theme} label={entry.label} active={filter === entry.id} count={entry.count} {...(entry.warn ? { icon: "AlertTriangle" } : {})} onPress={() => switchProvider(entry.id)} />)}
        </ScrollView>
      )}

      {listBody}

      {unverified ? (
        <Text testID="lane-picker-unverified-provider" style={text(theme, "label", "statusWarning")}>
          Paseo lists no models for {provider}, so it may not be reachable right now. A handoff onto it can fail — check the provider in Paseo first.
        </Text>
      ) : null}

      {/* Custom model ID: opened from `⋯` (or the inline link where there is no `⋯`), or shown when the selected provider listed nothing. */}
      {showCustom ? (
        <View style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "label")}>Custom model ID</Text>
          <View style={{ minHeight: CONTROL_H, justifyContent: "center", borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.md, backgroundColor: theme.colors.surface1 }}>
            <TextInput
              value={model}
              onChangeText={(next) => { setCustomOpen(true); setModel(next); }}
              placeholder="e.g. zai/glm-5.3 or claude-sonnet-4-6"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: MONO_FONT }}
            />
          </View>
        </View>
      ) : !fill && provider !== "eye.json" && !loading ? (
        <Pressable testID="lane-picker-custom-toggle" accessibilityRole="button" onPress={() => setCustomOpen(true)} style={{ alignSelf: "flex-start" }}>
          <Text style={text(theme, "label", "accent")}>Use a custom model ID…</Text>
        </Pressable>
      ) : null}

      {/* Thinking: one compact row of the levels the selected model advertises, plus Default. */}
      {provider !== "eye.json" && !loading ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Text style={text(theme, "badge")}>THINKING</Text>
          <Chip
            theme={theme}
            label={noThinkingSupported ? "Default (none)" : defaultThinking !== null ? `Default (${defaultThinking})` : "Default"}
            active={trimmedThinking === ""}
            count={0}
            onPress={() => setThinking("")}
          />
          {thinkingChoices.map((opt) => <Chip key={opt.id} theme={theme} label={opt.label} active={trimmedThinking === opt.id} count={0} onPress={() => setThinking(opt.id)} />)}
        </View>
      ) : null}

      {!hasMore && explanationText !== null ? <Text style={text(theme, "meta")}>{explanationText}</Text> : null}

      {/* Footer: always the last thing in the body, one line. Left the summary of the act; right `⋯`, Cancel, then the one primary. */}
      <View style={{ gap: SPACING[2], paddingTop: SPACING[2.5], borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        {hasMore && moreOpen ? (
          <View testID="lane-picker-more" style={{ gap: SPACING[2] }}>
            {explanationText === null ? null : <Text style={text(theme, "meta")}>{explanationText}</Text>}
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
              {moreActions.map((action) => <Btn key={action.testID} theme={theme} small variant="secondary" testID={action.testID} label={action.label} disabled={value === "" || busy} onPress={() => action.onPress(value)} />)}
              {customToggleInMore ? <Btn theme={theme} small variant="secondary" testID="lane-picker-custom-toggle" label="Use a custom model ID…" onPress={() => { setCustomOpen(true); setMoreOpen(false); }} /> : null}
            </View>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
          <Text testID="lane-picker-summary" style={{ ...text(theme, "code"), flex: 1, minWidth: 0, color: value === "" ? theme.colors.statusWarning : theme.colors.foregroundMuted }} numberOfLines={1}>
            {summary}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
            {hasMore ? <Btn theme={theme} variant="ghost" testID="lane-picker-more-toggle" label="⋯" onPress={() => setMoreOpen(!moreOpen)} /> : null}
            <Btn theme={theme} variant="ghost" label="Cancel" onPress={onClose} />
            <Btn theme={theme} variant="primary" icon="Check" label={primaryLabel(value)} {...(primaryTestID === undefined ? {} : { testID: primaryTestID })} disabled={value === "" || busy} onPress={() => onSave(value)} />
          </View>
        </View>
      </View>
    </View>
  );
}

/** The three lanes a Project may override from its panel's `⋯` menu (v0.6.0 W6, ADR 0056). */
export const PROJECT_OVERRIDE_CARDS: LaneCard[] = LANE_CARDS.filter((card) => card.id === "supervisor" || card.id === "lead" || card.id === "worker");
