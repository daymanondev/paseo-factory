/**
 * "Store Release" card on the Project panel's Project tab (Tickets 06–07, ADR 0066).
 * Pure React Native view: defaults to a compact summary bar (1 slim line on
 * non-mobile Projects, 2 lines on mobile Projects) and auto-expands only when
 * Owner attention is needed (active Hole, failed lastRun, or missing Vault
 * keys while mode !== "off"), preserving manual collapse across snapshot polls.
 * Mobile renders strictly read-only with zero buttons.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type {
  StoreReleaseMode,
  StoreReleasePlatform,
  StoreReleaseRunSummary,
  StoreReleaseVaultReadiness,
  StoreReleaseView,
} from "../../shared/view.ts";
import { AlertRow, Btn, Card, SegmentedControl, ToneBadge, formatRelativeAgo } from "../kit/pill.tsx";
import { SPACING, factoryPalette, text } from "../kit/theme.ts";

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

type FactoryPalette = ReturnType<typeof factoryPalette>;

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

function modeColour(palette: FactoryPalette, mode: StoreReleaseMode): string {
  if (mode === "auto-staging") return palette.ok;
  if (mode === "on-request") return palette.lead;
  return palette.idle;
}

function runStatusColour(palette: FactoryPalette, status: string): string {
  if (status === "completed") return palette.ok;
  if (status === "failed") return palette.bad;
  if (status === "paused-hole" || status === "running") return palette.wait;
  return palette.idle;
}

function formatRunHeadline(run: StoreReleaseRunSummary, now: number): string {
  const platforms = run.platforms.length > 0 ? run.platforms.map((p) => PLATFORM_LABELS[p as StoreReleasePlatform] ?? p).join(", ") : "none";
  const when = formatRelativeAgo(run.completedAt ?? run.updatedAt, now);
  return `${run.playbook} · ${platforms} · ${run.id} · ${when}`;
}

function StoreReleaseRow({
  theme,
  wide,
  label,
  testID,
  children,
}: {
  theme: PluginTheme;
  wide: boolean;
  label: string;
  testID?: string;
  children: ReactNode;
}) {
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={wide ? { flexDirection: "row", alignItems: "flex-start", gap: SPACING[3] } : { gap: SPACING[1] }}
    >
      <View style={wide ? { width: 124, flexShrink: 0, paddingTop: 2 } : undefined}>
        <Text style={text(theme, "label")}>{label}</Text>
      </View>
      <View style={wide ? { flex: 1, minWidth: 0, gap: SPACING[1] } : { gap: SPACING[1] }}>
        {children}
      </View>
    </View>
  );
}

function LatestRunDetail({
  theme,
  palette,
  lastRun,
  now,
  inlinePrefix,
}: {
  theme: PluginTheme;
  palette: FactoryPalette;
  lastRun: StoreReleaseRunSummary | null;
  now: number;
  inlinePrefix?: string;
}) {
  const failureText =
    lastRun?.failure !== null && lastRun?.failure !== undefined
      ? `${lastRun.failure.failureClass} · ${lastRun.failure.code}: ${lastRun.failure.message}`
      : lastRun?.error ?? null;
  const upstreamPath = lastRun?.failure?.upstreamIssuePath;
  return (
    <View style={{ gap: SPACING[0.5] }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
        {inlinePrefix !== undefined ? <Text style={text(theme, "label")}>{inlinePrefix}</Text> : null}
        {lastRun === null ? (
          <Text style={text(theme, "meta")}>No store runs yet</Text>
        ) : (
          <>
            <ToneBadge
              theme={theme}
              label={lastRun.status}
              colour={runStatusColour(palette, lastRun.status)}
              dot={lastRun.status !== "pending"}
            />
            <Text style={{ ...text(theme, "meta"), color: theme.colors.foreground }}>
              {formatRunHeadline(lastRun, now)}
            </Text>
          </>
        )}
      </View>
      {failureText !== null ? (
        <Text style={{ ...text(theme, "meta"), color: palette.bad }}>{failureText}</Text>
      ) : null}
      {upstreamPath ? (
        <Text style={text(theme, "meta")}>{`Upstream issue: ${upstreamPath}`}</Text>
      ) : null}
    </View>
  );
}

export function StoreReleaseCard({
  theme,
  storeRelease,
  mobile,
  now,
  busy = false,
  feedback = null,
  wide = false,
  actions = {},
  onOpenReleaseLab,
  onOpenSettings,
}: {
  theme: PluginTheme;
  storeRelease: StoreReleaseView;
  mobile: boolean;
  now: number;
  busy?: boolean;
  feedback?: StoreReleaseCardFeedback | null;
  wide?: boolean;
  actions?: StoreReleaseActions;
  onOpenReleaseLab?: () => void;
  onOpenSettings?: () => void;
}) {
  const palette = factoryPalette(theme);
  const missingKeys = missingVaultKeysForPlatforms(storeRelease.platforms, storeRelease.vault);
  const needsVaultWarning = missingKeys.length > 0 && storeRelease.mode !== "off";
  const attentionKey =
    storeRelease.activeHole !== null
      ? `hole:${storeRelease.activeHole.runId}:${storeRelease.activeHole.pausedAt}`
      : storeRelease.lastRun?.status === "failed"
        ? `fail:${storeRelease.lastRun.id}`
        : needsVaultWarning
          ? `vault:${missingKeys.join(",")}`
          : "";

  const [expanded, setExpanded] = useState(attentionKey !== "");
  const prevProjectRootRef = useRef(storeRelease.projectRoot);
  const prevAttentionKeyRef = useRef(attentionKey);

  useEffect(() => {
    if (storeRelease.projectRoot !== prevProjectRootRef.current) {
      prevProjectRootRef.current = storeRelease.projectRoot;
      prevAttentionKeyRef.current = attentionKey;
      setExpanded(attentionKey !== "");
      return;
    }
    if (attentionKey !== prevAttentionKeyRef.current) {
      prevAttentionKeyRef.current = attentionKey;
      if (attentionKey !== "") {
        setExpanded(true);
      }
    }
  }, [storeRelease.projectRoot, attentionKey]);

  const activeModeColour = modeColour(palette, storeRelease.mode);
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

  const vaultChecks: readonly { label: string; ready: boolean }[] = [
    { label: storeRelease.vault.ascKey ? "ASC .p8 · Ready" : "ASC .p8 · Missing", ready: storeRelease.vault.ascKey },
    { label: storeRelease.vault.appleTeamId ? "Team ID · Ready" : "Team ID · Missing", ready: storeRelease.vault.appleTeamId },
    { label: storeRelease.vault.gplayJson ? "GPlay JSON · Ready" : "GPlay JSON · Missing", ready: storeRelease.vault.gplayJson },
  ];

  return (
    <Card theme={theme} testID="factory-panel-store-release">
      {!storeRelease.isMobile ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", flex: 1, minWidth: 0, gap: SPACING[1.5] }}>
            <Text style={{ ...text(theme, "badge"), textTransform: "uppercase" }}>Store Release</Text>
            <ToneBadge
              theme={theme}
              label={storeRelease.mode}
              colour={activeModeColour}
              dot={storeRelease.mode !== "off"}
            />
            <Text style={text(theme, "meta")}>No mobile platforms detected</Text>
          </View>
          {!mobile ? (
            <Btn
              theme={theme}
              small
              variant="ghost"
              testID="factory-panel-store-release-toggle"
              label={expanded ? "▾ Hide" : "Configure ▾"}
              onPress={() => setExpanded(!expanded)}
            />
          ) : null}
        </View>
      ) : (
        <View style={{ gap: SPACING[1.5] }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", flex: 1, minWidth: 0, gap: SPACING[1.5] }}>
              <Text style={{ ...text(theme, "badge"), textTransform: "uppercase" }}>Store Release</Text>
              <ToneBadge
                theme={theme}
                label={storeRelease.mode}
                colour={activeModeColour}
                dot={storeRelease.mode !== "off"}
              />
              {storeRelease.platforms.map((platform) => (
                <ToneBadge
                  key={platform}
                  theme={theme}
                  label={PLATFORM_LABELS[platform]}
                  colour={palette.peer}
                  dot={false}
                />
              ))}
              <ToneBadge
                theme={theme}
                label={missingKeys.length === 0 ? "Vault ready" : `Vault · ${missingKeys.length} missing`}
                colour={missingKeys.length === 0 ? palette.ok : storeRelease.mode === "off" ? palette.idle : palette.wait}
                dot={missingKeys.length === 0 || storeRelease.mode !== "off"}
              />
              {!expanded && storeRelease.activeHole !== null ? (
                <ToneBadge theme={theme} label="Active Hole" colour={palette.wait} />
              ) : null}
              {!expanded && storeRelease.lastRun?.status === "failed" ? (
                <ToneBadge theme={theme} label="Failed" colour={palette.bad} />
              ) : null}
            </View>
            {!mobile ? (
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                <Btn
                  theme={theme}
                  small
                  variant="secondary"
                  icon="Rocket"
                  testID="factory-panel-store-release-open-lab"
                  label="Release Lab"
                  disabled={onOpenReleaseLab === undefined}
                  onPress={() => onOpenReleaseLab?.()}
                />
                <Btn
                  theme={theme}
                  small
                  variant="ghost"
                  testID="factory-panel-store-release-toggle"
                  label={expanded ? "▾ Hide" : "Configure ▾"}
                  onPress={() => setExpanded(!expanded)}
                />
              </View>
            ) : null}
          </View>
          <View testID="factory-panel-store-release-last">
            <LatestRunDetail
              theme={theme}
              palette={palette}
              lastRun={storeRelease.lastRun}
              now={now}
              inlinePrefix="Latest run"
            />
          </View>
        </View>
      )}

      {expanded ? (
        <View
          style={{
            gap: SPACING[2.5],
            paddingTop: SPACING[2.5],
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          <StoreReleaseRow
            theme={theme}
            wide={wide}
            label="Store release mode"
            testID="factory-panel-store-release-mode"
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
              {modeInteractive ? (
                <SegmentedControl
                  theme={theme}
                  size="sm"
                  optionTestIDPrefix="factory-panel-store-release-mode"
                  value={storeRelease.mode}
                  disabled={busy}
                  onChange={(m) => {
                    if (m !== storeRelease.mode) void actions.setMode?.(m);
                  }}
                  options={[
                    { value: "off", label: "off", accentColour: palette.idle },
                    { value: "on-request", label: "on-request", accentColour: palette.lead },
                    { value: "auto-staging", label: "auto-staging", accentColour: palette.ok },
                  ]}
                />
              ) : (
                <ToneBadge
                  theme={theme}
                  label={storeRelease.mode}
                  colour={activeModeColour}
                  dot={storeRelease.mode !== "off"}
                />
              )}
              {busy ? (
                <Text testID="factory-panel-store-release-pending" style={text(theme, "meta")}>
                  Saving…
                </Text>
              ) : null}
              {storeRelease.pendingRequest !== null ? (
                <ToneBadge
                  theme={theme}
                  label={
                    storeRelease.pendingRequest.platforms && storeRelease.pendingRequest.platforms.length > 0
                      ? `Pending request: ${storeRelease.pendingRequest.target} (${storeRelease.pendingRequest.platforms.join(", ")})`
                      : `Pending request: ${storeRelease.pendingRequest.target}`
                  }
                  colour={palette.wait}
                />
              ) : null}
            </View>
            <Text style={text(theme, "meta")}>{STORE_RELEASE_MODE_MEANINGS[storeRelease.mode]}</Text>
          </StoreReleaseRow>

          {feedback !== null ? (
            <Text
              testID="factory-panel-store-release-feedback"
              style={{
                ...text(theme, "label"),
                color:
                  feedback.tone === "error"
                    ? palette.bad
                    : feedback.tone === "success"
                      ? palette.ok
                      : palette.wait,
              }}
            >
              {feedback.text}
            </Text>
          ) : null}

          <StoreReleaseRow theme={theme} wide={wide} label="Platforms" testID="factory-panel-store-release-platforms">
            {storeRelease.platforms.length === 0 ? (
              <Text style={text(theme, "meta")}>None detected (non-mobile project)</Text>
            ) : (
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
                {storeRelease.platforms.map((platform) => (
                  <ToneBadge
                    key={platform}
                    theme={theme}
                    label={PLATFORM_LABELS[platform]}
                    colour={palette.peer}
                    dot={false}
                  />
                ))}
              </View>
            )}
            <Text style={runnerReady ? text(theme, "meta") : { ...text(theme, "meta"), color: palette.wait }}>
              {runnerNote}
            </Text>
          </StoreReleaseRow>

          <StoreReleaseRow theme={theme} wide={wide} label="Private vault" testID="factory-panel-store-release-vault">
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
              {vaultChecks.map((item) => (
                <ToneBadge
                  key={item.label}
                  theme={theme}
                  label={item.label}
                  colour={item.ready ? palette.ok : palette.idle}
                  dot={item.ready}
                />
              ))}
            </View>
            {needsVaultWarning ? (
              <AlertRow
                theme={theme}
                testID="factory-panel-store-release-vault-warning"
                colour={palette.wait}
                title={`Missing Vault keys for ${platformLabels.join(" / ")}`}
                wide={wide}
                actions={
                  !mobile && onOpenSettings !== undefined ? (
                    <Btn
                      theme={theme}
                      small
                      variant="secondary"
                      icon="Settings"
                      testID="factory-panel-store-release-open-vault-settings"
                      label="Open Vault Settings"
                      onPress={onOpenSettings}
                    />
                  ) : undefined
                }
              >
                <Text style={text(theme, "meta")}>
                  {`Missing: ${missingKeys.join(", ")}. Import them in Factory Settings → Vault.`}
                </Text>
              </AlertRow>
            ) : null}
          </StoreReleaseRow>

          {storeRelease.activeHole !== null ? (
            <AlertRow
              theme={theme}
              testID="factory-panel-store-release-hole"
              colour={palette.wait}
              title={`Active Hole · ${storeRelease.activeHole.kind}`}
              wide={wide}
            >
              <Text style={text(theme, "meta")}>
                {`Phase ${storeRelease.activeHole.phase} · Run ${storeRelease.activeHole.runId} · paused ${formatRelativeAgo(storeRelease.activeHole.pausedAt, now)}`}
              </Text>
              <Text style={text(theme, "meta")}>Resolve in Supervisor chat or Release Lab.</Text>
            </AlertRow>
          ) : null}

          {!storeRelease.isMobile ? (
            <StoreReleaseRow theme={theme} wide={wide} label="Latest store run" testID="factory-panel-store-release-last">
              <LatestRunDetail
                theme={theme}
                palette={palette}
                lastRun={storeRelease.lastRun}
                now={now}
              />
            </StoreReleaseRow>
          ) : null}

          {!storeRelease.isMobile && !mobile ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
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
            </View>
          ) : null}
        </View>
      ) : null}

      {mobile && (storeRelease.isMobile || expanded) ? (
        <Text testID="factory-panel-store-release-open-lab" style={text(theme, "meta")}>
          Open Release Lab on Paseo Desktop.
        </Text>
      ) : null}
    </Card>
  );
}
