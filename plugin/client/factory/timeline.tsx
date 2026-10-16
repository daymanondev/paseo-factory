/**
 * Tab 3 — Timeline & Retro (ADR 0009 §2): the horizontal Swimlane Timeline
 * (30m | 2h | 6h | 24h) of Task Attempts and Agents, then the Retro & Ledger
 * section — a Run Retro action, the rendered Proposals (R1..Rn), and the
 * searchable/filterable ledger event stream.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { AgentView, FactoryView, TaskView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_SM, RADIUS, SPACING, text, tint } from "../kit/theme.ts";

/** The Timeline tab's whole action surface — the Shell owns the RPC calls. */
export interface TimelineActions {
  runRetro(): void;
  /** Ratify via Supervisor (v0.0.14, ADR 0010 §6): dispatch one Retro proposal to the Project's Supervisor. */
  ratify(day: string, proposalId: number): void;
  busy: boolean;
}

const WINDOWS: { id: string; label: string; ms: number }[] = [
  { id: "30m", label: "30m", ms: 30 * 60_000 },
  { id: "2h", label: "2h", ms: 2 * 3_600_000 },
  { id: "6h", label: "6h", ms: 6 * 3_600_000 },
  { id: "24h", label: "24h", ms: 24 * 3_600_000 },
];

/** One attempt's segment position in [0,1] over [start, end] — null when outside the window. */
function positionOf(ts: string | null, start: number, end: number): number | null {
  if (ts === null) return null;
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return null;
  if (at < start || at > end) return null;
  return (at - start) / (end - start);
}

/** One swimlane: the task's attempts as positioned ticks along the window. */
function Swimlane({ theme, task, start, end }: { theme: PluginTheme; task: TaskView; start: number; end: number }) {
  const marks = task.attempts.map((attempt) => {
    const left = attempt.open ? 0.96 : positionOf(claimAnchor(attempt.claimedAt, attempt.verdictAt), start, end);
    return { attempt, left };
  });
  const visible = marks.some((mark) => mark.left !== null);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2.5] }}>
      <View style={{ width: 120 }}>
        <Text style={text(theme, "code")} numberOfLines={1}>
          {task.task}
        </Text>
      </View>
      <View
        style={{
          flex: 1,
          minWidth: 280,
          height: 22,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: RADIUS.md,
          backgroundColor: theme.colors.surface0,
          flexDirection: "row",
          overflow: "hidden",
        }}
      >
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: SPACING[2] }}>
          <View style={{ height: 2, backgroundColor: theme.colors.border }} />
        </View>
        {marks.map(({ attempt, left }) =>
          left === null ? null : (
            <View
              key={attempt.n}
              accessibilityLabel={`${task.task} attempt ${attempt.n} ${attempt.verdict ?? "open"}`}
              style={{
                position: "absolute",
                left: `${Math.min(96, Math.round(left * 100))}%`,
                top: 3,
                bottom: 3,
                width: 10,
                borderRadius: 3,
                backgroundColor:
                  attempt.verdict === "green"
                    ? theme.colors.statusSuccess
                    : attempt.verdict === "red"
                      ? theme.colors.statusDanger
                      : theme.colors.accent,
                opacity: attempt.open ? 0.6 : 1,
              }}
            />
          ),
        )}
      </View>
      <View style={{ width: 90 }}>
        <Text style={text(theme, "badge")} numberOfLines={1}>
          {visible ? `${task.attempts.length} att` : "outside window"}
        </Text>
      </View>
    </View>
  );
}

/** One agent swimlane: live seat/worker bar along the timeline window. */
function AgentSwimlane({ theme, agent }: { theme: PluginTheme; agent: AgentView }) {
  const label = `${agent.seat === "supervisor" ? "Supervisor" : agent.seat === "lead" ? "Lead" : (agent.title ?? agent.id.slice(0, 8))}${agent.task !== null ? ` (${agent.task})` : ""}`;
  const colour = agent.status === "error" ? theme.colors.statusDanger : agent.status === "running" ? theme.colors.accent : theme.colors.statusSuccess;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2.5] }}>
      <View style={{ width: 120 }}>
        <Text style={text(theme, "label")} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View
        style={{
          flex: 1,
          minWidth: 280,
          height: 16,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: RADIUS.md,
          backgroundColor: theme.colors.surface0,
          justifyContent: "center",
          paddingHorizontal: SPACING[1],
        }}
      >
        <View style={{ height: 6, borderRadius: 3, backgroundColor: colour, opacity: agent.status === "running" ? 0.9 : 0.45 }} />
      </View>
      <View style={{ width: 90, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Pill theme={theme} label={agent.status} tone={agent.status === "running" ? "accent" : "foregroundMuted"} lit={agent.status === "running"} />
      </View>
    </View>
  );
}

/** The segment's anchor: the verdict when it landed, else the claim. */
function claimAnchor(claimedAt: string | null, verdictAt: string | null): string | null {
  return verdictAt ?? claimedAt;
}

