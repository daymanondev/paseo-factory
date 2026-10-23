/**
 * Tab 1 — Tasks, the 5-Column Kanban Verification Board (v0.0.35, ADR 0025,
 * amending ADR 0009 §2): horizontal 5-column Kanban board (`Queued`,
 * `In Progress`, `Needs Attention`, `Ready to Accept`, `Accepted`) with live
 * per-column Task count badges, a compact board toolbar with column filter
 * chips and `Total Cost` summary pill, compact Trello/Jira-style Kanban cards
 * displaying Task ID, Project pill (in `All projects` mode), Attempt rung
 * (`#1/3`..`#3/3`, `↻ Respawned`), Evidence Pills (`Gate`, `Choke`, `Eye`,
 * `Watch`, `Cost`), direct `Accept #n` CTA on `Ready to Accept` cards, and
 * click-to-open `TaskDetailModal`.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { FactoryView, TaskDetailView, TaskStatus, TaskView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { DOT, PILL_H, RADIUS, SPACING, hoveredOf, text, tint } from "../kit/theme.ts";
import {
  KANBAN_COLUMNS,
  groupTasksForKanban,
  kanbanColumnForStatus,
  projectNameForTask,
} from "./kanban.ts";
import type { KanbanColumnDef, KanbanColumnId, KanbanTaskStatus } from "./kanban.ts";

export {
  KANBAN_COLUMNS,
  groupTasksForKanban,
  kanbanColumnForStatus,
  projectNameForTask,
};
export type { KanbanColumnDef, KanbanColumnId, KanbanTaskStatus };

type BoardFilter = "all" | KanbanColumnId;

/** The Tasks tab's whole action surface — the Shell owns the RPC calls. */
export interface TasksActions {
  accept(task: string, attempt: number): void;
  openDetail(task: string): void;
  busy: boolean;
}

export type TaskDetailModalState = {
  task: string;
  loading: boolean;
  detail: TaskDetailView | null;
  error: string | null;
};

function statusPill(
  status: TaskStatus,
  reason: string | null,
): { label: string; tone: ReturnType<typeof statusTone>; lit: boolean } {
  const tone = statusTone(status);
  const label = status === "needs-human" && reason !== null ? `needs human · ${reason}` : status;
  return {
    label,
    tone,
    lit: status === "needs-human" || status === "ready-to-accept" || status === "running" || status === "red",
  };
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
    case "waiting":
      return "foregroundMuted";
    default:
      return "statusDanger";
  }
}

