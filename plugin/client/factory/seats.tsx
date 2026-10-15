/**
 * Tab 2 — Seats & Models (ADR 0009 §2): four Lane Cards (Supervisor, Default
 * Worker, Watch & Retro, Fresh-eyes) opening the live provider/model picker
 * modal, and below them the orthogonal Seat Graph — Owner ⇄ Supervisor ⇄
 * Lead (Rider) ⇄ Working Agents — with live Timeline Oracle seqEnd, Open
 * Session (navigation.openAgent), and Revoke Supervisor.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { AgentView, FactoryView, LaneName, Lanes } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

/** The Seats tab's whole action surface — the Shell owns the RPC calls. */
export interface SeatsActions {
  setLane(lane: LaneName, value: string): void;
  revokeSupervisor(): void;
  openAgent(agentId: string): void;
  busy: boolean;
}

/** Which lanes a card covers — "Watch & Retro" writes both lanes, one value. */
interface LaneCard {
  id: string;
  title: string;
  hint: string;
  lanes: LaneName[];
  value: (lanes: Lanes) => string;
}

const LANE_CARDS: LaneCard[] = [
  { id: "supervisor", title: "Supervisor", hint: "the delegated Owner seat the bridge spawns", lanes: ["supervisor"], value: (l) => l.supervisor },
  { id: "worker", title: "Default Worker", hint: "factory run's lane when --provider is omitted", lanes: ["worker"], value: (l) => l.worker },
  { id: "watch-retro", title: "Watch & Retro", hint: "the record-only passes' shared lane", lanes: ["watch", "retro"], value: (l) => (l.watch === l.retro ? l.watch : `${l.watch} · ${l.retro}`) },
  { id: "fresh-eyes", title: "Fresh-eyes", hint: "the advisory pass — or \"eye.json\" for the legacy direct API", lanes: ["freshEyes"], value: (l) => l.freshEyes },
];

const LANE_TITLES: Record<LaneName, string> = { supervisor: "Supervisor", worker: "Default Worker", watch: "Watch", retro: "Retro", freshEyes: "Fresh-eyes" };

/** The live picker: provider buttons from the daemon, model editable, preview before save. */
function LaneModalBody({ theme, view, card, onSave, onClose, busy }: { theme: PluginTheme; view: FactoryView; card: LaneCard; onSave: (value: string) => void; onClose: () => void; busy: boolean }) {
  const current = card.value(view.lanes);
  const slash = current.indexOf("/");
  const [provider, setProvider] = useState(slash === -1 ? "" : current.slice(0, slash));
  const [model, setModel] = useState(slash === -1 ? (current === "eye.json" ? "" : current) : current.slice(slash + 1));
  const available = view.providers.filter((entry) => entry.available);
  const value = provider === "" || model.trim() === "" ? "" : `${provider}/${model.trim()}`;
  return (
    <View style={{ gap: SPACING[3] }}>
      <Text style={text(theme, "detailTitle")}>{card.title} lane</Text>
      <Text style={text(theme, "meta")}>{card.hint}</Text>
      <Text style={text(theme, "label")}>PROVIDER</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {available.map((entry) => (
          <Btn key={entry.provider} theme={theme} small label={entry.provider} tone={provider === entry.provider ? "accent" : "foregroundMuted"} onPress={() => setProvider(entry.provider)} />
        ))}
        {available.length === 0 ? <Text style={text(theme, "label", "statusWarning")}>no available providers — the daemon half is unreadable</Text> : null}
      </View>
      <Text style={text(theme, "label")}>MODEL</Text>
      <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.lg, backgroundColor: theme.colors.surface1 }}>
        <TextInput value={model} onChangeText={setModel} placeholder="e.g. zai/glm-5.3" placeholderTextColor={theme.colors.foregroundMuted} style={{ paddingHorizontal: SPACING[3], paddingVertical: SPACING[2], color: theme.colors.foreground, fontSize: 13 }} />
      </View>
      <Text style={text(theme, "code")}>{value === "" ? "provider/model — pick both" : value}</Text>
      <View style={{ flexDirection: "row", gap: SPACING[2] }}>
        <Btn theme={theme} label="Save lane" disabled={value === "" || busy} onPress={() => onSave(value)} />
        <Btn theme={theme} label="Close" tone="foregroundMuted" onPress={onClose} />
      </View>
    </View>
  );
}

function SeatNode({ theme, title, subtitle, pills, actions }: { theme: PluginTheme; title: string; subtitle: string; pills: { label: string; tone?: Colour; lit?: boolean }[]; actions?: () => unknown }) {
  void actions;
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
  const workers = view.agents.filter((agent) => agent.id !== view.supervisor?.id);
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
              <Text style={text(theme, "rowTitle")}>{card.title}</Text>
              <Text style={text(theme, "code")} numberOfLines={1}>
                {card.value(view.lanes)}
              </Text>
              <Text style={text(theme, "label")} numberOfLines={2}>
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
        <SeatNode theme={theme} title="Owner" subtitle="you — the only seat that accepts and ratifies" pills={[{ label: "Total Cost", lit: false }].length === 0 ? [] : [{ label: `$${view.kpis.totalCostUsd.toFixed(2)} metered` }]} />
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
        <SeatNode theme={theme} title="Lead (Rider)" subtitle="the driver inside factory run — watches to verdict, one re-poke, the named end" pills={[{ label: "driver" }, { label: "ledger-only" }]} />
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

      {editing !== null ? (
        <View style={{ marginTop: SPACING[2], borderWidth: 1, borderColor: tint(theme.colors.accent, "55"), backgroundColor: theme.colors.surface2, borderRadius: RADIUS.lg, padding: SPACING[3] }}>
          <LaneModalBody theme={theme} view={view} card={editing} busy={actions.busy} onSave={(value) => save(editing, value)} onClose={() => setEditing(null)} />
        </View>
      ) : null}
    </View>
  );
}

export { LANE_TITLES };
