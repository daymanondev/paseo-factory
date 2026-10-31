import { ScrumOwnerWork, useOwnerCommand, CommandStatus } from "./owner-work.tsx";
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  SettingsSwitch,
  TextInput,
} from "@getpaseo/plugin/client/ui";
import { createElement, useEffect, useState, useRef } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { FactoryView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill, SegmentedControl } from "../kit/pill.tsx";
import { CONTROL_SM, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import { AgentCard, Rail, SeatNode } from "./seat-graph.tsx";
export type ScrumLane =
  | "supervisor"
  | "lead"
  | "pm"
  | "ux"
  | "architect"
  | "dev"
  | "qa"
  | "watch"
  | "retro";
export type ScrumAction = (
  operation: string,
  payload?: Record<string, unknown>,
  runId?: string,
  expectedRevision?: number,
  requestId?: string,
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
type ScrumConfig = NonNullable<NonNullable<FactoryView["execution"]>["config"]>;
type ScrumSeatActions = {
  busy: boolean;
  openAgent(id: string): void;
  revokeSupervisor(): void;
  rotateLead(): void;
};
export const MODE_OPTIONS = [
  { value: "slp", label: "SLP", icon: "GitBranch" },
  { value: "scrum", label: "Agile Scrum", icon: "Workflow" },
] as const;

/** Preview only: the first successful mode switch persists the server's seed. */
export function previewScrumConfig(view: FactoryView): ScrumConfig {
  if (view.execution?.machineConfig) return view.execution.machineConfig;
  const { supervisor, lead, worker, watch, retro } = view.lanes;
  return {
    schemaVersion: 1,
    requireUiApproval: true,
    lanes: {
      supervisor,
      lead,
      pm: lead,
      ux: worker,
      architect: lead,
      dev: worker,
      qa: worker,
      watch,
      retro,
    },
  };
}

export function ExecutionSelector({
  theme,
  view,
  setMode,
  busy,
}: {
  theme: PluginTheme;
  view: FactoryView;
  setMode?: (mode: "slp" | "scrum") => void;
  busy: boolean;
}) {
  if (!view.project) return null;
  return (
    <View style={{ gap: SPACING[1] }}>
      <SegmentedControl
        theme={theme}
        value={view.execution?.selectedMode ?? "slp"}
        options={MODE_OPTIONS}
        onChange={(mode) => setMode?.(mode)}
        disabled={busy || !setMode || !!view.execution?.busyReason}
      />
      {view.execution?.busyReason ? (
        <Text style={text(theme, "meta", "statusWarning")}>
          {view.execution.busyReason}
        </Text>
      ) : null}
      {view.execution?.error ? (
        <Text style={text(theme, "meta", "statusWarning")}>
          {view.execution.error}
        </Text>
      ) : null}
      {view.execution?.pendingMode ? (
        <Btn
          theme={theme}
          small
          label="Resume seat transition"
          disabled={busy}
          onPress={() => setMode?.(view.execution!.pendingMode!)}
        />
      ) : null}
    </View>
  );
}

const CARDS: {
  title: string;
  icon: string;
  tier: string;
  lanes: ScrumLane[];
  hint: string;
}[] = [
  {
    title: "Supervisor",
    icon: "Shield",
    tier: "Authority",
    lanes: ["supervisor"],
    hint: "Owner conversation and decisions",
  },
  {
    title: "Scrum Lead / PO",
    icon: "Compass",
    tier: "Coordinator",
    lanes: ["lead"],
    hint: "Tracks, contracts and semantic review",
  },
  {
    title: "PM / Analyst",
    icon: "FileText",
    tier: "Planning",
    lanes: ["pm"],
    hint: "Outcomes, requirements and assumptions",
  },
  {
    title: "UX Designer",
    icon: "Palette",
    tier: "Design",
    lanes: ["ux"],
    hint: "Flows, states and browser mockups",
  },
  {
    title: "System Architect",
    icon: "Network",
    tier: "Design",
    lanes: ["architect"],
    hint: "Architecture rules and compatibility",
  },
  {
    title: "Senior Dev",
    icon: "Code",
    tier: "Delivery",
    lanes: ["dev"],
    hint: "Bounded vertical stories and test promotion",
  },
  {
    title: "QA / Test Architect",
    icon: "CheckCheck",
    tier: "Verification",
    lanes: ["qa"],
    hint: "Independent product evidence",
  },
  {
    title: "Watch & Retro",
    icon: "Activity",
    tier: "Feedback",
    lanes: ["watch", "retro"],
    hint: "Record-only verification feedback",
  },
];
const STAGES = [
  {
    title: "1. PM / Analyst",
    phases: ["planning"],
    roles: ["pm"],
    artifacts: "prd.md · sprint-backlog.md",
  },
  {
    title: "2. UX ∥ Architect",
    phases: ["design"],
    roles: ["ux", "architect"],
    artifacts:
      "DESIGN.md · EXPERIENCE.md · mockups/index.html · architecture.md",
  },
  {
    title: "3. Readiness & UI Gate",
    phases: ["readiness", "awaiting-ui-approval"],
    roles: [],
    artifacts: "Cross-artifact readiness · Owner approval",
  },
  {
    title: "4. Senior Dev",
    phases: ["implementation"],
    roles: ["dev"],
    artifacts: "Vertical stories · isolated Task worktrees",
  },
  {
    title: "5. QA Audit & Fix Loop",
    phases: ["qa", "fixing"],
    roles: ["qa"],
    artifacts: "4-lens candidate bundle · qa-report.json · 2× reproduction",
  },
];

function MockupApproval({
  theme,
  view,
  action,
  busy,
}: {
  theme: PluginTheme;
  view: FactoryView;
  action?: ScrumAction;
  busy: boolean;
}) {
  const run = view.execution?.run;
  const command = useOwnerCommand(run!, action);
  const [preview, setPreview] = useState<{
    html: string;
    digest: string;
    model: { screens: Array<{ id: string; title?: string }>; states: string[]; evidence: { detector?: { nonAdvisoryCount: number } } };
    screenshots: Array<{ screen?: string; name?: string; width: number; height: number; dataUrl?: string }>;
  } | null>(null);
  const [rationale, setRationale] = useState("");
  const [viewport, setViewport] = useState('desktop');
  const [screen, setScreen] = useState('');
  const [designState, setDesignState] = useState('populated');
  const [studioOpening, setStudioOpening] = useState(false);
  const [studioError, setStudioError] = useState("");
  const studioRequest = useRef(false);
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [stageWidth, setStageWidth] = useState(420);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const sizes: Record<string, [number, number]> = { desktop: [1280, 800], tablet: [820, 1180], mobile: [390, 844] };
  const [designWidth, designHeight] = sizes[viewport];
  const scale = Math.min(1, stageWidth / designWidth);
  const switchPreview = () => frame.current?.contentWindow?.postMessage({ type: 'scrum:set-state', screen, state: designState }, '*');
  useEffect(switchPreview, [screen, designState, preview]);
  const resolveReachableStudioUrl = async (candidates: readonly string[], expectedDigest?: string): Promise<string | null> => {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    const checkCandidate = async (candidate: string, timeoutMs: number): Promise<string | null> => {
      try {
        const parsed = new URL(candidate);
        const stateUrl = `${parsed.origin}/api/state${parsed.search}`;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => controller?.abort(), timeoutMs);
        try {
          const res = await fetch(stateUrl, controller ? { signal: controller.signal } : undefined);
          if (!res.ok) return null;
          if (expectedDigest) {
            const payload = (await res.json()) as { design?: { digest?: string } };
            if (payload?.design?.digest && payload.design.digest !== expectedDigest) return null;
          }
          return candidate;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return null;
      }
    };
    const localMatch = await checkCandidate(candidates[0]!, 1000);
    if (localMatch) return localMatch;
    const remoteResults = await Promise.all(candidates.slice(1).map((c) => checkCandidate(c, 3500)));
    const firstRemote = remoteResults.find((r): r is string => r !== null);
    return firstRemote ?? candidates[1] ?? candidates[0]!;
  };
  const openStudio = async () => {
    if (!action || studioRequest.current) return;
    studioRequest.current = true;
    setStudioOpening(true);
    setStudioError("");
    try {
      const reply = await action('preview.url', {}, run?.runId);
      if (!reply.ok) throw new Error(reply.error ?? 'Could not prepare Design Studio. Try again.');
      const data = reply.data as { url?: string; urls?: string[] } | undefined;
      const candidates = Array.isArray(data?.urls) && data.urls.length > 0 ? data.urls : data?.url ? [data.url] : [];
      const targetUrl = await resolveReachableStudioUrl(candidates, run?.design?.digest);
      if (!targetUrl) throw new Error('Design Studio did not return a preview URL. Refresh Factory and try again.');
      await openExternalUrl(targetUrl);
    } catch (error) {
      setStudioError(error instanceof Error ? error.message : String(error));
    } finally {
      studioRequest.current = false;
      setStudioOpening(false);
    }
  };
  if (!run?.design)
    return <Text style={text(theme, "meta")}>Awaiting design evidence.</Text>;
  return (
    <Card
      theme={theme}
      gap={SPACING[2]}
      style={{
        borderColor: theme.colors.statusWarning,
        backgroundColor: tint(theme.colors.statusWarning, "10"),
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: SPACING[2],
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: SPACING[1.5],
          }}
        >
          <Icon name="Eye" size={14} color={theme.colors.statusWarning} />
          <Text style={text(theme, "rowTitle")}>
            UI Mockup Preview & Approval
          </Text>
          <Pill
            theme={theme}
            label={`Design r${run.design.revision} · ${run.design.digest.slice(0, 12)}`}
            tone="statusWarning"
            lit
            mono
          />
        </View>
        <Btn
          theme={theme}
          small
          solid
          icon="ExternalLink"
          label={studioOpening ? "Opening Design Studio…" : "Open Design Studio in Browser ↗"}
          tone="accent"
          disabled={busy || studioOpening || !action}
          onPress={openStudio}
        />
      </View>
      {studioError ? <Text accessibilityRole="alert" style={text(theme, "meta", "statusDanger")}>{studioError}</Text> : null}
      <Text style={text(theme, "meta")}>
        Stage 4 (Senior Dev) is paused until you preview the UI mockup in your default browser and record an Owner decision.
      </Text>
      <View
        style={{
          minHeight: CONTROL_SM,
          justifyContent: "center",
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: RADIUS.md,
          backgroundColor: theme.colors.surface0,
        }}
      >
        <TextInput
          value={rationale}
          onChangeText={setRationale}
          placeholder="Decision rationale (required to Approve / Request Changes / Waive)…"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Design decision rationale"
          style={{
            paddingHorizontal: SPACING[2.5],
            paddingVertical: 5,
            color: theme.colors.foreground,
            fontSize: 12,
          }}
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
        {(["approved", "changes_requested", "waived"] as const).map(
          (decision) => (
            <Btn
              key={decision}
              theme={theme}
              small
              solid={decision === "approved"}
              tone={
                decision === "approved"
                  ? "statusSuccess"
                  : decision === "changes_requested"
                    ? "statusWarning"
                    : "foregroundMuted"
              }
              label={
                decision === "approved"
                  ? "Approve"
                  : decision === "changes_requested"
                    ? "Request Changes"
                    : "Waive"
              }
              disabled={busy || command.pending || !rationale.trim()}
              onPress={() =>
                void command.submit(
                  "design.decide",
                  {
                    decision,
                    rationale: rationale.trim(),
                    revision: run.design!.revision,
                    digest: run.design!.digest,
                  },
                )
              }
            />
          ),
        )}
      </View>
      <CommandStatus theme={theme} command={command} />
      <Modal
        open={preview !== null && preview.digest === run.design.digest}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title="UI Mockup Preview"
      >
        <Modal.Content>
          <View style={{ gap: SPACING[2] }}>
            <Btn theme={theme} label={studioOpening ? "Opening Design Studio…" : "Open Full Design Studio ↗"} solid tone="accent" disabled={busy || studioOpening || !action} onPress={openStudio} />
            <SegmentedControl theme={theme} value={viewport} onChange={setViewport} options={[{ value: 'desktop', label: 'Desktop' }, { value: 'tablet', label: 'Tablet' }, { value: 'mobile', label: 'Mobile' }]} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[1] }}>
              {preview?.model.screens.map(s => <Btn key={s.id} theme={theme} small label={s.title ?? s.id} solid={screen === s.id} onPress={() => setScreen(s.id)} />)}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[1] }}>
              {preview?.model.states.map(s => <Btn key={s} theme={theme} small label={s} solid={designState === s} onPress={() => setDesignState(s)} />)}
            </View>
            <Text style={text(theme, 'meta')}>{designWidth}×{designHeight} · {Math.round(scale * 100)}% · {preview?.model.evidence.detector ? `${preview.model.evidence.detector.nonAdvisoryCount} non-advisory findings` : 'Legacy browser evidence'}</Text>
            <View onLayout={event => setStageWidth(event.nativeEvent.layout.width)} style={{ width: '100%', height: designHeight * scale, overflow: 'hidden' }}>
              {preview ? createElement('iframe', { ref: frame, title: 'Accepted Scrum design preview', sandbox: 'allow-scripts', srcDoc: preview.html, onLoad: switchPreview, referrerPolicy: 'no-referrer', style: { width: designWidth, height: designHeight, border: 0, transform: `scale(${scale})`, transformOrigin: 'top left' } }) : null}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[2] }}>
              {preview?.screenshots.map((capture, i) => <View key={i} style={{ gap: SPACING[1] }}>
                <Text style={text(theme, 'meta')}>{capture.screen ?? screen} · {capture.width}×{capture.height}</Text>
                {capture.dataUrl ? createElement('img', { src: capture.dataUrl, alt: `${capture.screen ?? screen} verified screenshot`, style: { width: 120, height: 90, objectFit: 'contain', border: `1px solid ${theme.colors.border}` } }) : null}
                <Btn theme={theme} small label="View capture" onPress={() => setCaptureUrl(capture.dataUrl ?? null)} />
              </View>)}
            </View>
            {captureUrl ? <View style={{ gap: SPACING[1] }}><Btn theme={theme} small label="Close capture" onPress={() => setCaptureUrl(null)} />{createElement('img', { src: captureUrl, alt: 'Full verified capture', style: { width: '100%', height: 'auto' } })}</View> : null}
          </View>
        </Modal.Content>
      </Modal>
    </Card>
  );
}

