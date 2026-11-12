/**
 * The seat-directory starter (v0.6.1 W4 spike, ADR 0057 §8/§11): one poll of
 * `factory.seats.directory` every 20 seconds drives the surface's first
 * app-wide client contributions since the v0.6.0 slim-down — one
 * `addHeaderButton` per Project root workspace (label "Factory" plus the
 * Needs-you count, opening the existing panel at the workspace location) and
 * one read-only `addComposerPill` per live seat agent (label the role,
 * popover role/model/thinking/context/Project). Both register ONLY here, and
 * both ride the pure plan/reconcile halves in kit/directory.ts — paseo-room's
 * role-pill pattern: a map of registrations, `update` on change, `remove` on
 * disappearance. A failed poll keeps the last registrations; the next tick
 * retries. The popover is a pure render — no RPC and no write action inside
 * (the panes' law).
 */
import type { PluginButton, PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { seatsDirectory } from "../../shared/rpc.ts";
import type { SeatDirectoryEntry } from "../../shared/view.ts";
import { headerPlans, pillPlans, reconcileDirectory } from "../kit/directory.ts";
import type { RegistrationLike } from "../kit/directory.ts";
import { SPACING, text } from "../kit/theme.ts";
import { Btn } from "../kit/pill.tsx";
import { PANEL_ID } from "./entries.tsx";

/** What one Paseo button registration accepts as an in-place refresh. */
type ButtonPatch = Partial<PluginButton<string>>;
type DirectoryRegistration = RegistrationLike<ButtonPatch>;

/** The spike's poll cadence (spec §Spike: "the client polls it every 20 seconds"). */
export const DIRECTORY_POLL_MS = 20_000;

/** The read-only popover one seat pill opens — role, model, thinking, context and Project, nothing writable. */
function SeatDirectoryPopover({ theme, seat, close }: PluginButtonContentProps & { seat: SeatDirectoryEntry }) {
  const context =
    seat.contextUsedTokens === null
      ? "—"
      : `${Math.round(seat.contextUsedTokens / 1000)}k / ${Math.round(seat.markTokens / 1000)}k`;
  const rows: readonly [label: string, value: string][] = [
    ["Role", seat.role],
    ["Model", seat.model ?? seat.provider],
    ["Thinking", seat.thinking ?? "—"],
    ["Context", context],
    ["Project", seat.slug],
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
      <Btn theme={theme} label="Close" onPress={close} small tone="foregroundMuted" />
    </View>
  );
}

/** The popover behavior one seat row implies — its own closure, so a changed seat row replaces it wholesale. */
const popoverOf = (seat: SeatDirectoryEntry) => ({
  kind: "popover" as const,
  Content: (props: PluginButtonContentProps) => <SeatDirectoryPopover {...props} seat={seat} />,
});

/**
 * Starts the directory poll. Returns the disposer `contribute()` rides: the
 * interval clears and every live registration removes.
 */
export function startSeatDirectory(client: PluginClientContext): () => void {
  const headers = new Map<string, { fingerprint: string; registration: DirectoryRegistration }>();
  const pills = new Map<string, { fingerprint: string; registration: DirectoryRegistration }>();
  const tick = async (): Promise<void> => {
    // A failed poll keeps the last registrations — the next tick retries.
    try {
      const reply = await client.rpc(seatsDirectory, {});
      if (!reply.ok) return;
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
      reconcileDirectory(
        pills,
        pillPlans(reply.seats),
        (plan) =>
          client.addComposerPill({
            id: plan.id,
            workspaceId: plan.workspaceId,
            agentId: plan.agentId,
            button: {
              title: plan.seat.role,
              icon: "Activity",
              label: plan.label,
              behavior: popoverOf(plan.seat),
            },
          }),
        (registration, plan) => registration.update({ label: plan.label, behavior: popoverOf(plan.seat) }),
      );
    } catch {}
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, DIRECTORY_POLL_MS);
  return () => {
    clearInterval(timer);
    for (const entry of headers.values()) entry.registration.remove();
    for (const entry of pills.values()) entry.registration.remove();
    headers.clear();
    pills.clear();
  };
}
