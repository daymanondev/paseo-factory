/** Project directory contributions: one header per root workspace and one actionable pill per live seat. */
import type { PluginButton, PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { handoffStart, lanesSet, seatsDirectory } from "../../shared/rpc.ts";
import type { ProjectDirectoryEntry, SeatDirectoryEntry } from "../../shared/view.ts";
import { headerPlans, pillPlans, reconcileDirectory } from "../kit/directory.ts";
import type { RegistrationLike } from "../kit/directory.ts";
import { CONTROL_SM, RADIUS, SPACING, hoveredOf, text } from "../kit/theme.ts";
import { Btn } from "../kit/pill.tsx";
import type { SeatEditorRequests } from "./editor-request.ts";
import { PANEL_ID } from "./entries.tsx";

/** What one Paseo button registration accepts as an in-place refresh. */
type ButtonPatch = Partial<PluginButton<string>>;
type DirectoryRegistration = RegistrationLike<ButtonPatch>;

/** The spike's poll cadence (spec §Spike: "the client polls it every 20 seconds"). */
export const DIRECTORY_POLL_MS = 20_000;

/** The starter owns RPCs; the popover renders the permitted actions and their feedback. */
function SeatDirectoryPopover({ theme, seat, close, otherModel, switchModel, handOffNow }: PluginButtonContentProps & { seat: SeatDirectoryEntry; otherModel?: () => void; switchModel?: (index: number) => Promise<void>; handOffNow?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const title = seat.role === "peer" ? (seat.task ? `Peer · ${seat.task}` : "Peer") : seat.role === "lead" ? "Lead" : "Supervisor";
  const meta = [seat.model ?? seat.lane.model, seat.thinking ?? seat.lane.thinking ?? null, seat.provider].filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
  const handoffFailed = seat.handoffState === "failed";
  // "done" is a finished handoff — nothing to say; every other state is in flight.
  const handoffLine = seat.handoffState === null || seat.handoffState === "done" ? null : handoffFailed ? "Handoff failed" : "Handing over…";
  // The seat's own model is never an alternative; the original index stays the testID and the write's argument.
  const isCurrent = (lane: { provider: string; model: string; thinking?: string | undefined }): boolean => {
    const thinking = lane.thinking ?? "";
    const live = lane.provider === seat.provider && lane.model === seat.model && thinking === (seat.thinking ?? "");
    const configured = lane.provider === seat.lane.provider && lane.model === seat.lane.model && thinking === (seat.lane.thinking ?? "");
    return live || configured;
  };
  const recent = switchModel ? seat.quickSwitchModels.slice(0, 6).map((lane, index) => ({ lane, index })).filter(({ lane }) => !isCurrent(lane)) : [];
  return (
    <View
      testID="factory-pill-popover"
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        padding: SPACING[3],
        gap: SPACING[2],
        minWidth: 260,
        maxWidth: 340,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2] }}>
        <Text style={{ ...text(theme, "section"), flex: 1, minWidth: 0, fontWeight: "600" }} numberOfLines={1}>{title}</Text>
        <Pressable
          testID="factory-pill-close"
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={close}
          style={(state) => ({ padding: SPACING[1], borderRadius: RADIUS.md, backgroundColor: state.pressed || hoveredOf(state) ? theme.colors.surface2 : "transparent" })}
        >
          <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {meta !== "" ? <Text style={text(theme, "meta")} numberOfLines={1}>{meta}</Text> : null}
      {handoffLine !== null ? <Text style={text(theme, "label", handoffFailed ? "statusWarning" : "foregroundMuted")}>{handoffLine}</Text> : null}
      {recent.length > 0 ? (
        <View style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "badge")}>RECENT MODELS</Text>
          {recent.map(({ lane, index }) => {
            const verb = seat.role === "peer" || lane.provider !== seat.lane.provider ? "Hand off" : "Switch";
            return (
              <Pressable
                key={`${lane.provider}/${lane.model}/${lane.thinking ?? ""}`}
                testID={`factory-pill-model-${index}`}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => { if (switchModel) void act(() => switchModel(index)); }}
                style={(state) => ({
                  minHeight: CONTROL_SM,
                  paddingHorizontal: SPACING[2],
                  paddingVertical: SPACING[1],
                  borderRadius: RADIUS.md,
                  backgroundColor: state.pressed || hoveredOf(state) ? theme.colors.surface2 : "transparent",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: SPACING[2],
                  opacity: busy ? 0.45 : 1,
                })}
              >
                <Text style={{ ...text(theme, "label"), flex: 1, minWidth: 0, color: theme.colors.foreground }} numberOfLines={1}>{lane.thinking ? `${lane.model} · ${lane.thinking}` : lane.model}</Text>
                <Text style={text(theme, "meta")} numberOfLines={1}>{lane.provider}</Text>
                <Text style={{ ...text(theme, "label"), fontWeight: "600", color: theme.colors.accent }}>{verb}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {handOffNow ? <Btn theme={theme} small variant="secondary" testID="factory-pill-hand-off-now" label="Hand off to a fresh session" disabled={busy} onPress={() => { void act(handOffNow); }} /> : null}
      {otherModel ? <Btn theme={theme} small variant="ghost" testID="factory-pill-other-model" label="Other model…" disabled={busy} onPress={() => { otherModel(); close(); }} /> : null}
      {error !== null ? <Text style={text(theme, "label", "statusDanger")}>{error}</Text> : null}
    </View>
  );
}

/**
 * Starts the directory poll. Returns the disposer `contribute()` rides: the
 * interval clears and every live registration removes.
 */
export function startSeatDirectory(client: PluginClientContext, editorRequests?: SeatEditorRequests): () => void {
  const headers = new Map<string, { fingerprint: string; registration: DirectoryRegistration }>();
  const pills = new Map<string, { fingerprint: string; registration: DirectoryRegistration }>();
  const warned = new Set<string>();
  const warn = (surface: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    const key = `${surface}:${message}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[Factory ${surface}] ${message}`);
  };
  const behaviorOf = (seat: SeatDirectoryEntry, project: ProjectDirectoryEntry | undefined) => {
    const target = seat.role === "peer" ? (seat.task ? `peer:${seat.task}` : null) : seat.role;
    const openEditor = project?.workspaceId && target ? () => {
      editorRequests?.request(project.workspaceId!, target);
      client.openPanel(PANEL_ID, { workspaceId: project.workspaceId!, location: "workspace" });
    } : undefined;
    const write = async (index?: number): Promise<void> => {
      if (!project?.root || !target) return;
      const lane = index === undefined ? undefined : seat.quickSwitchModels[index];
      if (index !== undefined && (!seat.allowedActions.includes("switch-model") || !lane)) return;
      if (index === undefined && !seat.allowedActions.includes("hand-off-now")) return;
      const value = lane ? `${lane.provider}/${lane.model}${lane.thinking ? `:${lane.thinking}` : ""}` : undefined;
      const reply = value !== undefined && seat.role !== "peer"
        ? await client.rpc(lanesSet, { projectRoot: project.root, lane: seat.role, value })
        : await client.rpc(handoffStart, { projectRoot: project.root, seat: target, ...(value === undefined ? {} : { lane: value }) });
      if (!reply.ok) throw new Error(reply.error);
      void tick();
    };
    if ((Platform.OS === "ios" || Platform.OS === "android") && openEditor) return { kind: "action" as const, onPress: openEditor };
    return { kind: "popover" as const, Content: (props: PluginButtonContentProps) => {
      if (props.layout.platform !== "web" && openEditor) return <View><Btn theme={props.theme} label="Open Factory" onPress={() => { openEditor(); props.close(); }} /></View>;
      return <SeatDirectoryPopover {...props} seat={seat} {...(openEditor ? { otherModel: openEditor } : {})} {...(project?.root && target && seat.allowedActions?.includes("switch-model") ? { switchModel: (index: number) => write(index) } : {})} {...(project?.root && target && seat.allowedActions?.includes("hand-off-now") ? { handOffNow: () => write() } : {})} />;
    } };
  };
  let stopped = false;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // Transport success may still carry a failed daemon read. Keep the last surfaces.
      const reply = await client.rpc(seatsDirectory, {});
      if (stopped) return;
      if (!reply.ok) { warn("directory poll", reply.error); return; }
      if (reply.daemonError) { warn("directory poll", reply.daemonError); return; }
      try {
        reconcileDirectory(
          headers,
          headerPlans(reply.projects),
          (plan) =>
            client.addHeaderButton({
              id: plan.id,
              workspaceId: plan.workspaceId,
              button: {
                title: "Factory",
                icon: "Activity",
                label: plan.label,
                behavior: {
                  kind: "action",
                  onPress: () => {
                    client.openPanel(PANEL_ID, { workspaceId: plan.workspaceId, location: "workspace" });
                  },
                },
              },
            }),
          (registration, plan) => registration.update({ label: plan.label }),
        );
      } catch (error) { warn("header", error); }
      try {
        reconcileDirectory(
          pills,
          pillPlans(reply.seats).map(plan => ({ ...plan, fingerprint: `${plan.fingerprint}:${JSON.stringify(reply.projects.find(project => project.slug === plan.seat.slug))}` })),
          (plan) =>
            client.addComposerPill({
              id: plan.id,
              workspaceId: plan.workspaceId,
              agentId: plan.agentId,
              button: {
                title: plan.seat.role,
                icon: "Activity",
                label: plan.label,
                behavior: behaviorOf(plan.seat, reply.projects.find(project => project.slug === plan.seat.slug)),
              },
            }),
          (registration, plan) => registration.update({ label: plan.label, behavior: behaviorOf(plan.seat, reply.projects.find(project => project.slug === plan.seat.slug)) }),
        );
      } catch (error) { warn("pill", error); }
    } catch (error) { warn("directory poll", error); }
    finally { inFlight = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, DIRECTORY_POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const entry of headers.values()) { try { entry.registration.remove(); } catch (error) { warn("header", error); } }
    for (const entry of pills.values()) { try { entry.registration.remove(); } catch (error) { warn("pill", error); } }
    headers.clear();
    pills.clear();
  };
}