export function ScrumWorkflowPipeline({
  theme,
  view,
  action,
  actions,
}: {
  theme: PluginTheme;
  view: FactoryView;
  action?: ScrumAction;
  actions: { busy: boolean; openAgent(id: string): void };
}) {
  const run = view.execution?.run;
  const currentStage = run
    ? STAGES.findIndex((stage) => stage.phases.includes(run.phase))
    : -1;
  const special = run && ["blocked", "cancelled"].includes(run.phase);
  const needsUiDecision =
    run !== undefined &&
    (run.phase === "awaiting-ui-approval" ||
      (run.design !== undefined && !run.design.decision));
  return (
    <View style={{ gap: SPACING[2] }}>
      <View
        style={{
          flexDirection: "row",
          gap: SPACING[2],
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Text style={text(theme, "section")}>
          Specialist execution pipeline
        </Text>
        {run ? (
          <Pill
            theme={theme}
            label={`${run.runId} · ${run.phase}`}
            tone={
              special
                ? run.phase === "blocked"
                  ? "statusDanger"
                  : "statusWarning"
                : run.phase === "awaiting-ui-approval"
                  ? "statusWarning"
                  : "accent"
            }
            lit
          />
        ) : (
          <Pill theme={theme} label="No run started" />
        )}
      </View>
      {special ? (
        <Text style={text(theme, "meta", "statusWarning")}>
          {run.blockers?.join(" · ") ||
            run.cancellation?.reason ||
            "Run cancelled"}
        </Text>
      ) : null}
      {run ? <ScrumOwnerWork key={`${view.project?.slug}:${run.runId}`} theme={theme} run={run} action={action} busy={actions.busy}
        designReview={needsUiDecision ? <MockupApproval key={`${run.runId}:${run.design?.digest}`} theme={theme} view={view} action={action} busy={actions.busy} /> : undefined} /> : null}
      <View
        style={{
          flexDirection: "row",
          gap: SPACING[2],
          flexWrap: "wrap",
          alignItems: "stretch",
        }}
      >
        {STAGES.map((stage, index) => {
          const tasks = view.tasks.filter(
            (task) =>
              task.execution?.runId === run?.runId &&
              stage.roles.includes(task.execution?.role ?? ""),
          );
          const skipped = run?.skippedPhases?.find((skip) =>
            stage.phases.includes(skip.phase),
          );
          const active = index === currentStage;
          const completed =
            run?.phase === "completed" || (currentStage > index && !skipped);
          return (
            <View
              key={stage.title}
              style={{ minWidth: 190, flexBasis: 200, flexGrow: 1 }}
            >
              <Card
                theme={theme}
                gap={SPACING[1.5]}
                style={{
                  flex: 1,
                  borderColor: active
                    ? theme.colors.accent
                    : special
                      ? theme.colors[
                          run.phase === "blocked"
                            ? "statusDanger"
                            : "statusWarning"
                        ]
                      : theme.colors.border,
                  backgroundColor: active
                    ? tint(theme.colors.accent, "0d")
                    : theme.colors.surface1,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: SPACING[1],
                  }}
                >
                  <Text style={text(theme, "rowTitle")}>{stage.title}</Text>
                  <Pill
                    theme={theme}
                    label={
                      skipped
                        ? "Skipped"
                        : active
                          ? run!.phase
                          : completed
                            ? "Completed"
                            : "Waiting"
                    }
                    tone={
                      active
                        ? run?.phase === "awaiting-ui-approval"
                          ? "statusWarning"
                          : "accent"
                        : completed
                          ? "statusSuccess"
                          : "foregroundMuted"
                    }
                    lit={active}
                  />
                </View>
                <Text style={text(theme, "meta")}>
                  {skipped?.reason ?? stage.artifacts}
                </Text>
                {index === 4 ? (
                  <Pill
                    theme={theme}
                    label={`Fix rounds ${run?.fixRounds ?? 0}/${run?.budgets?.maxQaFixRounds ?? "—"}`}
                  />
                ) : null}
                {tasks.map((task) => {
                  const liveAgent =
                    view.agents.find((agent) => agent.task === task.task) ??
                    view.agents.find((agent) => agent.id === task.agentId);
                  const peerId =
                    liveAgent?.id ??
                    task.agentId ??
                    task.attempts.findLast(
                      (a) => typeof a.agentId === "string" && a.agentId !== "",
                    )?.agentId ??
                    null;
                  return (
                    <View
                      key={task.task}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: SPACING[1],
                        paddingTop: SPACING[1],
                        borderTopWidth: 1,
                        borderTopColor: theme.colors.border,
                      }}
                    >
                      <Text
                        style={{
                          ...text(theme, "code"),
                          flexShrink: 1,
                          minWidth: 0,
                        }}
                        numberOfLines={1}
                      >
                        {task.execution?.role.toUpperCase()} · {task.task}
                      </Text>
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: SPACING[1],
                        }}
                      >
                        <Pill
                          theme={theme}
                          label={task.verdict ?? task.status}
                          tone={
                            task.verdict === "green"
                              ? "statusSuccess"
                              : task.verdict === "red"
                                ? "statusDanger"
                                : "foregroundMuted"
                          }
                        />
                        {peerId ? (
                          <Btn
                            theme={theme}
                            small
                            label="Open"
                            icon="ExternalLink"
                            onPress={() => actions.openAgent(peerId)}
                          />
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </Card>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function ScrumSeatAndWorkflowGraph({
  theme,
  view,
  action,
  actions,
}: {
  theme: PluginTheme;
  view: FactoryView;
  action?: ScrumAction;
  actions: ScrumSeatActions;
}) {
  const config = view.execution?.config ?? previewScrumConfig(view);
  return (
    <View style={{ gap: SPACING[2] }}>
      <Text style={text(theme, "section")}>Scrum Seat & Workflow Graph</Text>
      <Text style={text(theme, "meta")}>Standing authority hierarchy</Text>
      <SeatNode
        theme={theme}
        title="Owner"
        icon="User"
        subtitle="Product decisions and UI approval"
        pills={[]}
      />
      <Rail theme={theme} />
      {(["supervisor", "lead"] as const).map((seat) => (
        <View key={seat} style={{ gap: SPACING[2] }}>
          {view[seat] ? (
            <AgentCard
              theme={theme}
              agent={view[seat]}
              actions={actions}
              retireLabel={
                seat === "supervisor" ? "Revoke Supervisor" : "Rotate Lead"
              }
              onRetire={
                seat === "supervisor"
                  ? actions.revokeSupervisor
                  : actions.rotateLead
              }
            />
          ) : (
            <SeatNode
              theme={theme}
              title={`${seat === "supervisor" ? "Supervisor" : "Scrum Lead / PO"} — not started`}
              icon={seat === "supervisor" ? "Shield" : "Compass"}
              subtitle={
                seat === "supervisor"
                  ? 'Start from "Supervisor (Factory)" in New Chat'
                  : "Started when Supervisor dispatches work"
              }
              pills={[{ label: config.lanes[seat], mono: true }]}
            />
          )}
          {seat === "lead" && view.lead ? (
            <View style={{ gap: 4 }}>
              <Text style={text(theme, "meta")}>
                {Math.round((view.lead.contextUsedTokens ?? 0) / 1000)}k / 128k
                context handoff
              </Text>
              <View
                accessibilityRole="progressbar"
                accessibilityValue={{
                  min: 0,
                  max: 128000,
                  now: view.lead.contextUsedTokens ?? 0,
                }}
                style={{
                  height: 5,
                  borderRadius: 3,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <View
                  style={{
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: theme.colors.accent,
                    width: `${Math.min(100, (view.lead.contextUsedTokens ?? 0) / 1280)}%`,
                  }}
                />
              </View>
            </View>
          ) : null}
          <Rail theme={theme} />
        </View>
      ))}
      <ScrumWorkflowPipeline
        theme={theme}
        view={view}
        action={action}
        actions={actions}
      />
    </View>
  );
}

function ScrumProfilesBar({
  theme,
  view,
  action,
  busy,
  requestChange,
}: {
  theme: PluginTheme;
  view: FactoryView;
  action?: ScrumAction;
  busy: boolean;
  requestChange(config: ScrumConfig | undefined, run: () => void): void;
}) {
  const [naming, setNaming] = useState(false),
    [name, setName] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  const profiles = view.execution?.profiles ?? [],
    active = profiles.find(
      (profile) => profile.id === view.execution?.activeProfileId,
    );
  const confirm = (key: string, run: () => void) => {
    if (armed === key) {
      setArmed(null);
      run();
    } else setArmed(key);
  };
  return (
    <Card theme={theme} gap={SPACING[2]}>
      <Text style={text(theme, "section")}>Scrum Profiles</Text>
      <Text style={text(theme, "meta")}>
        Copy a saved roster into{" "}
        {view.project
          ? (view.project.name ?? view.project.slug)
          : "the machine default roster"}
        .
      </Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: SPACING[2],
        }}
      >
        {profiles.map((profile) => (
          <View
            key={profile.id}
            style={{
              flexDirection: "row",
              gap: SPACING[1],
              alignItems: "center",
            }}
          >
            <Chip
              count={0}
              theme={theme}
              label={profile.name}
              active={profile.id === active?.id}
              onPress={() => {
                if (!busy)
                  requestChange(
                    profile.config,
                    () => void action?.("profile.apply", { id: profile.id }),
                  );
              }}
            />
            <Btn
              theme={theme}
              small
              tone="statusDanger"
              label={armed === profile.id ? "Confirm Delete" : "Delete"}
              disabled={busy}
              onPress={() =>
                confirm(
                  profile.id,
                  () => void action?.("profile.delete", { id: profile.id }),
                )
              }
            />
          </View>
        ))}
        <Btn
          theme={theme}
          small
          label="Save Profile…"
          disabled={busy}
          onPress={() => {
            setName("");
            setNaming(true);
          }}
        />
        <Btn
          theme={theme}
          small
          label={
            armed === "reset" ? "Confirm Reset" : "Reset to Machine Default"
          }
          disabled={busy}
          onPress={() =>
            confirm("reset", () =>
              requestChange(
                view.execution?.machineConfig,
                () => void action?.("config.reset"),
              ),
            )
          }
        />
      </View>
      {active ? (
        <Pill
          theme={theme}
          label={`${view.execution?.activeProfileModified ? "Modified from" : "Active:"} ${active.name}`}
          tone="accent"
          lit
        />
      ) : null}
      <Modal open={naming} onOpenChange={setNaming} title="Save Scrum Profile">
        <Modal.Content>
          <View style={{ gap: SPACING[3] }}>
            <View
              style={{
                borderRadius: RADIUS.sm,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface0,
                paddingHorizontal: SPACING[2],
                paddingVertical: SPACING[1],
              }}
            >
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="New profile name"
                placeholderTextColor={theme.colors.foregroundMuted}
                accessibilityLabel="Scrum profile name"
              />
            </View>
            <Btn
              theme={theme}
              label="Save as New Profile"
              disabled={busy || !name.trim()}
              onPress={() => {
                void action?.("profile.save", {
                  id: `profile-${Date.now()}`,
                  name: name.trim(),
                });
                setNaming(false);
              }}
            />
            {active ? (
              <Btn
                theme={theme}
                label={`Update ${active.name}`}
                disabled={busy}
                onPress={() => {
                  void action?.("profile.save", {
                    id: active.id,
                    name: active.name,
                  });
                  setNaming(false);
                }}
              />
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </Card>
  );
}

export function ScrumSeatsPane({
  theme,
  view,
  busy,
  action,
  actions,
  renderEditor,
}: {
  theme: PluginTheme;
  view: FactoryView;
  busy: boolean;
  action?: ScrumAction;
  actions: ScrumSeatActions;
  renderEditor(
    title: string,
    current: string,
    save: (value: string) => void,
    close: () => void,
  ): ReactNode;
}) {
  const [editing, setEditing] = useState<number | null>(null),
    [pending, setPending] = useState<(() => void) | null>(null);
  const config = view.execution?.config ?? previewScrumConfig(view),
    run = view.execution?.run;
  const requestChange = (next: ScrumConfig | undefined, commit: () => void) => {
    const live =
      view.project &&
      (["supervisor", "lead"] as const).some(
        (seat) =>
          view[seat] && (!next || next.lanes[seat] !== config.lanes[seat]),
      );
    if (live) setPending(() => commit);
    else commit();
  };
  const save = (lanes: ScrumLane[], value: string) => {
    const next = {
      ...config,
      lanes: {
        ...config.lanes,
        ...Object.fromEntries(lanes.map((lane) => [lane, value])),
      },
    };
    requestChange(next, () => void action?.("config.set", { config: next }));
    setEditing(null);
  };
  return (
    <View style={{ gap: SPACING[4] }}>
      {view.project ? (
        <ScrumSeatAndWorkflowGraph
          theme={theme}
          view={view}
          action={action}
          actions={actions}
        />
      ) : null}
      <View style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "section")}>Agile Scrum Team</Text>
        <Text style={text(theme, "meta")}>
          {run && !["completed", "cancelled"].includes(run.phase)
            ? `Run roster frozen at r${run.configRevision}. Edits apply to future runs.`
            : "Eight role cards with independent model configuration."}
        </Text>
      </View>
      <ScrumProfilesBar
        theme={theme}
        view={view}
        action={action}
        busy={busy}
        requestChange={requestChange}
      />
      <Card theme={theme}>
        <SettingsSwitch
          label="Require UI Approval"
          hint="Pause UI delivery for the Owner to preview and approve the mockup."
          value={config.requireUiApproval}
          disabled={busy}
          onValueChange={(value) =>
            void action?.("config.set", {
              config: { ...config, requireUiApproval: value },
            })
          }
        />
      </Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[3] }}>
        {CARDS.map((card, index) => {
          const lane = config.lanes[card.lanes[0]!],
            slash = lane.indexOf("/"),
            provider = lane.slice(0, slash),
            model = lane.slice(slash + 1).split(":")[0]!;
          const meta = view.providers
            .find((p) => p.provider === provider)
            ?.models?.find((m) => m.id === model);
          return (
            <Card
              key={card.title}
              theme={theme}
              gap={SPACING[2]}
              style={{
                flexGrow: 1,
                flexBasis: 270,
                justifyContent: "space-between",
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: SPACING[2],
                }}
              >
                <Icon name={card.icon} size={14} color={theme.colors.accent} />
                <Text style={{ ...text(theme, "rowTitle"), flex: 1 }}>
                  {card.title}
                </Text>
                <Pill theme={theme} label={card.tier} tone="accent" lit />
              </View>
              <View
                style={{
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: RADIUS.md,
                  padding: SPACING[2],
                  gap: SPACING[1],
                }}
              >
                <Pill theme={theme} label={provider} tone="accent" />
                <Text style={text(theme, "code")}>{model}</Text>
                <Pill
                  theme={theme}
                  label={`thinking: ${lane.includes(":") ? lane.slice(lane.lastIndexOf(":") + 1) : "default"}`}
                />
              </View>
              <Text style={text(theme, "meta")}>{card.hint}</Text>
              <Text style={text(theme, "meta")}>
                {meta?.thinkingOptions?.length
                  ? "Supports configurable reasoning"
                  : "Uses provider model capabilities"}
              </Text>
              <Btn
                theme={theme}
                small
                icon="Sliders"
                label="Configure Provider / Model / Thinking"
                disabled={busy}
                onPress={() => setEditing(index)}
              />
            </Card>
          );
        })}
      </View>
      {editing !== null
        ? renderEditor(
            CARDS[editing]!.title,
            config.lanes[CARDS[editing]!.lanes[0]!],
            (value) => save(CARDS[editing]!.lanes, value),
            () => setEditing(null),
          )
        : null}
      <Modal
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Apply to live Scrum seats?"
      >
        <Modal.Content>
          <View style={{ gap: SPACING[3] }}>
            <Text style={text(theme, "meta")}>
              The live Supervisor or Scrum Lead model will change. A provider
              change archives its session; the next turn uses the new roster.
              Active runs keep their frozen roster.
            </Text>
            <Btn
              theme={theme}
              label="Confirm & Apply"
              disabled={busy}
              onPress={() => {
                pending?.();
                setPending(null);
              }}
            />
            <Btn
              theme={theme}
              label="Cancel"
              onPress={() => setPending(null)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
