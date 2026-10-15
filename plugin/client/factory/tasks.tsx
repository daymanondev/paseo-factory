/**
 * Tab 1 — Tasks, the Verification Line (ADR 0009 §2): workspace-grouped
 * task cards, status filter chips, the Attempt Ladder (#1 → #2 → #3) with
 * ↻ Respawned badges, Evidence Pills (Gate / Choke / Eye / Watch / Cost),
 * the inline Accept #n button on green attempts, and the Detail Modal's
 * opener.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { FactoryView, TaskStatus, TaskView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { RADIUS, SPACING, text, tint } from "../kit/theme.ts";

type Filter = "all" | TaskStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "needs-human", label: "Needs Human" },
  { id: "ready-to-accept", label: "Ready to Accept" },
  { id: "accepted", label: "Accepted" },
];

/** The Tasks tab's whole action surface — the Shell owns the RPC calls. */
export interface TasksActions {
  accept(task: string, attempt: number): void;
  openDetail(task: string): void;
  busy: boolean;
}

function statusPill(theme: PluginTheme, status: TaskStatus, reason: string | null): { label: string; tone: ReturnType<typeof statusTone>; lit: boolean } {
  const tone = statusTone(status);
  const label = status === "needs-human" && reason !== null ? `needs human · ${reason}` : status;
  return { label, tone, lit: status === "needs-human" || status === "ready-to-accept" };
}

function statusTone(status: TaskStatus): "statusWarning" | "accent" | "statusSuccess" | "foregroundMuted" | "statusDanger" {
  switch (status) {
    case "needs-human":
      return "statusWarning";
    case "running":
      return "accent";
    case "ready-to-accept":
      return "statusSuccess";
    case "accepted":
      return "foregroundMuted";
    default:
      return "statusDanger";
  }
}

/** One rung of the ladder — #n, verdict colour, the ↻ badge when respawned. */
function LadderRung({ theme, n, verdict, open, respawned }: { theme: PluginTheme; n: number; verdict: "red" | "green" | null; open: boolean; respawned: boolean }) {
  const colour = verdict === "green" ? theme.colors.statusSuccess : verdict === "red" ? theme.colors.statusDanger : open ? theme.colors.accent : theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ paddingHorizontal: SPACING[1.5], paddingVertical: 2, borderRadius: RADIUS.md, borderWidth: 1, borderColor: tint(colour, "77"), backgroundColor: tint(colour, "14") }}>
        <Text style={{ ...text(theme, "label"), fontWeight: "600", color: colour, fontVariant: ["tabular-nums"] }}>#{n}</Text>
      </View>
      {respawned ? (
        <View style={{ paddingHorizontal: SPACING[1], paddingVertical: 1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: theme.colors.border }}>
          <Text style={text(theme, "label", "foregroundMuted")}>↻ Respawned</Text>
        </View>
      ) : null}
    </View>
  );
}

function costLabel(task: TaskView): string {
  switch (task.costState) {
    case "metered":
      return `$${(task.costUsd ?? 0).toFixed(2)}`;
    case "subscription":
      return "$0 marginal";
    case "absent":
      return "cost —";
    default:
      return "unmetered";
  }
}