/** One rung of the Attempt Ladder — `#n/3`, verdict colour, and the `↻ Respawned` badge. */
function LadderRung({
  theme,
  n,
  verdict,
  open,
  respawned,
}: {
  theme: PluginTheme;
  n: number;
  verdict: "red" | "green" | null;
  open: boolean;
  respawned: boolean;
}) {
  const colour =
    verdict === "green"
      ? theme.colors.statusSuccess
      : verdict === "red"
        ? theme.colors.statusDanger
        : open
          ? theme.colors.accent
          : theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View
        style={{
          minHeight: PILL_H,
          paddingHorizontal: SPACING[2],
          paddingVertical: 2,
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: tint(colour, "77"),
          backgroundColor: tint(colour, "18"),
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        }}
      >
        <Text style={{ ...text(theme, "badge"), fontWeight: "600", color: colour, fontVariant: ["tabular-nums"] }}>
          #{n}/3 {verdict ?? (open ? "open" : "—")}
        </Text>
      </View>
      {respawned ? <Pill theme={theme} label="↻ Respawned" tone="foregroundMuted" /> : null}
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

/** Compact Trello/Jira-style Kanban card for a single Task inside a column. */
function KanbanCard({
  theme,
  task,
  showProjectPill,
  projectLabel,
  actions,
}: {
  theme: PluginTheme;
  task: TaskView;
  showProjectPill: boolean;
  projectLabel: string;
  actions: TasksActions;
}) {
  const green = task.attempts.findLast((attempt) => attempt.verdict === "green" && !attempt.open);
  const lastAttempt = task.attempts.at(-1);
  const lastEye = task.attempts.findLast((a) => a.eye !== null)?.eye ?? null;
  const lastWatch = task.attempts.findLast((a) => a.watch !== null)?.watch ?? null;
  const pills = statusPill(task.status, task.needsHumanReason);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => actions.openDetail(task.task)}
      style={(state) => ({
        borderWidth: 1,
        borderColor: hoveredOf(state) ? theme.colors.foregroundMuted : theme.colors.border,
        backgroundColor: state.pressed ? theme.colors.surface2 : theme.colors.surface0,
        borderRadius: RADIUS.lg,
        padding: SPACING[2.5],
        gap: SPACING[2],
      })}
    >
      {/* Card Header Row: Task ID badge, Project pill (All projects mode), Attempt/status pills */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap", flexShrink: 1 }}>
          <Text style={text(theme, "rowTitle")}>#{task.task}</Text>
          {showProjectPill ? <Pill theme={theme} icon="FolderGit2" label={projectLabel} /> : null}
          {task.lane !== null ? <Pill theme={theme} label={task.lane} mono /> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1], flexWrap: "wrap" }}>
          {lastAttempt !== undefined ? (
            <Pill
              theme={theme}
              label={`Attempt #${lastAttempt.n}/3`}
              tone={
                lastAttempt.verdict === "green"
                  ? "statusSuccess"
                  : lastAttempt.verdict === "red"
                    ? "statusDanger"
                    : "accent"
              }
              lit={lastAttempt.open || lastAttempt.verdict !== null}
              mono
            />
          ) : null}
          <Pill theme={theme} label={pills.label} tone={pills.tone} lit={pills.lit} />
        </View>
      </View>

      {/* Card Body: Description & Needs-Human blocker banner */}
      {task.description !== null ? (
        <Text style={text(theme, "meta")} numberOfLines={3}>
          {task.description}
        </Text>
      ) : null}

      {task.needsHumanReason !== null ? (
        <View
          style={{
            paddingHorizontal: SPACING[2],
            paddingVertical: SPACING[1],
            borderRadius: RADIUS.md,
            borderWidth: 1,
            borderColor: tint(theme.colors.statusWarning, "66"),
            backgroundColor: tint(theme.colors.statusWarning, "14"),
          }}
        >
          <Text style={text(theme, "label", "statusWarning")}>Blocker: {task.needsHumanReason}</Text>
        </View>
      ) : null}

      {/* Attempt Ladder Rungs */}
      {task.attempts.length > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
          {task.attempts.map((attempt, index) => (
            <View key={attempt.n} style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
              {index > 0 ? <Text style={text(theme, "label", "foregroundMuted")}>→</Text> : null}
              <LadderRung theme={theme} n={attempt.n} verdict={attempt.verdict} open={attempt.open} respawned={attempt.respawned} />
            </View>
          ))}
        </View>
      ) : null}

      {/* Evidence Pills: Gate, Choke, Eye, Watch, Cost */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
        {lastAttempt !== undefined ? (
          <Pill
            theme={theme}
            label={lastAttempt.verdict === "green" ? "Gate green" : lastAttempt.verdict === "red" ? "Gate red" : "Gate —"}
            tone={lastAttempt.verdict === "green" ? "statusSuccess" : "statusDanger"}
            lit={lastAttempt.verdict !== null}
          />
        ) : null}
        <Pill theme={theme} label={`Choke ${task.choke.allowed}/${task.choke.denied}/${task.choke.blocked}`} mono />
        {lastEye !== null ? (
          <Pill
            theme={theme}
            label={`Eye ${lastEye.outcome.toUpperCase()}`}
            tone={lastEye.outcome === "concern" ? "statusWarning" : "statusSuccess"}
            lit
          />
        ) : null}
        {lastWatch !== null ? (
          <Pill
            theme={theme}
            label={`Watch ${lastWatch.maxProbability === null ? "—" : lastWatch.maxProbability.toFixed(2)}`}
            tone={(lastWatch.maxProbability ?? 0) >= 0.5 ? "statusWarning" : "foregroundMuted"}
            lit={(lastWatch.maxProbability ?? 0) >= 0.5}
            mono
          />
        ) : null}
        <Pill theme={theme} label={`Cost ${costLabel(task)}`} mono />
      </View>

      {/* Card Footer Actions: Direct Accept #n CTA on Ready to Accept cards + Details button */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
        {task.status === "ready-to-accept" && green !== undefined ? (
          <Btn
            theme={theme}
            small
            solid
            icon="Check"
            label={`Accept #${green.n}`}
            tone="statusSuccess"
            disabled={actions.busy}
            onPress={() => actions.accept(task.task, green!.n)}
          />
        ) : (
          <View />
        )}
        <Btn
          theme={theme}
          small
          icon="FileText"
          label="Details"
          tone="foregroundMuted"
          onPress={() => actions.openDetail(task.task)}
        />
      </View>
    </Pressable>
  );
}

