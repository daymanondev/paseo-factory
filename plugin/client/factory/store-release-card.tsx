/**
 * "Store Release" card on the Project panel's Project tab (Tickets 06–07, ADR 0066).
 * Pure React Native view: collapsible (collapsed by default on non-mobile
 * Projects), displaying Store release mode (with Owner-only desktop selector),
 * Private vault store credential readiness + missing-key warning, detected
 * mobile platforms, latest run status, active Hole summary, and Open Release
 * Lab navigation. Mobile renders strictly read-only.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type {
  StoreReleaseMode,
  StoreReleasePlatform,
  StoreReleaseRunSummary,
  StoreReleaseVaultReadiness,
  StoreReleaseView,
} from "../../shared/view.ts";
import { Btn, ChoiceChip, Pill } from "../kit/pill.tsx";
import { SPACING, RADIUS, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

export const STORE_RELEASE_MODES: readonly StoreReleaseMode[] = ["off", "on-request", "auto-staging"];

export const STORE_RELEASE_MODE_MEANINGS: Record<StoreReleaseMode, string> = {
  off: "Store uploads disabled — Lead refuses store releases.",
  "on-request": "Lead builds and uploads to store staging only on explicit Supervisor dispatch.",
  "auto-staging": "Lead automatically stages mobile builds after GitHub Release succeeds; production still requires approval.",
};

export interface StoreReleaseCardFeedback {
  text: string;
  tone: "info" | "success" | "error";
}

export interface StoreReleaseActions {
  setMode?: (mode: StoreReleaseMode) => void | Promise<void>;
}

const PLATFORM_LABELS: Record<StoreReleasePlatform, string> = {
  android: "Android",
  ios: "iOS",
  expo: "Expo",
};

function agoOf(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function missingVaultKeysForPlatforms(
  platforms: readonly StoreReleasePlatform[],
  vault: StoreReleaseVaultReadiness,
): string[] {
  const needsApple = platforms.includes("ios") || platforms.includes("expo");
  const needsAndroid = platforms.includes("android") || platforms.includes("expo");
  const missing: string[] = [];
  if (needsApple) {
    if (!vault.ascKey) missing.push("ASC .p8");
    if (!vault.appleTeamId) missing.push("Team ID");
  }
  if (needsAndroid && !vault.gplayJson) {
    missing.push("GPlay JSON");
  }
  return missing;
}

function runStatusTone(status: string): Colour {
  if (status === "completed") return "statusSuccess";
  if (status === "failed") return "statusDanger";
  if (status === "paused-hole" || status === "running") return "statusWarning";
  return "foregroundMuted";
}

function formatRunHeadline(run: StoreReleaseRunSummary, now: number): string {
  const platforms = run.platforms.length > 0 ? run.platforms.map((p) => PLATFORM_LABELS[p as StoreReleasePlatform] ?? p).join(", ") : "none";
  const when = agoOf(run.completedAt ?? run.updatedAt, now);
  return `${run.playbook} · ${platforms} · ${run.id} · ${when}`;
}

export function StoreReleaseCard({
  theme,
  storeRelease,
  mobile,
  now,
  busy = false,
  feedback = null,
  actions = {},
  onOpenReleaseLab,
}: {
  theme: PluginTheme;
  storeRelease: StoreReleaseView;
  mobile: boolean;
  now: number;
  busy?: boolean;
  feedback?: StoreReleaseCardFeedback | null;
  actions?: StoreReleaseActions;
  onOpenReleaseLab?: () => void;
}) {
  const [expanded, setExpanded] = useState(storeRelease.isMobile);

  useEffect(() => {
    setExpanded(storeRelease.isMobile);
  }, [storeRelease.projectRoot, storeRelease.isMobile]);

  const missingKeys = missingVaultKeysForPlatforms(storeRelease.platforms, storeRelease.vault);
  const platformLabels = storeRelease.platforms.map((p) => PLATFORM_LABELS[p]);
  const modeInteractive = !mobile && actions.setMode !== undefined;
  const runnerReady = storeRelease.runner.installed && storeRelease.runner.enabled && storeRelease.runner.binPath !== null;
  const runnerNote = !storeRelease.runner.installed
    ? "factory-release-lab not installed"
    : !storeRelease.runner.enabled
      ? "factory-release-lab disabled"
      : storeRelease.runner.binPath === null
        ? "factory-release-lab runner CLI unavailable"
        : "Runner ready (factory-release-lab)";

  return (
    <View
      testID="factory-panel-store-release"
      style={{
        gap: SPACING[2.5],
        marginTop: SPACING[4],
        paddingTop: SPACING[4],
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <Text style={{ ...text(theme, "badge"), textTransform: "uppercase" }}>Store Release</Text>
        {!mobile ? (
          <Btn
            theme={theme}
            small
            variant="ghost"
            testID="factory-panel-store-release-toggle"
            label={expanded ? "▾ Hide" : "▸ Show"}
            onPress={() => setExpanded(!expanded)}
          />
        ) : null}
      </View>

      {!expanded ? (
        <Text style={text(theme, "meta")}>
          {storeRelease.isMobile
            ? `Collapsed · mode ${storeRelease.mode} · ${platformLabels.join(", ")}`
            : `No mobile platforms detected · mode ${storeRelease.mode}`}
        </Text>
      ) : (
        <View style={{ gap: SPACING[2.5] }}>
          <View testID="factory-panel-store-release-mode" style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Store release mode</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
              {modeInteractive ? (
                STORE_RELEASE_MODES.map((m) => (
                  <ChoiceChip
                    key={m}
                    theme={theme}
                    testID={`factory-panel-store-release-mode-${m}`}
                    label={m}
                    selected={storeRelease.mode === m}
                    disabled={busy}
                    onPress={() => {
                      if (m !== storeRelease.mode) void actions.setMode?.(m);
                    }}
                  />
                ))
              ) : (
                <Pill
                  theme={theme}
                  label={storeRelease.mode}
                  tone={storeRelease.mode === "off" ? "foregroundMuted" : "accent"}
                  lit={storeRelease.mode !== "off"}
                />
              )}
              {busy ? (
                <Text testID="factory-panel-store-release-pending" style={text(theme, "meta")}>
                  Saving…
                </Text>
              ) : null}
              {storeRelease.pendingRequest !== null ? (
                <Pill
                  theme={theme}
                  label={
                    storeRelease.pendingRequest.platforms && storeRelease.pendingRequest.platforms.length > 0
                      ? `Pending request: ${storeRelease.pendingRequest.target} (${storeRelease.pendingRequest.platforms.join(", ")})`
                      : `Pending request: ${storeRelease.pendingRequest.target}`
                  }
                  tone="statusWarning"
                  lit
                />
              ) : null}
            </View>
            <Text style={text(theme, "meta")}>{STORE_RELEASE_MODE_MEANINGS[storeRelease.mode]}</Text>
          </View>

          {feedback !== null ? (
            <Text
              testID="factory-panel-store-release-feedback"
              style={text(
                theme,
                "label",
                feedback.tone === "error"
                  ? "statusDanger"
                  : feedback.tone === "success"
                    ? "statusSuccess"
                    : "statusWarning",
              )}
            >
              {feedback.text}
            </Text>
          ) : null}

          <View testID="factory-panel-store-release-platforms" style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Detected mobile platforms</Text>
            {storeRelease.platforms.length === 0 ? (
              <Text style={text(theme, "meta")}>None detected (non-mobile project)</Text>
            ) : (
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
                {storeRelease.platforms.map((platform) => (
                  <Pill key={platform} theme={theme} label={PLATFORM_LABELS[platform]} tone="accent" lit />
                ))}
              </View>
            )}
            <Text style={text(theme, "meta", runnerReady ? undefined : "statusWarning")}>{runnerNote}</Text>
          </View>

          <View testID="factory-panel-store-release-vault" style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Private vault store credentials</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
              <Pill
                theme={theme}
                label={storeRelease.vault.ascKey ? "ASC .p8 · Ready" : "ASC .p8 · Missing"}
                tone={storeRelease.vault.ascKey ? "statusSuccess" : "foregroundMuted"}
                lit={storeRelease.vault.ascKey}
              />
              <Pill
                theme={theme}
                label={storeRelease.vault.appleTeamId ? "Team ID · Ready" : "Team ID · Missing"}
                tone={storeRelease.vault.appleTeamId ? "statusSuccess" : "foregroundMuted"}
                lit={storeRelease.vault.appleTeamId}
              />
              <Pill
                theme={theme}
                label={storeRelease.vault.gplayJson ? "GPlay JSON · Ready" : "GPlay JSON · Missing"}
                tone={storeRelease.vault.gplayJson ? "statusSuccess" : "foregroundMuted"}
                lit={storeRelease.vault.gplayJson}
              />
            </View>
            {missingKeys.length > 0 ? (
              <View
                testID="factory-panel-store-release-vault-warning"
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: SPACING[1.5],
                  padding: SPACING[2],
                  borderWidth: 1,
                  borderColor: theme.colors.statusWarning,
                  borderRadius: RADIUS.md,
                  backgroundColor: tint(theme.colors.statusWarning, "14"),
                }}
              >
                <Icon name="Shield" size={14} color={theme.colors.statusWarning} />
                <Text style={text(theme, "label", "statusWarning")}>
                  {`Missing Vault keys for ${platformLabels.join(" / ")}: ${missingKeys.join(", ")}. Import them in Factory Settings → Vault.`}
                </Text>
              </View>
            ) : null}
          </View>

          {storeRelease.activeHole !== null ? (
            <View
              testID="factory-panel-store-release-hole"
              style={{
                gap: SPACING[1],
                padding: SPACING[2.5],
                borderWidth: 1,
                borderColor: theme.colors.statusWarning,
                borderRadius: RADIUS.md,
                backgroundColor: tint(theme.colors.statusWarning, "14"),
              }}
            >
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
                <Icon name="Shield" size={14} color={theme.colors.statusWarning} />
                <Pill theme={theme} label="Active Hole" tone="statusWarning" lit />
                <Text style={text(theme, "rowTitle", "statusWarning")}>{storeRelease.activeHole.kind}</Text>
              </View>
              <Text style={text(theme, "meta")}>
                {`Phase ${storeRelease.activeHole.phase} · Run ${storeRelease.activeHole.runId} · paused ${agoOf(storeRelease.activeHole.pausedAt, now)}`}
              </Text>
              <Text style={text(theme, "meta")}>Resolve in Supervisor chat or Release Lab.</Text>
            </View>
          ) : null}

          <View testID="factory-panel-store-release-last" style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Latest store run</Text>
            {storeRelease.lastRun === null ? (
              <Text style={text(theme, "meta")}>No store runs yet</Text>
            ) : (
              <View style={{ gap: SPACING[0.5] }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
                  <Pill
                    theme={theme}
                    label={storeRelease.lastRun.status}
                    tone={runStatusTone(storeRelease.lastRun.status)}
                    lit={storeRelease.lastRun.status !== "pending"}
                  />
                  <Text style={text(theme, "rowTitle")}>{formatRunHeadline(storeRelease.lastRun, now)}</Text>
                </View>
                {storeRelease.lastRun.failure !== null ? (
                  <Text style={text(theme, "meta", "statusDanger")}>
                    {`${storeRelease.lastRun.failure.failureClass} · ${storeRelease.lastRun.failure.code}: ${storeRelease.lastRun.failure.message}`}
                  </Text>
                ) : storeRelease.lastRun.error !== null ? (
                  <Text style={text(theme, "meta", "statusDanger")}>{storeRelease.lastRun.error}</Text>
                ) : null}
                {storeRelease.lastRun.failure?.upstreamIssuePath ? (
                  <Text style={text(theme, "meta")}>{`Upstream issue: ${storeRelease.lastRun.failure.upstreamIssuePath}`}</Text>
                ) : null}
              </View>
            )}
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
            {!mobile ? (
              <Btn
                theme={theme}
                small
                variant="secondary"
                icon="Rocket"
                testID="factory-panel-store-release-open-lab"
                label="Open Release Lab"
                disabled={onOpenReleaseLab === undefined}
                onPress={() => onOpenReleaseLab?.()}
              />
            ) : (
              <Text testID="factory-panel-store-release-open-lab" style={text(theme, "meta")}>
                Open Release Lab on Paseo Desktop.
              </Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