/** One task card — the verification line's whole row. */
function TaskCard({ theme, task, actions }: { theme: PluginTheme; task: TaskView; actions: TasksActions }) {
  const green = task.attempts.findLast((attempt) => attempt.verdict === "green" && !attempt.open);
  const lastAttempt = task.attempts.at(-1);
  const lastEye = task.attempts.findLast((a) => a.eye !== null)?.eye ?? null;
  const lastWatch = task.attempts.findLast((a) => a.watch !== null)?.watch ?? null;
  const pills = statusPill(theme, task.status, task.needsHumanReason);
  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={text(theme, "section")}>{task.task}</Text>
        <Pill theme={theme} label={pills.label} tone={pills.tone} lit={pills.lit} />
        <View style={{ flex: 1 }} />
        {task.status === "ready-to-accept" && green !== undefined ? (
          <Btn theme={theme} label={`Accept #${green.n}`} tone="statusSuccess" small disabled={actions.busy} onPress={() => actions.accept(task.task, green!.n)} />
        ) : null}
        <Btn theme={theme} label="Detail" small onPress={() => actions.openDetail(task.task)} />
      </View>
      {task.description !== null ? <Text style={text(theme, "meta")} numberOfLines={2}>{task.description}</Text> : null}

      {/* The Attempt Ladder */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
        {task.attempts.length === 0 ? <Text style={text(theme, "label")}>no attempts yet</Text> : null}
        {task.attempts.map((attempt, index) => (
          <View key={attempt.n} style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
            {index > 0 ? <Text style={text(theme, "label", "foregroundMuted")}>→</Text> : null}
            <LadderRung theme={theme} n={attempt.n} verdict={attempt.verdict} open={attempt.open} respawned={attempt.respawned} />
          </View>
        ))}
      </View>

      {/* Evidence Pills */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1] }}>
        {lastAttempt !== undefined ? (
          <Pill theme={theme} label={lastAttempt.verdict === "green" ? "Gate green" : lastAttempt.verdict === "red" ? "Gate red" : "Gate —"} tone={lastAttempt.verdict === "green" ? "statusSuccess" : "statusDanger"} lit={lastAttempt.verdict !== null} />
        ) : null}
        <Pill theme={theme} label={`Choke ${task.choke.allowed}/${task.choke.denied}/${task.choke.blocked}`} tone="foregroundMuted" />
        {lastEye !== null ? (
          <Pill theme={theme} label={`Eye ${lastEye.outcome.toUpperCase()}`} tone={lastEye.outcome === "concern" ? "statusWarning" : "statusSuccess"} lit />
        ) : null}
        {lastWatch !== null ? (
          <Pill theme={theme} label={`Watch ${lastWatch.maxProbability === null ? "—" : lastWatch.maxProbability.toFixed(2)}`} tone={(lastWatch.maxProbability ?? 0) >= 0.5 ? "statusWarning" : "foregroundMuted"} lit={(lastWatch.maxProbability ?? 0) >= 0.5} />
        ) : null}
        <Pill theme={theme} label={`Cost ${costLabel(task)}`} tone="foregroundMuted" />
        {task.lane !== null ? <Pill theme={theme} label={task.lane} tone="foregroundMuted" /> : null}
      </View>
    </Card>
  );
}

export function TasksPane({ theme, view, dir, actions }: { theme: PluginTheme; view: FactoryView; dir?: string; actions: TasksActions }) {
  const [filter, setFilter] = useState<Filter>("all");
  const sameTree = (workspace: string): boolean => {
    if (dir === undefined) return true;
    const a = workspace.replace(/\/+$/, "");
    const b = dir.replace(/\/+$/, "");
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  const scoped = dir === undefined ? view.tasks : view.tasks.filter((task) => sameTree(task.workspace));
  const counts = countsOf(scoped);
  const shown = filter === "all" ? scoped : scoped.filter((task) => task.status === filter);

  // Group by workspace, first-appearance order.
  const groups: { workspace: string; tasks: TaskView[] }[] = [];
  for (const task of shown) {
    let group = groups.find((entry) => entry.workspace === task.workspace);
    if (group === undefined) {
      group = { workspace: task.workspace, tasks: [] };
      groups.push(group);
    }
    group.tasks.push(task);
  }

  return (
    <View style={{ gap: SPACING[3] }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {FILTERS.map((entry) => (
          <Chip
            key={entry.id}
            theme={theme}
            label={entry.label}
            active={filter === entry.id}
            count={entry.id === "all" ? scoped.length : counts.get(entry.id) ?? 0}
            onPress={() => setFilter(entry.id)}
          />
        ))}
      </View>
      {view.tasks.length > 0 && dir !== undefined && scoped.length === 0 ? (
        <Text style={text(theme, "meta")}>No factory tasks in this workspace — the Global screen shows every workspace.</Text>
      ) : null}
      {scoped.length === 0 && dir === undefined ? <Text style={text(theme, "meta")}>No contracts yet — set one with `factory contract`.</Text> : null}
      {groups.map((group) => (
        <View key={group.workspace} style={{ gap: SPACING[2] }}>
          <Text style={text(theme, "label")} numberOfLines={1}>
            {group.workspace}
          </Text>
          {group.tasks.map((task) => (
            <TaskCard key={task.task} theme={theme} task={task} actions={actions} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** One count per status — the chips' numbers come from the same fold the cards read. */
function countsOf(tasks: readonly TaskView[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return counts;
}
