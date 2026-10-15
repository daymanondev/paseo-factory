/**
 * Tab 2 — Seats & Models (ADR 0009 §2; the Lead lane and live Lead seat
 * arrive in v0.0.14, ADR 0010 §2): five Lane Cards (Supervisor, Lead,
 * Default Worker, Watch & Retro, Fresh-eyes) opening the live
 * provider/model picker modal, and below them the orthogonal Seat Graph —
 * Owner ⇄ Supervisor ⇄ Lead ⇄ Working Agents — with live Timeline Oracle
 * seqEnd, Open Session (navigation.openAgent), Revoke Supervisor, and
 * Rotate Lead.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { AgentView, FactoryView, LaneName, Lanes } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { RADIUS, SPACING, text } from "../kit/theme.ts";
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
  tier: string;
  hint: string;
  lanes: LaneName[];
  value: (lanes: Lanes) => string;
}

const LANE_CARDS: LaneCard[] = [
  {
    id: "supervisor",
    title: "Supervisor",
    tier: "Reasoning / Pro",
    hint: "Strong reasoning model to draft Contracts & relay verdicts (e.g. Opus, GPT-5.4, Pro)",
    lanes: ["supervisor"],
    value: (l) => l.supervisor,
  },
  {
    id: "lead",
    title: "Lead",
    tier: "Reasoning / Pro",
    hint: "Strong planning model to split directives into Tasks & Contracts and drive them to verdict (e.g. Opus, GPT-5.4, Pro)",
    lanes: ["lead"],
    value: (l) => l.lead,
  },
  {
    id: "worker",
    title: "Default Worker",
    tier: "Coding Workhorse",
    hint: "Coding model for multi-attempt implementation & Gate runs (e.g. GLM-5.3, Sonnet, Codex)",
    lanes: ["worker"],
    value: (l) => l.worker,
  },
  {
    id: "watch-retro",
    title: "Watch & Retro",
    tier: "Flash / Fast",
    hint: "Fast, wide-context model for 5-question risk scoring & ledger retro (e.g. Flash, GLM-5.3)",
    lanes: ["watch", "retro"],
    value: (l) => (l.watch === l.retro ? l.watch : `${l.watch} · ${l.retro}`),
  },
  {
    id: "fresh-eyes",
    title: "Fresh-eyes",
    tier: "Reviewer · ≠ Worker",
    hint: "Second-opinion model (Flash-High / Sonnet) from a different family than Worker, or \"eye.json\"",
    lanes: ["freshEyes"],
    value: (l) => l.freshEyes,
  },
];

/** The live picker: provider buttons from the daemon, discovered models + editable input, preview before save. */
function LaneModalBody({ theme, view, card, onSave, onClose, busy }: { theme: PluginTheme; view: FactoryView; card: LaneCard; onSave: (value: string) => void; onClose: () => void; busy: boolean }) {
  const current = card.value(view.lanes);
  const slash = current.indexOf("/");
  const [provider, setProvider] = useState(current === "eye.json" ? "eye.json" : slash === -1 ? "" : current.slice(0, slash));
  const [model, setModel] = useState(slash === -1 ? "" : current.slice(slash + 1));
  const available = view.providers.filter((entry) => entry.available);
  const activeModels = available.find((entry) => entry.provider === provider)?.models ?? null;
  const allowEyeJson = card.id === "fresh-eyes";
  const value = provider === "eye.json" ? "eye.json" : provider === "" || model.trim() === "" ? "" : `${provider}/${model.trim()}`;
  return (
    <View style={{ gap: SPACING[3] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
        <Pill theme={theme} label={`Recommended: ${card.tier}`} tone="accent" lit />
      </View>
      <Text style={text(theme, "meta")}>{card.hint}</Text>
      <Text style={text(theme, "label")}>PROVIDER</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {available.map((entry) => (
          <Btn key={entry.provider} theme={theme} small label={entry.provider} tone={provider === entry.provider ? "accent" : "foregroundMuted"} onPress={() => setProvider(entry.provider)} />
        ))}
        {allowEyeJson ? (
          <Btn theme={theme} small label="eye.json (HTTP)" tone={provider === "eye.json" ? "accent" : "foregroundMuted"} onPress={() => setProvider("eye.json")} />
        ) : null}
        {available.length === 0 ? <Text style={text(theme, "label", "statusWarning")}>no available providers — the daemon half is unreadable</Text> : null}
      </View>
      {provider !== "eye.json" ? (
        <View style={{ gap: SPACING[2] }}>
          <Text style={text(theme, "label")}>MODEL</Text>
          {activeModels !== null && activeModels.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
              {activeModels.slice(0, 16).map((m) => (
                <Btn key={m.id} theme={theme} small label={m.label ?? m.id} tone={model === m.id ? "accent" : "foregroundMuted"} onPress={() => setModel(m.id)} />
              ))}
            </View>
          ) : null}
          <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.lg, backgroundColor: theme.colors.surface1 }}>
            <TextInput value={model} onChangeText={setModel} placeholder="e.g. zai/glm-5.3" placeholderTextColor={theme.colors.foregroundMuted} style={{ paddingHorizontal: SPACING[3], paddingVertical: SPACING[2], color: theme.colors.foreground, fontSize: 13 }} />
          </View>
        </View>
      ) : null}
      <Text style={text(theme, "code")}>{value === "" ? "provider/model — pick both" : value}</Text>
      <View style={{ flexDirection: "row", gap: SPACING[2] }}>
        <Btn theme={theme} label="Save lane" disabled={value === "" || busy} onPress={() => onSave(value)} />
        <Btn theme={theme} label="Close" tone="foregroundMuted" onPress={onClose} />
      </View>
    </View>
  );
}

