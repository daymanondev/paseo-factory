/**
 * Tab 2 — Seats & Models (ADR 0009 §2; the Lead lane and live Lead seat
 * arrive in v0.0.14, ADR 0010 §2): five Lane Cards (Supervisor, Lead,
 * Default Worker, Watch & Retro, Fresh-eyes) opening the live
 * provider/model/thinking picker modal, and below them the orthogonal Seat
 * Graph — Owner ⇄ Supervisor ⇄ Lead ⇄ Working Agents — with live Timeline
 * Oracle seqEnd, Open Session (navigation.openAgent), Revoke Supervisor, and
 * Rotate Lead.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AgentView, FactoryView, LaneName, Lanes, ProviderModelView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_H, CONTROL_SM, RADIUS, SPACING, hoveredOf, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

/** The Seats tab's whole action surface — the Shell owns the RPC calls. */
export interface SeatsActions {
  setLane(lane: LaneName, value: string): void;
  revokeSupervisor(): void;
  /** Retire the Project's Lead (cancel + archive) so the next dispatch starts fresh. */
  rotateLead(): void;
  openAgent(agentId: string): void;
  busy: boolean;
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
  {
    id: "fresh-eyes",
    title: "Fresh-eyes",
    icon: "Sparkles",
    tier: "Reviewer · ≠ Worker",
    hint: "Second-opinion reviewer on green diffs from a different family than Worker, or eye.json.",
    lanes: ["freshEyes"],
    value: (l) => l.freshEyes,
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

function SeatNode({
  theme,
  title,
  icon,
  subtitle,
  pills,
}: {
  theme: PluginTheme;
  title: string;
  icon: string;
  subtitle: string;
  pills: { label: string; tone?: Colour; lit?: boolean; mono?: boolean }[];
}) {
  return (
    <Card theme={theme} gap={SPACING[1.5]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
          <Text style={text(theme, "rowTitle")}>{title}</Text>
        </View>
        {pills.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
            {pills.map((pill) => (
              <Pill key={pill.label} theme={theme} label={pill.label} tone={pill.tone ?? "foregroundMuted"} lit={pill.lit} mono={pill.mono} />
            ))}
          </View>
        ) : null}
      </View>
      <Text style={text(theme, "meta")} numberOfLines={1}>
        {subtitle}
      </Text>
    </Card>
  );
}

/** The orthogonal rail between graph levels — a clean vertical connector. */
function Rail({ theme, height = SPACING[2.5] }: { theme: PluginTheme; height?: number }) {
  return <View style={{ width: 2, height, backgroundColor: theme.colors.border, marginLeft: SPACING[4] }} />;
}

function AgentCard({
  theme,
  agent,
  actions,
  retireLabel,
  onRetire,
}: {
  theme: PluginTheme;
  agent: AgentView;
  actions: SeatsActions;
  retireLabel?: string;
  onRetire?: () => void;
}) {
  const icon = agent.seat === "supervisor" ? "Shield" : agent.seat === "lead" ? "Compass" : "Cpu";
  return (
    <Card theme={theme} gap={SPACING[2]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2], flexWrap: "wrap" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexShrink: 1 }}>
          <Icon name={icon} size={14} color={theme.colors.accent} />
          <Text style={text(theme, "rowTitle")} numberOfLines={1}>
            {agent.title ?? agent.id.slice(0, 12)}
          </Text>
          <Pill
            theme={theme}
            label={agent.status}
            tone={agent.status === "error" ? "statusDanger" : agent.status === "running" ? "accent" : "statusSuccess"}
            lit={agent.status === "running" || agent.status === "error"}
          />
          {agent.requiresAttention === true ? <Pill theme={theme} label="attention" tone="statusWarning" lit /> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          {retireLabel !== undefined && onRetire !== undefined ? (
            <Btn theme={theme} small icon="RotateCcw" label={retireLabel} tone="statusDanger" disabled={actions.busy} onPress={onRetire} />
          ) : null}
          <Btn theme={theme} small icon="ExternalLink" label="Open Session" onPress={() => actions.openAgent(agent.id)} />
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Pill theme={theme} label={agent.provider} mono />
        {agent.model !== null && agent.model !== agent.provider ? <Pill theme={theme} label={agent.model} mono /> : null}
        {agent.thinking !== undefined && agent.thinking !== null ? (
          <Pill theme={theme} label={`thinking: ${agent.thinking}`} tone="accent" lit />
        ) : null}
        {agent.task !== null ? <Pill theme={theme} label={`task ${agent.task}`} tone="accent" lit /> : null}
        {agent.seqEnd !== null ? <Pill theme={theme} label={`seqEnd ${agent.seqEnd}`} mono /> : null}
        {/* The Lead telemetry trio (v0.0.20, ADR 0013 §6): live context usage
            against the fixed 128k handoff mark, the rotation state, and the
            queued mailbox count — present only on the Lead's view, so every
            other seat's card simply skips them. */}
        {agent.contextUsedTokens !== undefined && agent.contextUsedTokens !== null ? (
          <Pill theme={theme} label={`${Math.round(agent.contextUsedTokens / 1000)}k / 128k handoff`} mono />
        ) : null}
        {agent.rotationState !== undefined ? (
          <Pill
            theme={theme}
            label={agent.rotationState}
            tone={agent.rotationState === "handing_over" ? "accent" : agent.rotationState === "rotation_pending" ? "statusWarning" : "foregroundMuted"}
            lit={agent.rotationState !== "normal"}
          />
        ) : null}
        {agent.queuedMailCount !== undefined && agent.queuedMailCount > 0 ? (
          <Pill theme={theme} label={`${agent.queuedMailCount} queued`} tone="accent" lit />
        ) : null}
      </View>
    </Card>
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
  const workers = view.agents.filter((agent) => agent.id !== view.supervisor?.id && agent.id !== view.lead?.id);
  const save = (card: LaneCard, value: string): void => {
    for (const lane of card.lanes) actions.setLane(lane, value);
    setEditing(null);
  };
  return (
    <View style={{ gap: SPACING[4] }}>
      {/* Section 1: Lane Switcher Grid */}
      <View style={{ gap: SPACING[2.5] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ gap: 2 }}>
            <Text style={text(theme, "section")}>Model & Thinking Lanes</Text>
            <Text style={text(theme, "label")}>
              Configure provider, model, and thinking level per role ({view.project === null ? "machine-wide lanes.json" : `project override: ${view.project.slug}`}).
            </Text>
          </View>
          {modelSyncNote !== null ? <Pill theme={theme} label={modelSyncNote} tone="accent" lit /> : null}
        </View>

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
            actions={actions}
            retireLabel="Revoke Supervisor"
            onRetire={actions.revokeSupervisor}
          />
        ) : (
          <SeatNode
            theme={theme}
            title="Supervisor — vacant"
            icon="Shield"
            subtitle="Conversational delegate for the Owner — chat directly in your Paseo conversation."
            pills={[{ label: "seat=supervisor", tone: "foregroundMuted" }, { label: view.lanes.supervisor, mono: true }]}
          />
        )}
        <Rail theme={theme} />
        {view.lead !== null ? (
          <AgentCard
            theme={theme}
            agent={view.lead}
            actions={actions}
            retireLabel="Rotate Lead"
            onRetire={actions.rotateLead}
          />
        ) : (
          <SeatNode
            theme={theme}
            title="Lead — standby"
            icon="Compass"
            subtitle="Standing technical seat under the Supervisor — decomposes directives into contracted Tasks and runs the Driver."
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
    </View>
  );
}
