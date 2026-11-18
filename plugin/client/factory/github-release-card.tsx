/**
 * "GitHub & Release" card on the Project panel's Project tab (v0.14.0, ADR 0061).
 * Pure React Native component: displays Origin status, gh auth guide when
 * unauthenticated, Release mode (desktop selector), Release branch (desktop
 * selector when origin exists, disabled hint without origin), Last Release, and
 * one-time GitHub Publish form when no origin exists on desktop.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GitHubPublishPreflightView, ReleaseMode, ReleaseSettingsView } from "../../shared/view.ts";
import { Btn, Pill } from "../kit/pill.tsx";
import { CONTROL_SM, RADIUS, SPACING, hoveredOf, text, tint } from "../kit/theme.ts";

export const GH_LOGIN_CMD = "gh auth login --web -p https";

export const RELEASE_MODES: readonly ReleaseMode[] = ["off", "on-request", "auto"];

export const RELEASE_MODE_MEANINGS: Record<ReleaseMode, string> = {
  off: "Releases disabled — Lead never tags or publishes.",
  "on-request": "Lead releases only after an explicit dispatch request.",
  auto: "Lead releases automatically when product changes land.",
};

export interface ReleaseCardFeedback {
  text: string;
  tone: "info" | "error";
}

export interface GitHubPublishSubmitInput {
  owner: string;
  name: string;
  description?: string;
  visibility: "private" | "public";
  confirmPublicName?: string;
  allowSensitiveFiles?: boolean;
}

export interface GitHubReleaseActions {
  setMode?: (mode: ReleaseMode) => void | Promise<void>;
  setBranch?: (branch: string | null) => void | Promise<void>;
  publish?: (input: GitHubPublishSubmitInput) => void | Promise<void>;
  openUrl?: (url: string) => void;
  copyLoginCommand?: () => void;
  checkLogin?: () => void | Promise<void>;
}

function releaseAgoOf(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function ChoiceChip({
  theme,
  testID,
  label,
  selected,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  testID: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const accent = theme.colors.accent;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => ({
        minHeight: CONTROL_SM,
        paddingHorizontal: SPACING[2.5],
        paddingVertical: 4,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: selected ? accent : hoveredOf(state) ? theme.colors.foregroundMuted : theme.colors.border,
        backgroundColor: selected ? tint(accent, "1f") : theme.colors.surface1,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text
        style={{
          ...text(theme, "label"),
          color: selected ? accent : theme.colors.foreground,
          fontWeight: selected ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function GitHubPublishForm({
  theme,
  release,
  preflight,
  busy,
  onPublish,
}: {
  theme: PluginTheme;
  release: ReleaseSettingsView;
  preflight: GitHubPublishPreflightView | null;
  busy: boolean;
  onPublish: (input: GitHubPublishSubmitInput) => void | Promise<void>;
}) {
  const fallbackOwner = release.gh.user ?? "";
  const defaultOwner = preflight?.defaultOwner ?? preflight?.owners[0] ?? fallbackOwner;
  const defaultName = preflight?.defaultName ?? release.project;

  const [owner, setOwner] = useState(defaultOwner);
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [confirmPublicName, setConfirmPublicName] = useState("");
  const [allowSensitive, setAllowSensitive] = useState(false);

  useEffect(() => {
    if (owner === "" && defaultOwner !== "") setOwner(defaultOwner);
  }, [defaultOwner, owner]);

  useEffect(() => {
    if (name === "" && defaultName !== "") setName(defaultName);
  }, [defaultName, name]);

  if (!release.gh.authenticated) {
    return (
      <View testID="factory-panel-github-publish" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Publish to GitHub</Text>
        <Text style={text(theme, "meta")}>Sign in with GitHub CLI above before publishing this folder.</Text>
      </View>
    );
  }

  const owners = preflight?.owners ?? (defaultOwner ? [defaultOwner] : []);
  const sensitiveFiles = preflight?.sensitiveFiles ?? [];
  const trimmedOwner = owner.trim();
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const isPublic = visibility === "public";
  const needsPublicConfirm = isPublic && confirmPublicName.trim() !== trimmedName;
  const needsSensitiveAck = isPublic && sensitiveFiles.length > 0 && !allowSensitive;
  const canSubmit = !busy && trimmedOwner !== "" && trimmedName !== "" && !needsPublicConfirm && !needsSensitiveAck;

  const fieldStyle = {
    minHeight: CONTROL_SM,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: RADIUS.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: SPACING[2],
    justifyContent: "center" as const,
  };

  return (
    <View
      testID="factory-panel-github-publish"
      style={{
        gap: SPACING[2],
        padding: SPACING[2.5],
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: RADIUS.lg,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={text(theme, "rowTitle")}>Publish to GitHub</Text>

      <View testID="factory-panel-github-publish-owner" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Owner</Text>
        {owners.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
            {owners.map((candidate) => (
              <ChoiceChip
                key={candidate}
                theme={theme}
                testID={`factory-panel-github-publish-owner-${candidate}`}
                label={candidate}
                selected={trimmedOwner === candidate}
                disabled={busy}
                onPress={() => setOwner(candidate)}
              />
            ))}
          </View>
        ) : (
          <View style={fieldStyle}>
            <TextInput
              value={owner}
              onChangeText={setOwner}
              placeholder="GitHub user or organization"
              style={text(theme, "label")}
            />
          </View>
        )}
      </View>

      <View style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Repository name</Text>
        <View style={fieldStyle}>
          <TextInput
            testID="factory-panel-github-publish-name"
            value={name}
            onChangeText={setName}
            placeholder={defaultName}
            style={text(theme, "label")}
          />
        </View>
      </View>

      <View style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Description (optional)</Text>
        <View style={fieldStyle}>
          <TextInput
            testID="factory-panel-github-publish-description"
            value={description}
            onChangeText={setDescription}
            placeholder="Short repository description"
            style={text(theme, "label")}
          />
        </View>
      </View>

      <View testID="factory-panel-github-publish-visibility" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Visibility</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <ChoiceChip
            theme={theme}
            testID="factory-panel-github-publish-visibility-private"
            label="Private"
            selected={visibility === "private"}
            disabled={busy}
            onPress={() => {
              setVisibility("private");
              setConfirmPublicName("");
              setAllowSensitive(false);
            }}
          />
          <ChoiceChip
            theme={theme}
            testID="factory-panel-github-publish-visibility-public"
            label="Public"
            selected={visibility === "public"}
            disabled={busy}
            onPress={() => setVisibility("public")}
          />
        </View>
      </View>

      {isPublic && sensitiveFiles.length > 0 ? (
        <View
          testID="factory-panel-github-publish-sensitive"
          style={{
            gap: SPACING[1],
            padding: SPACING[2],
            borderWidth: 1,
            borderColor: theme.colors.statusWarning,
            borderRadius: RADIUS.md,
            backgroundColor: tint(theme.colors.statusWarning, "14"),
          }}
        >
          <Text style={text(theme, "label", "statusWarning")}>
            {`Tracked sensitive files found: ${sensitiveFiles.join(", ")}`}
          </Text>
          <ChoiceChip
            theme={theme}
            testID="factory-panel-github-publish-sensitive-toggle"
            label={allowSensitive ? "Sensitive files confirmed — include in public push" : "I reviewed these files — allow public publish"}
            selected={allowSensitive}
            disabled={busy}
            onPress={() => setAllowSensitive(!allowSensitive)}
          />
        </View>
      ) : null}

      {isPublic ? (
        <View style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "label", "statusWarning")}>
            {`Type "${trimmedName}" to confirm making this repository Public`}
          </Text>
          <View style={fieldStyle}>
            <TextInput
              testID="factory-panel-github-publish-confirm-name"
              value={confirmPublicName}
              onChangeText={setConfirmPublicName}
              placeholder={trimmedName}
              style={text(theme, "label")}
            />
          </View>
          <Text style={text(theme, "meta")}>
            {preflight?.commitHistoryNotScannedNote ?? "Commit history is not scanned for past secrets — only tracked files at HEAD are checked."}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
        <Btn
          theme={theme}
          small
          variant="primary"
          testID="factory-panel-github-publish-submit"
          label={busy ? "Publishing…" : "Publish to GitHub"}
          disabled={!canSubmit}
          onPress={() =>
            void onPublish({
              owner: trimmedOwner,
              name: trimmedName,
              ...(trimmedDescription !== "" ? { description: trimmedDescription } : {}),
              visibility,
              ...(isPublic ? { confirmPublicName: confirmPublicName.trim() } : {}),
              ...(isPublic && sensitiveFiles.length > 0 ? { allowSensitiveFiles: allowSensitive } : {}),
            })
          }
        />
      </View>
    </View>
  );
}

export function GitHubReleaseCard({
  theme,
  release,
  publishPreflight = null,
  mobile,
  now,
  busy = false,
  feedback = null,
  copiedLogin = false,
  actions = {},
}: {
  theme: PluginTheme;
  release: ReleaseSettingsView;
  publishPreflight?: GitHubPublishPreflightView | null;
  mobile: boolean;
  now: number;
  busy?: boolean;
  feedback?: ReleaseCardFeedback | null;
  copiedLogin?: boolean;
  actions?: GitHubReleaseActions;
}) {
  const originLabel =
    release.origin === null
      ? "Not on GitHub"
      : release.origin.slug ?? release.origin.remoteUrl;
  const visibilityLabel =
    release.origin?.visibility === "private"
      ? "Private"
      : release.origin?.visibility === "public"
        ? "Public"
        : null;
  const resolvedBranch = release.resolvedBranch ?? release.defaultBranch ?? null;
  const isDefaultBranch =
    release.branch === null || (release.defaultBranch !== null && release.branch === release.defaultBranch);

  const modeInteractive = !mobile && actions.setMode !== undefined;
  const branchInteractive = !mobile && release.origin !== null && actions.setBranch !== undefined;

  const branchOptions: string[] = [];
  for (const candidate of [release.defaultBranch, resolvedBranch, ...release.branchCandidates]) {
    if (candidate !== null && candidate !== undefined && candidate.trim() !== "" && !branchOptions.includes(candidate)) {
      branchOptions.push(candidate);
    }
  }

  return (
    <View
      testID="factory-panel-github-release"
      style={{
        gap: SPACING[2.5],
        marginTop: SPACING[4],
        paddingTop: SPACING[4],
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      }}
    >
      <Text style={{ ...text(theme, "badge"), textTransform: "uppercase" }}>GitHub & Release</Text>

      <View testID="factory-panel-github-origin" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Origin</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
          <Text style={text(theme, "rowTitle")}>{originLabel}</Text>
          {visibilityLabel !== null ? (
            <Pill
              theme={theme}
              label={visibilityLabel}
              tone={release.origin?.visibility === "public" ? "statusWarning" : "foregroundMuted"}
              lit={release.origin?.visibility === "public"}
            />
          ) : null}
        </View>
        {release.origin === null ? (
          <Text style={text(theme, "meta")}>No origin remote configured.</Text>
        ) : null}
      </View>

      {!release.gh.authenticated ? (
        <View
          testID="factory-panel-github-login-guide"
          style={{
            gap: SPACING[1.5],
            padding: SPACING[2.5],
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
            <Icon name="Shield" size={14} color={theme.colors.statusWarning} />
            <Pill
              theme={theme}
              label={release.gh.installed ? "GitHub Login Required" : "Install GitHub CLI (gh)"}
              tone="statusWarning"
              lit
            />
            <Text style={text(theme, "meta")}>Run</Text>
            <Pill theme={theme} label={GH_LOGIN_CMD} mono />
          </View>
          {!mobile && (actions.copyLoginCommand !== undefined || actions.checkLogin !== undefined) ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
              {actions.copyLoginCommand !== undefined ? (
                <Btn
                  theme={theme}
                  small
                  icon="Copy"
                  label={copiedLogin ? "Copied!" : "Copy Command"}
                  tone="foregroundMuted"
                  onPress={actions.copyLoginCommand}
                />
              ) : null}
              {actions.checkLogin !== undefined ? (
                <Btn
                  theme={theme}
                  small
                  solid
                  icon="RefreshCw"
                  label="Check GitHub Login"
                  tone="accent"
                  disabled={busy}
                  onPress={() => void actions.checkLogin?.()}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {release.origin === null && !mobile && actions.publish !== undefined ? (
        <GitHubPublishForm
          theme={theme}
          release={release}
          preflight={publishPreflight}
          busy={busy}
          onPublish={actions.publish}
        />
      ) : null}

      <View testID="factory-panel-release-mode" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Release mode</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
          {modeInteractive ? (
            RELEASE_MODES.map((m) => (
              <ChoiceChip
                key={m}
                theme={theme}
                testID={`factory-panel-release-mode-${m}`}
                label={m}
                selected={release.mode === m}
                disabled={busy}
                onPress={() => {
                  if (m !== release.mode) void actions.setMode?.(m);
                }}
              />
            ))
          ) : (
            <Pill
              theme={theme}
              label={release.mode}
              tone={release.mode === "off" ? "foregroundMuted" : "accent"}
              lit={release.mode !== "off"}
            />
          )}
          {release.pendingRequest !== null ? (
            <Pill
              theme={theme}
              label={
                release.pendingRequest.version
                  ? `Pending request: v${release.pendingRequest.version}`
                  : "Pending request"
              }
              tone="statusWarning"
              lit
            />
          ) : null}
        </View>
        <Text style={text(theme, "meta")}>{RELEASE_MODE_MEANINGS[release.mode]}</Text>
      </View>

      <View testID="factory-panel-release-branch" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Release branch</Text>
        {release.origin === null ? (
          <Text style={text(theme, "meta")}>Default unavailable — configure a GitHub origin first to choose a Release branch.</Text>
        ) : branchInteractive && branchOptions.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
            {branchOptions.map((candidate) => {
              const isSelected = resolvedBranch === candidate;
              const isDefault = release.defaultBranch !== null && candidate === release.defaultBranch;
              return (
                <ChoiceChip
                  key={candidate}
                  theme={theme}
                  testID={`factory-panel-release-branch-option-${candidate}`}
                  label={isDefault ? `${candidate} (default)` : candidate}
                  selected={isSelected}
                  disabled={busy}
                  onPress={() => {
                    if (isDefault && release.branch !== null) {
                      void actions.setBranch?.(null);
                    } else if (!isSelected) {
                      void actions.setBranch?.(candidate);
                    }
                  }}
                />
              );
            })}
            {release.branch !== null && release.defaultBranch !== null ? (
              <Btn
                theme={theme}
                small
                variant="ghost"
                testID="factory-panel-release-branch-reset"
                label="Use default"
                disabled={busy}
                onPress={() => void actions.setBranch?.(null)}
              />
            ) : null}
          </View>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
            <Text style={text(theme, "rowTitle")}>{resolvedBranch ?? "main"}</Text>
            <Pill theme={theme} label={isDefaultBranch ? "default" : "override"} />
          </View>
        )}
      </View>

      {feedback !== null ? (
        <Text
          testID="factory-panel-release-feedback"
          style={text(theme, "label", feedback.tone === "error" ? "statusDanger" : "statusWarning")}
        >
          {feedback.text}
        </Text>
      ) : null}

      <View testID="factory-panel-release-last" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Last Release</Text>
        {release.lastRelease === null ? (
          <Text style={text(theme, "meta")}>No releases yet</Text>
        ) : (
          <View style={{ gap: SPACING[0.5] }}>
            <Text style={text(theme, "rowTitle")}>
              {`${release.lastRelease.tag} · ${release.lastRelease.commit.slice(0, 7)} · ${release.lastRelease.branch} · ${releaseAgoOf(release.lastRelease.ts, now)}`}
            </Text>
            {release.lastRelease.url !== null ? (
              actions.openUrl !== undefined && !mobile ? (
                <Pressable onPress={() => actions.openUrl?.(release.lastRelease!.url!)}>
                  <Text style={text(theme, "meta", "accent")}>{release.lastRelease.url}</Text>
                </Pressable>
              ) : (
                <Text style={text(theme, "meta")}>{release.lastRelease.url}</Text>
              )
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}