export function TimelinePane({
  theme,
  view,
  now,
  actions,
  retroNote,
}: {
  theme: PluginTheme;
  view: FactoryView;
  now: number;
  actions: TimelineActions;
  retroNote: string | null;
}) {
  const [windowId, setWindowId] = useState("2h");
  const [query, setQuery] = useState("");
  const window = WINDOWS.find((entry) => entry.id === windowId) ?? WINDOWS[1]!;
  const end = now;
  const start = now - window.ms;
  const q = query.trim().toLowerCase();
  const filteredLedger =
    q === ""
      ? view.ledger
      : view.ledger.filter(
          (line) =>
            (line.task !== null && line.task.toLowerCase().includes(q)) ||
            line.event.toLowerCase().includes(q) ||
            line.line.toLowerCase().includes(q),
        );
  return (
    <View style={{ gap: SPACING[4] }}>
      {/* Swimlane Timeline */}
      <Card theme={theme} gap={SPACING[2.5]}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2], flexWrap: "wrap" }}>
          <View style={{ gap: 2 }}>
            <Text style={text(theme, "section")}>Swimlane Timeline</Text>
            <Text style={text(theme, "label")}>Live agents and task attempts across the selected window.</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
            {WINDOWS.map((entry) => (
              <Chip key={entry.id} theme={theme} label={entry.label} active={windowId === entry.id} count={0} onPress={() => setWindowId(entry.id)} />
            ))}
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ gap: SPACING[2], minWidth: 520, paddingRight: SPACING[2] }}>
            {view.tasks.length === 0 && view.agents.length === 0 ? <Text style={text(theme, "meta")}>No tasks or live agents yet.</Text> : null}
            {view.agents.map((agent) => (
              <AgentSwimlane key={agent.id} theme={theme} agent={agent} />
            ))}
            {view.tasks.map((task) => (
              <Swimlane key={task.task} theme={theme} task={task} start={start} end={end} />
            ))}
          </View>
        </ScrollView>
      </Card>

      {/* Retro Section */}
      <View style={{ gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2], flexWrap: "wrap" }}>
          <View style={{ gap: 2 }}>
            <Text style={text(theme, "section")}>Daily Retro & Proposals</Text>
            <Text style={text(theme, "label")}>One retrospective pass per UTC day — proposals remain advisory until ratified.</Text>
          </View>
          <Btn theme={theme} small icon="Sparkles" label="Run Retro" disabled={actions.busy} onPress={actions.runRetro} />
        </View>
        {retroNote !== null ? <Pill theme={theme} label={retroNote} tone="accent" lit /> : null}
        {view.retro.length === 0 ? (
          <Card theme={theme}>
            <Text style={text(theme, "meta")}>No retro has run yet.</Text>
          </Card>
        ) : null}
        {view.retro
          .slice()
          .reverse()
          .map((retro) => (
            <Card key={retro.seq} theme={theme} gap={SPACING[2]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACING[2], flexWrap: "wrap", alignItems: "center" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                  <Text style={text(theme, "rowTitle")}>Retro {retro.day}</Text>
                  <Pill theme={theme} label={retro.outcome} tone={retro.outcome === "written" ? "statusSuccess" : "statusWarning"} lit />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                  {retro.proposalCount !== null ? <Pill theme={theme} label={`${retro.proposalCount} proposals`} /> : null}
                  <Pill theme={theme} label={retro.model} mono />
                </View>
              </View>
              {retro.proposals.map((proposal) => (
                <View
                  key={proposal.id}
                  style={{
                    padding: SPACING[2.5],
                    borderRadius: RADIUS.md,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface0,
                    borderLeftWidth: 3,
                    borderLeftColor: theme.colors.accent,
                    gap: SPACING[1.5],
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                      <Pill theme={theme} label={`R${proposal.id}`} tone="accent" lit mono />
                      <Pill theme={theme} label={proposal.cls} mono />
                    </View>
                    <Btn
                      theme={theme}
                      small
                      icon="Check"
                      label="Ratify via Supervisor"
                      disabled={actions.busy || view.project === null}
                      onPress={() => actions.ratify(retro.day, proposal.id)}
                    />
                  </View>
                  <Text style={text(theme, "meta")}>{proposal.text}</Text>
                </View>
              ))}
            </Card>
          ))}
      </View>

      {/* Ledger Stream */}
      <View style={{ gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2], flexWrap: "wrap" }}>
          <Text style={text(theme, "section")}>Ledger Stream ({filteredLedger.length})</Text>
          <View
            style={{
              minWidth: 240,
              minHeight: CONTROL_SM,
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
            <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Filter by task, event, or text…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{ flex: 1, paddingVertical: 4, color: theme.colors.foreground, fontSize: 12 }}
            />
          </View>
        </View>
        <Card theme={theme} gap={SPACING[1]}>
          {filteredLedger.length === 0 ? (
            <Text style={text(theme, "meta")}>{view.ledger.length === 0 ? "The ledger is empty." : "No ledger lines match the filter."}</Text>
          ) : null}
          {filteredLedger.slice(0, 40).map((line, idx) => (
            <View
              key={line.seq}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: SPACING[2],
                paddingVertical: 3,
                borderTopWidth: idx === 0 ? 0 : 1,
                borderTopColor: tint(theme.colors.border, "66"),
              }}
            >
              <Text
                style={{
                  ...text(theme, "code"),
                  width: 36,
                  textAlign: "right",
                  color: theme.colors.foregroundMuted,
                  fontVariant: ["tabular-nums"],
                }}
              >
                #{line.seq}
              </Text>
              {line.task !== null ? <Pill theme={theme} label={line.task} tone="accent" lit mono /> : null}
              <Text style={{ ...text(theme, "code"), flex: 1 }} numberOfLines={1}>
                {line.line}
              </Text>
            </View>
          ))}
        </Card>
      </View>
    </View>
  );
}
