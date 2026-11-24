/**
 * "GitHub & Release" card on the Project panel's Project tab (v0.14.0, ADR 0061).
 * Pure React Native component: displays Origin status, gh auth AlertRow when
 * unauthenticated, Release mode (desktop SegmentedControl), Release branch
 * (desktop ChoiceChips / collapsible drawer when > 2 candidates, disabled hint
 * without origin), Last Release, and one-time GitHub Publish Modal when no
 * origin exists on authenticated desktop.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { GitHubPublishPreflightView, ReleaseMode, ReleaseSettingsView } from "../../shared/view.ts";
import { AlertRow, Btn, Card, ChoiceChip, SegmentedControl, ToneBadge, formatRelativeAgo } from "../kit/pill.tsx";
import { CONTROL_SM, RADIUS, SPACING, factoryPalette, text } from "../kit/theme.ts";

export const GH_LOGIN_CMD = "gh auth login --web -p https";

export const RELEASE_MODES: readonly ReleaseMode[] = ["off", "on-request", "auto"];

export const RELEASE_MODE_MEANINGS: Record<ReleaseMode, string> = {
  off: "Releases disabled — Lead never tags or publishes.",
  "on-request": "Lead releases only after an explicit dispatch request.",
  auto: "Lead releases automatically when product changes land.",
};

export interface ReleaseCardFeedback {
  text: string;
  tone: "info" | "success" | "error";
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
  publish?: (input: GitHubPublishSubmitInput) => void | boolean | Promise<void | boolean>;
  openUrl?: (url: string) => void;
  copyLoginCommand?: () => void;
  checkLogin?: () => void | Promise<void>;
}

type FactoryPalette = ReturnType<typeof factoryPalette>;

function modeToneColour(palette: FactoryPalette, mode: ReleaseMode): string {
  if (mode === "auto") return palette.ok;
  if (mode === "on-request") return palette.lead;
  return palette.idle;
}

function feedbackColour(palette: FactoryPalette, tone: ReleaseCardFeedback["tone"]): string {
  if (tone === "error") return palette.bad;
  if (tone === "success") return palette.ok;
  return palette.wait;
}

function KeyValueRow({
  theme,
  label,
  wide,
  testID,
  children,
}: {
  theme: PluginTheme;
  label: string;
  wide: boolean;
  testID?: string;
  children: ReactNode;
}) {
  if (wide) {
    return (
      <View
        {...(testID === undefined ? {} : { testID })}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACING[3] }}
      >
        <Text style={{ ...text(theme, "label"), width: 124, flexShrink: 0, paddingTop: 2 }}>{label}</Text>
        <View style={{ flex: 1, minWidth: 0, gap: SPACING[1] }}>{children}</View>
      </View>
    );
  }
  return (
    <View {...(testID === undefined ? {} : { testID })} style={{ gap: SPACING[1] }}>
      <Text style={text(theme, "label")}>{label}</Text>
      <View style={{ gap: SPACING[1] }}>{children}</View>
    </View>
  );
}

function GitHubPublishForm({
  theme,
  release,
  preflight,
  busy,
  modalError,
  onCancel,
  onPublish,
}: {
  theme: PluginTheme;
  release: ReleaseSettingsView;
  preflight: GitHubPublishPreflightView | null;
  busy: boolean;
  modalError: string | null;
  onCancel: () => void;
  onPublish: (input: GitHubPublishSubmitInput) => void | boolean | Promise<void | boolean>;
}) {
  const palette = factoryPalette(theme);
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
    <View testID="factory-panel-github-publish" style={{ gap: SPACING[2.5] }}>
      <View testID="factory-panel-github-publish-owner" style={{ gap: SPACING[1] }}>
        <Text style={text(theme, "label")}>Owner</Text>
        {owners.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
            {owners.map((candidate) => (
              <ChoiceChip
                key={candidate}
                theme={theme}
                testID={`factory-panel-github-publish-owner-${candidate}`}
                accentColour={palette.lead}
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
            accentColour={palette.lead}
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
            accentColour={palette.lead}
            label="Public"
            selected={visibility === "public"}
            disabled={busy}
            onPress={() => setVisibility("public")}
          />
        </View>
      </View>

      {isPublic && sensitiveFiles.length > 0 ? (
        <AlertRow
          theme={theme}
          testID="factory-panel-github-publish-sensitive"
          colour={palette.wait}
          title={`Tracked sensitive files found: ${sensitiveFiles.join(", ")}`}
          wide={false}
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            <ChoiceChip
              theme={theme}
              testID="factory-panel-github-publish-sensitive-toggle"
              accentColour={palette.lead}
              label={allowSensitive ? "Sensitive files confirmed — include in public push" : "I reviewed these files — allow public publish"}
              selected={allowSensitive}
              disabled={busy}
              onPress={() => setAllowSensitive(!allowSensitive)}
            />
          </View>
        </AlertRow>
      ) : null}

      {isPublic ? (
        <View style={{ gap: SPACING[1] }}>
          <Text style={{ ...text(theme, "label"), color: palette.wait }}>
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

      {modalError !== null ? (
        <Text
          testID="factory-panel-release-feedback"
          style={{ ...text(theme, "label"), color: palette.bad }}
        >
          {modalError}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: SPACING[1.5] }}>
        <Btn
          theme={theme}
          small
          variant="ghost"
          label="Cancel"
          disabled={busy}
          onPress={onCancel}
        />
        <Btn
          theme={theme}
          small
          variant="primary"
          accentColour={palette.lead}
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
  wide = false,
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
  wide?: boolean;
  now: number;
  busy?: boolean;
  feedback?: ReleaseCardFeedback | null;
  copiedLogin?: boolean;
  actions?: GitHubReleaseActions;
}) {
  const palette = factoryPalette(theme);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);

  const canPublish = !mobile && release.origin === null && actions.publish !== undefined && release.gh.authenticated;
  const showPublishModal = publishOpen && canPublish;

  useEffect(() => {
    setPublishOpen(false);
    setPublishError(null);
    setBranchOpen(false);
  }, [release.projectRoot]);

  useEffect(() => {
    if (!canPublish && publishOpen) {
      setPublishOpen(false);
      setPublishError(null);
    }
  }, [canPublish, publishOpen]);

  const handlePublish = async (input: GitHubPublishSubmitInput) => {
    if (actions.publish === undefined) return;
    setPublishError(null);
    try {
      const outcome = await actions.publish(input);
      if (outcome === false) return;
      setPublishOpen(false);
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : String(error));
    }
  };

  const modeColour = modeToneColour(palette, release.mode);
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

  const loginActions =
    !mobile && (actions.copyLoginCommand !== undefined || actions.checkLogin !== undefined) ? (
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
        {actions.copyLoginCommand !== undefined ? (
          <Btn
            theme={theme}
            small
            variant="secondary"
            icon="Copy"
            label={copiedLogin ? "Copied!" : "Copy Command"}
            onPress={actions.copyLoginCommand}
          />
        ) : null}
        {actions.checkLogin !== undefined ? (
          <Btn
            theme={theme}
            small
            variant="primary"
            accentColour={palette.lead}
            icon="RefreshCw"
            label="Check GitHub Login"
            disabled={busy}
            onPress={() => void actions.checkLogin?.()}
          />
        ) : null}
      </View>
    ) : undefined;

  const renderBranchChip = (candidate: string) => {
    const isSelected = resolvedBranch === candidate;
    const isDefault = release.defaultBranch !== null && candidate === release.defaultBranch;
    return (
      <ChoiceChip
        key={candidate}
        theme={theme}
        testID={`factory-panel-release-branch-option-${candidate}`}
        accentColour={palette.lead}
        label={isDefault ? `${candidate} (default)` : candidate}
        selected={isSelected}
        disabled={busy}
        onPress={() => {
          if (isDefault && release.branch !== null) {
            void actions.setBranch?.(null);
          } else if (!isSelected) {
            void actions.setBranch?.(candidate);
          }
          setBranchOpen(false);
        }}
      />
    );
  };

  const resetBranchBtn =
    release.branch !== null && release.defaultBranch !== null ? (
      <Btn
        theme={theme}
        small
        variant="ghost"
        testID="factory-panel-release-branch-reset"
        label="Use default"
        disabled={busy}
        onPress={() => {
          setBranchOpen(false);
          void actions.setBranch?.(null);
        }}
      />
    ) : null;

  const modalError = feedback?.tone === "error" ? feedback.text : publishError;

  return (
    <Card theme={theme} testID="factory-panel-github-release">
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
        <Text style={{ ...text(theme, "badge"), textTransform: "uppercase" }}>GitHub & Release</Text>
        <ToneBadge theme={theme} label={release.mode} colour={modeColour} dot={release.mode !== "off"} />
      </View>

      {!release.gh.authenticated ? (
        <AlertRow
          theme={theme}
          testID="factory-panel-github-login-guide"
          colour={palette.wait}
          title={release.gh.installed ? "GitHub Login Required" : "Install GitHub CLI (gh)"}
          wide={wide}
          {...(loginActions === undefined ? {} : { actions: loginActions })}
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
            <Text style={text(theme, "meta")}>Run</Text>
            <View
              style={{
                paddingHorizontal: SPACING[2],
                paddingVertical: 2,
                borderRadius: RADIUS.sm,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <Text style={text(theme, "code")}>{GH_LOGIN_CMD}</Text>
            </View>
          </View>
        </AlertRow>
      ) : null}

      <KeyValueRow theme={theme} label="Origin" wide={wide} testID="factory-panel-github-origin">
        {release.origin !== null ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
            <Text style={text(theme, "rowTitle")}>{originLabel}</Text>
            {visibilityLabel !== null ? (
              <ToneBadge
                theme={theme}
                label={visibilityLabel}
                colour={release.origin?.visibility === "public" ? palette.wait : palette.idle}
                dot={false}
              />
            ) : null}
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[2] }}>
              <Text style={text(theme, "rowTitle")}>{originLabel}</Text>
              {canPublish ? (
                <Btn
                  theme={theme}
                  small
                  variant="primary"
                  accentColour={palette.lead}
                  testID="factory-panel-github-publish-open"
                  label="Publish to GitHub…"
                  disabled={busy}
                  onPress={() => {
                    setPublishError(null);
                    setPublishOpen(true);
                  }}
                />
              ) : null}
            </View>
            <Text style={text(theme, "meta")}>No origin remote configured.</Text>
          </>
        )}
      </KeyValueRow>

      {showPublishModal ? (
        <Modal
          open
          onOpenChange={(next) => {
            setPublishOpen(next);
            if (!next) setPublishError(null);
          }}
          title="Publish to GitHub"
        >
          <Modal.Content>
            <GitHubPublishForm
              theme={theme}
              release={release}
              preflight={publishPreflight}
              busy={busy}
              modalError={modalError}
              onCancel={() => {
                setPublishOpen(false);
                setPublishError(null);
              }}
              onPublish={handlePublish}
            />
          </Modal.Content>
        </Modal>
      ) : null}

      <KeyValueRow theme={theme} label="Release mode" wide={wide} testID="factory-panel-release-mode">
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
          {modeInteractive ? (
            <SegmentedControl
              theme={theme}
              size="sm"
              optionTestIDPrefix="factory-panel-release-mode"
              value={release.mode}
              disabled={busy}
              onChange={(nextMode) => {
                if (nextMode !== release.mode) void actions.setMode?.(nextMode);
              }}
              options={[
                { value: "off", label: "off", accentColour: palette.idle },
                { value: "on-request", label: "on-request", accentColour: palette.lead },
                { value: "auto", label: "auto", accentColour: palette.ok },
              ]}
            />
          ) : (
            <ToneBadge theme={theme} label={release.mode} colour={modeColour} dot={release.mode !== "off"} />
          )}
          {release.pendingRequest !== null ? (
            <ToneBadge
              theme={theme}
              label={
                release.pendingRequest.version
                  ? `Pending request: v${release.pendingRequest.version}`
                  : "Pending request"
              }
              colour={palette.wait}
            />
          ) : null}
        </View>
        <Text style={text(theme, "meta")}>{RELEASE_MODE_MEANINGS[release.mode]}</Text>
      </KeyValueRow>

      <KeyValueRow theme={theme} label="Release branch" wide={wide} testID="factory-panel-release-branch">
        {release.origin === null ? (
          <Text style={text(theme, "meta")}>Default unavailable — configure a GitHub origin first to choose a Release branch.</Text>
        ) : branchInteractive && branchOptions.length > 0 ? (
          branchOptions.length <= 2 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
              {branchOptions.map(renderBranchChip)}
              {resetBranchBtn}
            </View>
          ) : (
            <View style={{ gap: SPACING[1.5] }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
                <Text style={text(theme, "rowTitle")}>{resolvedBranch ?? "main"}</Text>
                <ToneBadge
                  theme={theme}
                  label={isDefaultBranch ? "default" : "override"}
                  colour={isDefaultBranch ? palette.idle : palette.lead}
                  dot={false}
                />
                <Btn
                  theme={theme}
                  small
                  variant="ghost"
                  testID="factory-panel-release-branch-toggle"
                  label={branchOpen ? "Hide ▴" : "Change ▾"}
                  disabled={busy}
                  onPress={() => setBranchOpen(!branchOpen)}
                />
                {resetBranchBtn}
              </View>
              {branchOpen ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
                  {branchOptions.map(renderBranchChip)}
                </View>
              ) : null}
            </View>
          )
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
            <Text style={text(theme, "rowTitle")}>{resolvedBranch ?? "main"}</Text>
            <ToneBadge
              theme={theme}
              label={isDefaultBranch ? "default" : "override"}
              colour={isDefaultBranch ? palette.idle : palette.lead}
              dot={false}
            />
          </View>
        )}
      </KeyValueRow>

      {!showPublishModal && feedback !== null ? (
        <Text
          testID="factory-panel-release-feedback"
          style={{ ...text(theme, "label"), color: feedbackColour(palette, feedback.tone) }}
        >
          {feedback.text}
        </Text>
      ) : null}

      <KeyValueRow theme={theme} label="Last Release" wide={wide} testID="factory-panel-release-last">
        {release.lastRelease === null ? (
          <Text style={text(theme, "meta")}>No releases yet</Text>
        ) : (
          <View style={{ gap: SPACING[0.5] }}>
            <Text style={text(theme, "rowTitle")}>
              {`${release.lastRelease.tag} · ${release.lastRelease.commit.slice(0, 7)} · ${release.lastRelease.branch} · ${formatRelativeAgo(release.lastRelease.ts, now)}`}
            </Text>
            {release.lastRelease.url !== null ? (
              actions.openUrl !== undefined && !mobile ? (
                <Pressable onPress={() => actions.openUrl?.(release.lastRelease!.url!)}>
                  <Text style={{ ...text(theme, "meta"), color: palette.lead }}>{release.lastRelease.url}</Text>
                </Pressable>
              ) : (
                <Text style={text(theme, "meta")}>{release.lastRelease.url}</Text>
              )
            ) : null}
          </View>
        )}
      </KeyValueRow>
    </Card>
  );
}
