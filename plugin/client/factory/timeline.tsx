/**
 * Tab 3 — Timeline & Retro (ADR 0009 §2): the horizontal Swimlane Timeline
 * (30m | 2h | 6h | 24h) of Task Attempts, then the Retro & Ledger section —
 * a Run Retro action, the rendered Proposals (R1..Rn), and the live ledger
 * event stream.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { FactoryView, TaskView } from "../../shared/view.ts";
import { Btn, Card, Chip } from "../kit/pill.tsx";
import { RADIUS, SPACING, text, tint } from "../kit/theme.ts";

/** The Timeline tab's whole action surface — the Shell owns the RPC calls. */
export interface TimelineActions {
  runRetro(): void;
  busy: boolean;
}

const WINDOWS: { id: string; label: string; ms: number }[] = [
  { id: "30m", label: "30m", ms: 30 * 60_000 },
  { id: "2h", label: "2h", ms: 2 * 3_600_000 },
  { id: "6h", label: "6h", ms: 6 * 3_600_000 },
  { id: "24h", label: "24h", ms: 24 * 3_600_000 },
];

/** One attempt's segment position in [0,1] over the window — clamped, honest at the edges. */
function positionOf(ts: string | null, start: number, end: number): number | null {
  if (ts === null) return null;
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return null;
  if (at <= start) return 0;
  if (at >= end) return 1;
  return (at - start) / (end - start);
}

/** One swimlane: the task's attempts as positioned ticks along the window. */
function Swimlane({ theme, task, start, end }: { theme: PluginTheme; task: TaskView; start: number; end: number }) {
  const marks = task.attempts.map((attempt) => {
    const left = positionOf(claimAnchor(attempt.claimedAt, attempt.verdictAt), start, end);
    return { attempt, left };
  });
  const visible = marks.some((mark) => mark.left !== null);
  return (
    <View style={{ gap: SPACING[1] }}>
      <Text style={text(theme, "label")} numberOfLines={1}>
        {task.task}
      </Text>
      <View style={{ height: 22, borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.md, backgroundColor: theme.colors.surface1, flexDirection: "row", overflow: "hidden" }}>
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
                left: `${Math.round(left * 100)}%`,
                top: 3,
                bottom: 3,
                width: 10,
                borderRadius: 3,
                backgroundColor: attempt.verdict === "green" ? theme.colors.statusSuccess : attempt.verdict === "red" ? theme.colors.statusDanger : theme.colors.accent,
                opacity: attempt.open ? 0.6 : 1,
              }}
            />
          ),
        )}
      </View>
      {!visible ? <Text style={text(theme, "label")}>nothing in this window</Text> : null}
    </View>
  );
}

/** The segment's anchor: the verdict when it landed, else the claim. */
function claimAnchor(claimedAt: string | null, verdictAt: string | null): string | null {
  return verdictAt ?? claimedAt;
}

export function TimelinePane({ theme, view, now, actions, retroNote }: { theme: PluginTheme; view: FactoryView; now: number; actions: TimelineActions; retroNote: string | null }) {
  const [windowId, setWindowId] = useState("2h");
  const window = WINDOWS.find((entry) => entry.id === windowId) ?? WINDOWS[1]!;
  const end = now;
  const start = now - window.ms;
  return (
    <View style={{ gap: SPACING[4] }}>
      <View style={{ gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap" }}>
          <Text style={text(theme, "section")}>Swimlane Timeline</Text>
          <View style={{ flex: 1 }} />
          {WINDOWS.map((entry) => (
            <Chip key={entry.id} theme={theme} label={entry.label} active={windowId === entry.id} count={0} onPress={() => setWindowId(entry.id)} />
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ gap: SPACING[2], minWidth: 480, paddingRight: SPACING[4] }}>
            {view.tasks.length === 0 ? <Text style={text(theme, "meta")}>No tasks yet.</Text> : null}
            {view.tasks.map((task) => (
              <Swimlane key={task.task} theme={theme} task={task} start={start} end={end} />
            ))}
          </View>
        </ScrollView>
      </View>

      <View style={{ gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap" }}>
          <Text style={text(theme, "section")}>Retro</Text>
          <View style={{ flex: 1 }} />
          <Btn theme={theme} label="Run Retro" small disabled={actions.busy} onPress={actions.runRetro} />
        </View>
        {retroNote !== null ? <Text style={text(theme, "label")}>{retroNote}</Text> : null}
        {view.retro.length === 0 ? <Text style={text(theme, "meta")}>No retro has run yet — one per UTC day, proposals are advice until ratified.</Text> : null}
        {view.retro
          .slice()
          .reverse()
          .map((retro) => (
            <Card key={retro.seq} theme={theme} gap={SPACING[1]}>
              <View style={{ flexDirection: "row", gap: SPACING[2], flexWrap: "wrap", alignItems: "center" }}>
                <Text style={text(theme, "rowTitle")}>Retro {retro.day}</Text>
                <Text style={text(theme, "label")}>
                  {retro.outcome}
                  {retro.proposalCount !== null ? ` · ${retro.proposalCount} proposals · ${retro.model}` : ""}
                </Text>
              </View>
              {retro.proposals.map((proposal) => (
                <View key={proposal.id} style={{ paddingLeft: SPACING[2], borderLeftWidth: 2, borderLeftColor: tint(theme.colors.accent, "55"), gap: 1 }}>
                  <Text style={text(theme, "rowTitle")}>
                    R{proposal.id} — {proposal.cls}
                  </Text>
                  <Text style={text(theme, "meta")}>{proposal.text}</Text>
                </View>
              ))}
            </Card>
          ))}
      </View>

      <View style={{ gap: SPACING[2] }}>
        <Text style={text(theme, "section")}>Ledger stream</Text>
        <Card theme={theme} gap={SPACING[1]}>
          {view.ledger.length === 0 ? <Text style={text(theme, "meta")}>The ledger is empty.</Text> : null}
          {view.ledger.slice(0, 40).map((line) => (
            <View key={line.seq} style={{ flexDirection: "row", gap: SPACING[2] }}>
              <Text style={{ ...text(theme, "code"), opacity: 0.7, fontVariant: ["tabular-nums"] }}>{line.seq}</Text>
              <Text style={text(theme, "code")} numberOfLines={1}>
                {line.task === null ? "" : `${line.task} `}
                {line.line}
              </Text>
            </View>
          ))}
        </Card>
      </View>
    </View>
  );
}
