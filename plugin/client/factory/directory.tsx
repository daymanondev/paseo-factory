/** Project directory contributions: one header per root workspace and one actionable pill per live seat. */
import type { PluginButton, PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { handoffStart, lanesSet, seatsDirectory } from "../../shared/rpc.ts";
import type { ProjectDirectoryEntry, SeatDirectoryEntry } from "../../shared/view.ts";
import { headerPlans, pillPlans, reconcileDirectory } from "../kit/directory.ts";
import type { RegistrationLike } from "../kit/directory.ts";
import { SPACING, text } from "../kit/theme.ts";
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
  const context =
    seat.contextUsedTokens === null
      ? "Context unknown"
      : `${Math.round(seat.contextUsedTokens / 1000)}k / ${Math.round(seat.markTokens / 1000)}k`;
  const rows: readonly [label: string, value: string][] = [
    ["Role", seat.role],
    ["Model", seat.model ?? seat.provider],
    ["Thinking", seat.thinking ?? "—"],
    ["Context", context],
    ["Project", seat.slug],
    ["Handoff", seat.handoffState ?? "None"],
  ];
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
        minWidth: 220,
      }}
    >
      {rows.map(([label, value]) => (
        <View key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACING[3] }}>
          <Text style={{ ...text(theme, "label"), color: theme.colors.foregroundMuted }}>{label}</Text>
          <Text style={{ ...text(theme, "label"), color: theme.colors.foreground, fontWeight: "600" }} numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
      {switchModel ? seat.quickSwitchModels.slice(0, 6).map((lane, index) => <Btn key={`${lane.provider}/${lane.model}`} theme={theme} small testID={`factory-pill-model-${index}`} label={`${seat.role === "peer" || lane.provider !== seat.lane.provider ? "Hand off" : "Switch"} · ${lane.model}${lane.thinking ? ` · ${lane.thinking}` : ""}`} disabled={busy} onPress={() => { void act(() => switchModel(index)); }} />) : null}
      {otherModel ? <Btn theme={theme} small testID="factory-pill-other-model" label="Other model…" disabled={busy} onPress={() => { otherModel(); close(); }} /> : null}
      {handOffNow ? <Btn theme={theme} small testID="factory-pill-hand-off-now" label="Hand off now" disabled={busy} onPress={() => { void act(handOffNow); }} /> : null}
      {error !== null ? <Text style={text(theme, "label", "statusDanger")}>{error}</Text> : null}
      <Btn theme={theme} label="Close" onPress={close} small tone="foregroundMuted" />
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
