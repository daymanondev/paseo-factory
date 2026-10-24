/**
 * Tab 1 — Tasks, the Responsive 5-Column Kanban Verification Board (v0.0.35,
 * ADR 0025, amending ADR 0009 §2):
 * - Adapts to container width and Paseo's `layout.compact` flag (`wide`,
 *   `medium`, `compact`):
 *   - Wide (`>= 960px`): horizontal board where empty (`0`-task) columns
 *     collapse into slim rails and populated columns expand (flowing cards into
 *     a 2–3 column grid when one column holds many tasks).
 *   - Medium (`640px – 959px`): wrapping populated columns with a compact
 *     empty-columns strip above.
 *   - Compact (`< 640px` or `layout.compact`): single-column stacked view
 *     without horizontal scroll.
 * - Status-accented 3-tier `KanbanCard` with compact status-dot attempt trail
 *   (`summarizeAttemptTrail`), non-redundant evidence pills, direct `Accept #n`
 *   CTA on `Ready to Accept` cards, compact completed density for `Accepted`
 *   cards, and click-to-open `TaskDetailModal`.
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
  computeCardGridColumns,
  groupTasksForKanban,
  kanbanColumnForStatus,
  projectNameForTask,
  resolveKanbanLayoutMode,
  summarizeAttemptTrail,
} from "./kanban.ts";
import type {
  AttemptTrailItem,
  KanbanColumnDef,
  KanbanColumnId,
  KanbanLayoutMode,
  KanbanTaskStatus,
} from "./kanban.ts";

export {
  KANBAN_COLUMNS,
  computeCardGridColumns,
  groupTasksForKanban,
  kanbanColumnForStatus,
  projectNameForTask,
  resolveKanbanLayoutMode,
  summarizeAttemptTrail,
};
export type {
  AttemptTrailItem,
  KanbanColumnDef,
  KanbanColumnId,
  KanbanLayoutMode,
  KanbanTaskStatus,
};

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

function statusTone(status: TaskStatus): "statusWarning" | "accent" | "statusSuccess" | "foregroundMuted" | "statusDanger" {
  switch (status) {
    case "needs-human":
      return "statusWarning";
    case "running":
      return "accent";
    case "ready-to-accept":
      return "statusSuccess";
    case "accepted":
      return "statusSuccess";
    case "waiting":
      return "foregroundMuted";
    default:
      return "statusDanger";
  }
}

function statusPill(
  status: TaskStatus,
  reason: string | null,
): { label: string; tone: ReturnType<typeof statusTone>; lit: boolean } {
  const tone = statusTone(status);
  const label =
    status === "needs-human"
      ? reason !== null
        ? `needs human · ${reason}`
        : "needs human"
      : status === "ready-to-accept"
        ? "ready to accept"
        : status;
  return {
    label,
    tone,
    lit: status === "needs-human" || status === "ready-to-accept" || status === "running" || status === "red",
  };
}

function shortLaneLabel(lane: string): string {
  const parts = lane.split("/");
  return parts.length >= 2 ? parts[parts.length - 1]! : lane;
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

/** Compact Attempt Trail: colored status dots + `#n/3` badge + `↻ Respawned` indicator. */
function AttemptTrail({
  theme,
  attempts,
  compact = false,
}: {
  theme: PluginTheme;
  attempts: readonly AttemptTrailItem[];
  compact?: boolean;
}) {
  if (attempts.length === 0) return null;
  const trail = summarizeAttemptTrail(attempts, compact ? 4 : 5);
  const last = attempts[attempts.length - 1]!;
  const lastColour =
    last.verdict === "green"
      ? theme.colors.statusSuccess
      : last.verdict === "red"
        ? theme.colors.statusDanger
        : last.open
          ? theme.colors.accent
          : theme.colors.foregroundMuted;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
      <View
        style={{
          minHeight: PILL_H,
          paddingHorizontal: SPACING[2],
          paddingVertical: 2,
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: tint(lastColour, "55"),
          backgroundColor: tint(lastColour, "14"),
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
        }}
      >
        {trail.hiddenCount > 0 ? (
          <Text style={{ ...text(theme, "badge"), fontSize: 10, color: theme.colors.foregroundMuted }}>
            +{trail.hiddenCount}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          {trail.visible.map((attempt, idx) => {
            const dotColour =
              attempt.verdict === "green"
                ? theme.colors.statusSuccess
                : attempt.verdict === "red"
                  ? theme.colors.statusDanger
                  : attempt.open
                    ? theme.colors.accent
                    : theme.colors.foregroundMuted;
            return (
              <View
                key={`${idx}:${attempt.n}`}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 99,
                  backgroundColor: dotColour,
                  opacity: attempt.open ? 0.75 : 1,
                }}
              />
            );
          })}
        </View>
        <Text style={{ ...text(theme, "badge"), fontWeight: "600", color: lastColour, fontVariant: ["tabular-nums"] }}>
          #{last.n}/3
        </Text>
      </View>
      {trail.respawnCount > 0 && !compact ? (
        <Pill
          theme={theme}
          label={trail.respawnCount > 1 ? `↻ Respawned ×${trail.respawnCount}` : "↻ Respawned"}
          tone="foregroundMuted"
        />
      ) : null}
    </View>
  );
}