function SeatNode({ theme, title, subtitle, pills }: { theme: PluginTheme; title: string; subtitle: string; pills: { label: string; tone?: Colour; lit?: boolean }[] }) {
  return (
    <Card theme={theme} gap={SPACING[1]}>
      <Text style={text(theme, "rowTitle")}>{title}</Text>
      <Text style={text(theme, "label")} numberOfLines={1}>
        {subtitle}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
        {pills.map((pill) => (
          <Pill key={pill.label} theme={theme} label={pill.label} tone={pill.tone ?? "foregroundMuted"} lit={pill.lit} />
        ))}
      </View>
    </Card>
  );
}

/** The orthogonal rail between graph levels — a plain vertical line. */
function Rail({ theme, height = SPACING[3] }: { theme: PluginTheme; height?: number }) {
  return <View style={{ width: 2, height, backgroundColor: theme.colors.border, marginLeft: SPACING[4] }} />;
}

function AgentCard({ theme, agent, actions }: { theme: PluginTheme; agent: AgentView; actions: SeatsActions }) {
  return (
    <Card theme={theme} gap={SPACING[1]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap" }}>
        <Text style={text(theme, "rowTitle")}>{agent.title ?? agent.id.slice(0, 12)}</Text>
        <View style={{ flex: 1 }} />
        <Btn theme={theme} label="Open Session" small onPress={() => actions.openAgent(agent.id)} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
        <Pill theme={theme} label={agent.status} tone={agent.status === "error" ? "statusDanger" : agent.status === "running" ? "accent" : "foregroundMuted"} lit={agent.status === "running"} />
        <Pill theme={theme} label={agent.provider} />
        {agent.model !== null ? <Pill theme={theme} label={agent.model} /> : null}
        {agent.task !== null ? <Pill theme={theme} label={`task ${agent.task}`} tone="accent" lit /> : null}
        {agent.seqEnd !== null ? <Pill theme={theme} label={`seqEnd ${agent.seqEnd}`} /> : null}
        {agent.requiresAttention === true ? <Pill theme={theme} label="attention" tone="statusWarning" lit /> : null}
      </View>
    </Card>
  );
}

export function SeatsPane({ theme, view, actions, modelSyncNote }: { theme: PluginTheme; view: FactoryView; actions: SeatsActions; modelSyncNote: string | null }) {
  const [editing, setEditing] = useState<LaneCard | null>(null);
  const workers = view.agents.filter((agent) => agent.id !== view.supervisor?.id && agent.id !== view.lead?.id);
  const save = (card: LaneCard, value: string): void => {
    for (const lane of card.lanes) actions.setLane(lane, value);
    setEditing(null);
  };
  return (
    <View style={{ gap: SPACING[4] }}>
      <View style={{ gap: SPACING[2] }}>
        <Text style={text(theme, "section")}>Lane Switcher</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2], alignItems: "stretch" }}>
          {LANE_CARDS.map((card) => (
            <Card key={card.id} theme={theme} gap={SPACING[1]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                <Text style={text(theme, "rowTitle")}>{card.title}</Text>
                <Pill theme={theme} label={card.tier} tone="accent" lit />
              </View>
              <Text style={text(theme, "code")} numberOfLines={1}>
                {card.value(view.lanes)}
              </Text>
              <Text style={text(theme, "label")} numberOfLines={3}>
                {card.hint}
              </Text>
              <Btn theme={theme} small label="Change" disabled={actions.busy} onPress={() => setEditing(card)} />
            </Card>
          ))}
        </View>
        {modelSyncNote !== null ? <Text style={text(theme, "label")}>{modelSyncNote}</Text> : null}
      </View>

      <View style={{ gap: SPACING[2] }}>
        <Text style={text(theme, "section")}>Seat Graph</Text>
        <SeatNode theme={theme} title="Owner" subtitle="you — the only seat that accepts and ratifies" pills={[{ label: `$${view.kpis.totalCostUsd.toFixed(2)} metered` }]} />
        <Rail theme={theme} />
        {view.supervisor !== null ? (
          <View style={{ gap: SPACING[2] }}>
            <AgentCard theme={theme} agent={view.supervisor} actions={actions} />
            <Btn theme={theme} small label="Revoke Supervisor" tone="statusDanger" disabled={actions.busy} onPress={actions.revokeSupervisor} />
          </View>
        ) : (
          <SeatNode theme={theme} title="Supervisor — vacant" subtitle="Open Supervisor in the header creates the seat" pills={[{ label: "seat=supervisor", tone: "statusWarning", lit: true }]} />
        )}
        <Rail theme={theme} />
        {view.lead !== null ? (
          <View style={{ gap: SPACING[2] }}>
            <AgentCard theme={theme} agent={view.lead} actions={actions} />
            <Btn theme={theme} small label="Rotate Lead" tone="statusDanger" disabled={actions.busy} onPress={actions.rotateLead} />
          </View>
        ) : (
          <SeatNode theme={theme} title="Lead — vacant" subtitle="Open Lead in the header seats the model-backed Lead at the project root" pills={[{ label: "seat=lead", tone: "statusWarning", lit: true }, { label: "lanes.lead" }]} />
        )}
        <Rail theme={theme} />
        {workers.length === 0 ? (
          <SeatNode theme={theme} title="Working Agents — none live" subtitle="spawned agents appear here as the ledger names them" pills={[]} />
        ) : (
          <View style={{ gap: SPACING[2] }}>
            {workers.map((agent) => (
              <AgentCard key={agent.id} theme={theme} agent={agent} actions={actions} />
            ))}
          </View>
        )}
      </View>

      <Modal open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))} title={editing === null ? "" : `${editing.title} lane`} icon={undefined}>
        <Modal.Content>
          {editing === null ? null : <LaneModalBody theme={theme} view={view} card={editing} busy={actions.busy} onSave={(value) => save(editing, value)} onClose={() => setEditing(null)} />}
        </Modal.Content>
      </Modal>
    </View>
  );
}