export function TasksPane({
  theme,
  view,
  dir,
  actions,
}: {
  theme: PluginTheme;
  view: FactoryView;
  dir?: string;
  actions: TasksActions;
}) {
  const [filter, setFilter] = useState<BoardFilter>("all");
  const sameTree = (workspace: string): boolean => {
    if (dir === undefined) return true;
    const a = workspace.replace(/\/+$/, "");
    const b = dir.replace(/\/+$/, "");
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  const scoped = dir === undefined ? view.tasks : view.tasks.filter((task) => sameTree(task.workspace));
  const grouped = groupTasksForKanban(scoped);
  const visibleColumns =
    filter === "all" ? KANBAN_COLUMNS : KANBAN_COLUMNS.filter((column) => column.id === filter);
  const showProjectPill = view.project === null;

  return (
    <View style={{ gap: SPACING[3] }}>
      {/* Board Toolbar: Column Filter Chips + Compact Total Cost Summary Pill */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Chip
            theme={theme}
            label="All"
            active={filter === "all"}
            count={scoped.length}
            onPress={() => setFilter("all")}
          />
          {KANBAN_COLUMNS.map((column) => (
            <Chip
              key={column.id}
              theme={theme}
              label={column.title}
              icon={column.icon}
              active={filter === column.id}
              count={grouped[column.id].length}
              onPress={() => setFilter(column.id)}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          <Pill
            theme={theme}
            icon="DollarSign"
            label={`Total Cost $${view.kpis.totalCostUsd.toFixed(2)}`}
            tone={view.kpis.totalCostUsd > 0 ? "accent" : "foregroundMuted"}
            lit={view.kpis.totalCostUsd > 0}
            mono
          />
        </View>
      </View>

      {view.tasks.length > 0 && dir !== undefined && scoped.length === 0 ? (
        <Card theme={theme}>
          <Text style={text(theme, "meta")}>
            No factory tasks in this workspace — switch to All projects in the header to view every workspace.
          </Text>
        </Card>
      ) : null}

      {/* 5-Column Horizontal Kanban Board */}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: SPACING[3], alignItems: "flex-start", minWidth: "100%" }}>
        {visibleColumns.map((column) => {
          const columnTasks = grouped[column.id];
          const toneColour = theme.colors[column.tone];
          return (
            <View
              key={column.id}
              style={{
                minWidth: 270,
                flex: 1,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                borderRadius: RADIUS.lg,
                padding: SPACING[2.5],
                gap: SPACING[2],
              }}
            >
              {/* Column Header: Accent Dot, Icon, Title, and Live Task Count Badge */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                  <View
                    style={{
                      width: DOT,
                      height: DOT,
                      borderRadius: DOT,
                      backgroundColor: toneColour,
                    }}
                  />
                  <Icon name={column.icon} size={13} color={toneColour} />
                  <Text style={text(theme, "section")}>{column.title}</Text>
                </View>
                <View
                  style={{
                    paddingHorizontal: SPACING[2],
                    paddingVertical: 1,
                    borderRadius: RADIUS.sm,
                    backgroundColor: columnTasks.length > 0 ? tint(toneColour, "26") : theme.colors.surface2,
                  }}
                >
                  <Text
                    style={{
                      ...text(theme, "badge"),
                      fontVariant: ["tabular-nums"],
                      color: columnTasks.length > 0 ? toneColour : theme.colors.foregroundMuted,
                    }}
                  >
                    {columnTasks.length}
                  </Text>
                </View>
              </View>

              {/* Column Cards or Empty Placeholder */}
              {columnTasks.length === 0 ? (
                <View
                  style={{
                    paddingVertical: SPACING[3],
                    paddingHorizontal: SPACING[2],
                    borderRadius: RADIUS.md,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface0,
                    alignItems: "center",
                  }}
                >
                  <Text style={text(theme, "meta")}>{column.emptyCopy}</Text>
                </View>
              ) : (
                <View style={{ gap: SPACING[2] }}>
                  {columnTasks.map((task) => (
                    <KanbanCard
                      key={task.task}
                      theme={theme}
                      task={task}
                      showProjectPill={showProjectPill}
                      projectLabel={projectNameForTask(task, view.projects)}
                      actions={actions}
                    />
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Full Task Detail Modal: Contract, Attempt ladder, Report.md, Gate log, and Fresh-eyes / Watch breakdown. */
export function TaskDetailModal({
  theme,
  detail,
  onClose,
}: {
  theme: PluginTheme;
  detail: TaskDetailModalState | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={detail !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={detail === null ? "" : `${detail.task} — detail`}
      icon={undefined}
    >
      <Modal.Content>
        {detail === null || detail.loading ? (
          <Text style={text(theme, "meta")}>Loading…</Text>
        ) : detail.error !== null ? (
          <Text style={text(theme, "label", "statusWarning")}>{detail.error}</Text>
        ) : detail.detail === null ? null : (
          <TaskDetailBody theme={theme} detail={detail.detail} />
        )}
        <View style={{ paddingTop: SPACING[2] }}>
          <Btn theme={theme} small label="Close" tone="foregroundMuted" onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function TaskDetailBody({ theme, detail }: { theme: PluginTheme; detail: TaskDetailView }) {
  const contract = detail.contract;
  return (
    <View style={{ gap: SPACING[3] }}>
      <View style={{ gap: 2 }}>
        <Text style={text(theme, "section")}>Contract</Text>
        <Text style={text(theme, "code")}>gate: {contract.gate}</Text>
        <Text style={text(theme, "code")}>artifact: {contract.artifact}</Text>
        <Text style={text(theme, "code")}>scope: {contract.scope === null ? "unrestricted" : contract.scope.join(", ")}</Text>
        <Text style={text(theme, "code")}>skills: {contract.skills === null ? "none mandated" : contract.skills.join(", ")}</Text>
        <Text style={text(theme, "code")}>workspace: {contract.workspace}</Text>
        {contract.description !== null ? <Text style={text(theme, "meta")}>{contract.description}</Text> : null}
        <Text style={text(theme, "label")}>
          watch {contract.watch ? "on" : "off"} · fresh-eyes {contract.freshEyes ? "on" : "off"} · by {contract.by ?? "—"}
        </Text>
      </View>
      {detail.attempts.map((attempt, index) => {
        const view = detail.task.attempts[index]!;
        return (
          <View key={attempt.n} style={{ gap: 2, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: SPACING[2] }}>
            <Text style={text(theme, "rowTitle")}>
              #{attempt.n} {attempt.verdict ?? "—"} {view.respawned ? "↻" : ""}
            </Text>
            {view.note !== null ? <Text style={text(theme, "meta")}>note: {view.note}</Text> : null}
            {view.eye !== null ? (
              <Text style={text(theme, "meta")}>
                fresh-eyes ({view.eye.model}): {view.eye.outcome} — {view.eye.finding}
              </Text>
            ) : null}
            {view.watch !== null ? (
              <View style={{ gap: 1 }}>
                <Text style={text(theme, "meta")}>
                  watch ({view.watch.model}): {view.watch.outcome}
                  {view.watch.error !== null ? ` — ${view.watch.error}` : ""}
                </Text>
                {view.watch.answers !== null
                  ? Object.entries(view.watch.answers).map(([name, probability]) => (
                      <Text key={name} style={text(theme, "code")}>
                        {name}: {probability === null ? "—" : probability.toFixed(2)}
                      </Text>
                    ))
                  : null}
              </View>
            ) : null}
            {attempt.report !== null ? (
              <View style={{ gap: 1 }}>
                <Text style={text(theme, "label")}>Report.md</Text>
                <Text style={text(theme, "code")}>{attempt.report}</Text>
              </View>
            ) : null}
            {attempt.gateLog !== null ? (
              <View style={{ gap: 1 }}>
                <Text style={text(theme, "label")}>Gate log</Text>
                <Text style={text(theme, "code")}>{attempt.gateLog}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