/**
 * Status-accented 3-tier Kanban Card:
 * - `Accepted` cards render in a clean, scannable completed density so a column
 *   of 15+ finished tasks never turns into a wall of pill soup.
 * - Active cards (`Queued`, `In Progress`, `Needs Attention`, `Ready to Accept`)
 *   render Tier 1 (Task ID + Project/Lane + Status), Tier 2 (2-line description
 *   + Blocker banner), and Tier 3 (Attempt trail dots + key Evidence pills +
 *   direct `Accept #n` CTA).
 */
function KanbanCard({
  theme,
  task,
  showProjectPill,
  projectLabel,
  actions,
  gridColumns = 1,
}: {
  theme: PluginTheme;
  task: TaskView;
  showProjectPill: boolean;
  projectLabel: string;
  actions: TasksActions;
  gridColumns?: number;
}) {
  const green = task.attempts.findLast((attempt) => attempt.verdict === "green" && !attempt.open);
  const lastAttempt = task.attempts.at(-1);
  const lastEye = task.attempts.findLast((a) => a.eye !== null)?.eye ?? null;
  const lastWatch = task.attempts.findLast((a) => a.watch !== null)?.watch ?? null;
  const pills = statusPill(task.status, task.needsHumanReason);
  const isAccepted = task.status === "accepted";
  const accentColour = theme.colors[statusTone(task.status)];
  const hasChokeAnomaly = task.choke.denied > 0 || task.choke.blocked > 0;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => actions.openDetail(task.task)}
      style={(state) => {
        const hovered = hoveredOf(state);
        return {
          ...(gridColumns > 1
            ? {
                flexBasis: gridColumns >= 3 ? 220 : 240,
                flexGrow: 1,
              }
            : {}),
          borderWidth: 1,
          borderLeftWidth: 3,
          borderColor: hovered ? theme.colors.foregroundMuted : theme.colors.border,
          borderLeftColor: isAccepted ? tint(theme.colors.statusSuccess, "88") : accentColour,
          backgroundColor: state.pressed
            ? theme.colors.surface2
            : isAccepted
              ? tint(theme.colors.surface0, "d8")
              : theme.colors.surface0,
          borderRadius: RADIUS.lg,
          padding: isAccepted ? SPACING[2] : SPACING[2.5],
          gap: isAccepted ? SPACING[1.5] : SPACING[2],
        };
      }}
    >
      {/* Tier 1: Card Header — Task ID, Project pill (All projects mode), short Lane tag, and primary status/cost */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap", flexShrink: 1 }}>
          {isAccepted ? <Icon name="CheckCircle2" size={13} color={theme.colors.statusSuccess} /> : null}
          <Text style={text(theme, "rowTitle")}>#{task.task}</Text>
          {showProjectPill ? <Pill theme={theme} icon="FolderGit2" label={projectLabel} /> : null}
          {!isAccepted && task.lane !== null ? <Pill theme={theme} label={shortLaneLabel(task.lane)} mono /> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1], flexWrap: "wrap" }}>
          {isAccepted ? (
            <>
              <AttemptTrail theme={theme} attempts={task.attempts} compact />
              {task.costState === "metered" ? (
                <Pill theme={theme} label={`Cost ${costLabel(task)}`} mono />
              ) : null}
            </>
          ) : (
            <Pill theme={theme} label={pills.label} tone={pills.tone} lit={pills.lit} />
          )}
        </View>
      </View>

      {/* Tier 2: Concise Description & Needs-Human Blocker Callout */}
      {task.description !== null ? (
        <Text
          style={{
            ...text(theme, "meta"),
            ...(isAccepted ? { fontSize: 12, lineHeight: 16 } : {}),
          }}
          numberOfLines={2}
        >
          {task.description}
        </Text>
      ) : null}

      {task.needsHumanReason !== null ? (
        <View
          style={{
            paddingHorizontal: SPACING[2],
            paddingVertical: SPACING[1.5],
            borderRadius: RADIUS.md,
            borderWidth: 1,
            borderColor: tint(theme.colors.statusWarning, "66"),
            backgroundColor: tint(theme.colors.statusWarning, "14"),
            flexDirection: "row",
            alignItems: "center",
            gap: SPACING[1.5],
          }}
        >
          <Icon name="AlertTriangle" size={12} color={theme.colors.statusWarning} />
          <Text style={{ ...text(theme, "label", "statusWarning"), flexShrink: 1 }}>
            Blocker: {task.needsHumanReason}
          </Text>
        </View>
      ) : null}

      {/* Tier 3: Active Card Telemetry & Direct Accept CTA (omitted on already-accepted compact cards unless anomalies exist) */}
      {!isAccepted ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: SPACING[1.5],
            paddingTop: 2,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
            <AttemptTrail theme={theme} attempts={task.attempts} />
            {lastAttempt !== undefined && lastAttempt.verdict !== null ? (
              <Pill
                theme={theme}
                label={lastAttempt.verdict === "green" ? "Gate green" : "Gate red"}
                tone={lastAttempt.verdict === "green" ? "statusSuccess" : "statusDanger"}
                lit
              />
            ) : null}
            {hasChokeAnomaly ? (
              <Pill
                theme={theme}
                label={`Choke ${task.choke.allowed}/${task.choke.denied}/${task.choke.blocked}`}
                tone="statusWarning"
                lit
                mono
              />
            ) : null}
            {lastEye !== null ? (
              <Pill
                theme={theme}
                label={`Eye ${lastEye.outcome.toUpperCase()}`}
                tone={lastEye.outcome === "concern" ? "statusWarning" : "statusSuccess"}
                lit
              />
            ) : null}
            {lastWatch !== null && lastWatch.maxProbability !== null ? (
              <Pill
                theme={theme}
                label={`Watch ${lastWatch.maxProbability.toFixed(2)}`}
                tone={lastWatch.maxProbability >= 0.5 ? "statusWarning" : "foregroundMuted"}
                lit={lastWatch.maxProbability >= 0.5}
                mono
              />
            ) : null}
            <Pill theme={theme} label={`Cost ${costLabel(task)}`} mono />
          </View>

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
          ) : null}
        </View>
      ) : hasChokeAnomaly || lastEye?.outcome === "concern" ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
          {hasChokeAnomaly ? (
            <Pill theme={theme} label={`Choke ${task.choke.allowed}/${task.choke.denied}/${task.choke.blocked}`} mono />
          ) : null}
          {lastEye !== null ? (
            <Pill
              theme={theme}
              label={`Eye ${lastEye.outcome.toUpperCase()}`}
              tone={lastEye.outcome === "concern" ? "statusWarning" : "statusSuccess"}
              lit={lastEye.outcome === "concern"}
            />
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export function TasksPane({
  theme,
  view,
  dir,
  compact = false,
  containerWidth = 0,
  actions,
}: {
  theme: PluginTheme;
  view: FactoryView;
  dir?: string;
  compact?: boolean;
  containerWidth?: number;
  actions: TasksActions;
}) {
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [boardWidth, setBoardWidth] = useState<number>(0);

  const sameTree = (workspace: string): boolean => {
    if (dir === undefined) return true;
    const a = workspace.replace(/\/+$/, "");
    const b = dir.replace(/\/+$/, "");
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  const scoped =
    dir === undefined || view.project !== null
      ? view.tasks
      : view.tasks.filter((task) => sameTree(task.workspace));
  const grouped = groupTasksForKanban(scoped);
  const visibleColumns =
    filter === "all" ? KANBAN_COLUMNS : KANBAN_COLUMNS.filter((column) => column.id === filter);
  const showProjectPill = view.project === null;

  const effectiveWidth = boardWidth > 0 ? boardWidth : containerWidth;
  const layoutMode = resolveKanbanLayoutMode({ containerWidth: effectiveWidth, compact });
  const populatedColumns = visibleColumns.filter((col) => grouped[col.id].length > 0);
  const emptyColumns = visibleColumns.filter((col) => grouped[col.id].length === 0);
  const collapseEmptyInStack = filter === "all" && populatedColumns.length > 0 && emptyColumns.length > 0;

  const renderColumnCard = (column: KanbanColumnDef, activeColumnCount: number) => {
    const columnTasks = grouped[column.id];
    const toneColour = theme.colors[column.tone];
    const isEmpty = columnTasks.length === 0;
    const isCollapsedRail =
      layoutMode === "wide" && filter === "all" && isEmpty && populatedColumns.length > 0;
    const gridColumns = computeCardGridColumns({
      layoutMode,
      containerWidth: effectiveWidth,
      activeColumnCount,
      cardCount: columnTasks.length,
    });

    if (isCollapsedRail) {
      return (
        <Pressable
          key={column.id}
          accessibilityRole="button"
          onPress={() => setFilter(column.id)}
          style={(state) => ({
            width: 132,
            flexGrow: 0,
            flexShrink: 0,
            borderWidth: 1,
            borderTopWidth: 2,
            borderColor: hoveredOf(state) ? theme.colors.foregroundMuted : theme.colors.border,
            borderTopColor: tint(toneColour, "66"),
            backgroundColor: tint(theme.colors.surface1, "88"),
            borderRadius: RADIUS.lg,
            padding: SPACING[2],
            gap: SPACING[1],
            opacity: 0.78,
          })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[1] }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1], flexShrink: 1 }}>
              <Icon name={column.icon} size={12} color={theme.colors.foregroundMuted} />
              <Text style={{ ...text(theme, "label"), fontWeight: "600" }} numberOfLines={1}>
                {column.title}
              </Text>
            </View>
            <Text style={{ ...text(theme, "badge"), fontVariant: ["tabular-nums"] }}>0</Text>
          </View>
          <Text style={{ ...text(theme, "badge"), fontWeight: "400" }} numberOfLines={2}>
            {column.emptyCopy}
          </Text>
        </Pressable>
      );
    }

    return (
      <View
        key={column.id}
        style={{
          ...(layoutMode === "wide"
            ? {
                minWidth: activeColumnCount <= 1 ? 320 : activeColumnCount >= 4 ? 180 : 240,
                flex: gridColumns >= 3 ? 3 : gridColumns === 2 ? 2 : 1,
              }
            : layoutMode === "medium"
              ? {
                  flexBasis: activeColumnCount <= 1 ? "100%" : 280,
                  flexGrow: 1,
                }
              : {
                  width: "100%",
                }),
          borderWidth: 1,
          borderTopWidth: 3,
          borderColor: theme.colors.border,
          borderTopColor: isEmpty ? tint(toneColour, "66") : toneColour,
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
        {isEmpty ? (
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
          <View
            style={{
              gap: SPACING[2],
              ...(gridColumns > 1
                ? {
                    flexDirection: "row",
                    flexWrap: "wrap",
                    alignItems: "stretch",
                  }
                : {}),
            }}
          >
            {columnTasks.map((task) => (
              <KanbanCard
                key={task.task}
                theme={theme}
                task={task}
                showProjectPill={showProjectPill}
                projectLabel={projectNameForTask(task, view.projects)}
                actions={actions}
                gridColumns={gridColumns}
              />
            ))}
          </View>
        )}
      </View>
    );
  };

  return (
    <View
      style={{ gap: SPACING[3] }}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && Math.abs(w - boardWidth) >= 4) setBoardWidth(w);
      }}
    >
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
            label={`Total Cost $${view.kpis.totalCostUsd.toFixed(2)} · ${(view.kpis.totalTokens ?? 0).toLocaleString()} tok`}
            tone={view.kpis.totalCostUsd > 0 || (view.kpis.totalTokens ?? 0) > 0 ? "accent" : "foregroundMuted"}
            lit={view.kpis.totalCostUsd > 0 || (view.kpis.totalTokens ?? 0) > 0}
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

      {/* Responsive Kanban Board: Wide horizontal rails vs Medium/Compact adaptive stack */}
      {layoutMode === "wide" ? (
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: SPACING[2.5], alignItems: "flex-start", minWidth: "100%" }}>
          {visibleColumns.map((column) =>
            renderColumnCard(column, Math.max(1, populatedColumns.length)),
          )}
        </ScrollView>
      ) : (
        <View style={{ gap: SPACING[2.5] }}>
          {collapseEmptyInStack ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: SPACING[1.5],
                paddingHorizontal: SPACING[2.5],
                paddingVertical: SPACING[1.5],
                borderRadius: RADIUS.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Text style={text(theme, "badge")}>EMPTY STAGES</Text>
              {emptyColumns.map((col) => (
                <Pill key={col.id} theme={theme} icon={col.icon} label={`${col.title} · 0`} tone="foregroundMuted" />
              ))}
            </View>
          ) : null}
          <View
            style={{
              flexDirection: layoutMode === "medium" ? "row" : "column",
              flexWrap: layoutMode === "medium" ? "wrap" : "nowrap",
              gap: SPACING[2.5],
              alignItems: "stretch",
            }}
          >
            {(collapseEmptyInStack ? populatedColumns : visibleColumns).map((column) =>
              renderColumnCard(column, Math.max(1, populatedColumns.length)),
            )}
          </View>
        </View>
      )}
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
