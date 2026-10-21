/**
 * The persistent header (ADR 0009 §2; the Project Selector and Lead bridge
 * arrive in v0.0.14, ADR 0010 §1–§2): plain-language headline, freshness
 * dot, the five tabular-num KPI Stat Tiles (Needs Human, Running, Ready to
 * Accept, Accepted, Total Cost), the Project Selector (the panel auto-binds
 * its workspace's Project; the global screen picks across discovered
 * Projects), and the seat states (v0.0.27, ADR 0017 §3) — each seat reports
 * its live status with an Open jump while it lives, or the picker hint while
 * vacant; seats start only from Paseo's native New Chat picker, never from a
 * header button.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import type { FactoryView, VaultStatusView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_H, CONTROL_SM, DOT, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import { GRACE_MS, pollEvery } from "../kit/poll.ts";

export type VaultActName = "Vault Sync" | "Vault Import" | "Vault Configure" | "Vault Hydrate";

const VAULT_ACT_NAMES: ReadonlySet<string> = new Set<VaultActName>([
  "Vault Sync",
  "Vault Import",
  "Vault Configure",
  "Vault Hydrate",
]);

export function isVaultActName(name: string): name is VaultActName {
  return VAULT_ACT_NAMES.has(name);
}

export interface VaultNote {
  text: string;
  tone: "statusSuccess" | "statusDanger";
}

export interface VaultSyncInput {
  repo?: string;
  branch?: string;
  passphrase?: string;
}

export interface VaultImportInput {
  ascKeyPath?: string;
  ascKeyId?: string;
  ascIssuer?: string;
  gplayKeyPath?: string;
  eyeConfigPath?: string;
  appKey?: string;
  keystorePath?: string;
  storePass?: string;
  syncAfterImport?: boolean;
}

/** The header's whole action surface — the Shell owns the RPC calls. */
export interface HeaderActions {
  /** Jump to the live Supervisor's conversation (v0.0.27, ADR 0017 §3) — the seat itself starts from Paseo's native New Chat picker, never here. */
  openSupervisor(): void;
  /** Jump to the live Lead's conversation — the Supervisor spawns the seat via supervisor_dispatch_lead. */
  openLead(): void;
  /** The Project Selector's pick — null returns to the unscoped global view. */
  pickProject(root: string | null): void;
  /** Owner-only clean-slate reset of the selected Project (v0.0.24, ADR 0015 §6). */
  resetProject(): void;
  busy: boolean;
}


function VaultField({
  theme,
  label,
  value,
  onChange,
  placeholder,
  secure = false,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  secure?: boolean;
}) {
  return (
    <View style={{ flexBasis: 200, flexGrow: 1, gap: SPACING[0.5] }}>
      <Text style={text(theme, "label")}>{label}</Text>
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
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          secureTextEntry={secure}
          style={{ paddingHorizontal: SPACING[2], paddingVertical: 4, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
        />
      </View>
    </View>
  );
}

/**
 * Built-in Header Cloud Vault Sync Bar (v0.0.22, ADR 0014 §1–§5):
 * Renders across all tabs inside `<Header />` with a 3-state guided flow:
 * 1. `!vault.configured && !vault.ghAuthenticated`: guided 2-step `gh auth login --web -p https` banner.
 * 2. `!vault.configured && vault.ghAuthenticated`: `@<ghUser>` greeting + `<ghUser>/factory-vault` + 1-click `Enable & Sync Vault`.
 * 3. `vault.configured`: `Vault: <repo>` + readiness pills + `Sync Vault` + `+ Import Key` & `⚙` drawers.
 */
export function VaultSyncBar({
  theme,
  vault,
  busy,
  busyAct,
  vaultNote,
  onVaultSync,
  onVaultImport,
  onVaultConfigure,
  onVaultHydrate,
  onRefresh,
}: {
  theme: PluginTheme;
  vault: VaultStatusView;
  busy: boolean;
  busyAct: string | null;
  vaultNote: VaultNote | null;
  onVaultSync: (input?: VaultSyncInput) => void;
  onVaultImport: (input: VaultImportInput) => void;
  onVaultConfigure: (input: { repo: string; branch: string; passphrase?: string }) => void;
  onVaultHydrate: (repo?: string, ref?: string) => void;
  onRefresh: () => void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const [ascKeyPath, setAscKeyPath] = useState("");
  const [ascKeyId, setAscKeyId] = useState("");
  const [ascIssuer, setAscIssuer] = useState("");
  const [gplayKeyPath, setGplayKeyPath] = useState("");
  const [eyeConfigPath, setEyeConfigPath] = useState("");
  const [appKey, setAppKey] = useState("");
  const [keystorePath, setKeystorePath] = useState("");
  const [storePass, setStorePass] = useState("");

  const [repo, setRepo] = useState(vault.repo ?? vault.suggestedRepo ?? "");
  const [branch, setBranch] = useState(vault.branch || "main");
  const [passphrase, setPassphrase] = useState("");

  const loginCmd = "gh auth login --web -p https";
  const copyLoginCommand = (): void => {
    const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard;
    if (clip?.writeText !== undefined) {
      void clip.writeText(loginCmd);
    }
    setCopied(true);
  };

  const syncing = busyAct === "Vault Sync";
  const importing = busyAct === "Vault Import";
  const suggestedRepo = vault.suggestedRepo ?? (vault.ghUser !== null ? `${vault.ghUser}/factory-vault` : "owner/factory-vault");
  const lastSyncStamp = vault.lastPushedAt ?? vault.lastHydratedAt;
  const syncAgeSeconds =
    lastSyncStamp !== null && !Number.isNaN(Date.parse(lastSyncStamp))
      ? Math.max(0, Math.round((Date.now() - Date.parse(lastSyncStamp)) / 1000))
      : null;
  const trimmedRepo = repo.trim();
  const trimmedBranch = branch.trim();
  const trimmedPassphrase = passphrase.trim();

  const pills: ReadonlyArray<{ label: string; lit: boolean }> = [
    { label: "ASC .p8", lit: vault.sharedSecrets.ascKey },
    { label: "GPlay JSON", lit: vault.sharedSecrets.gplayServiceAccount },
    { label: "Eye", lit: vault.sharedSecrets.eyeConfig },
    { label: "Lanes", lit: vault.configured },
    { label: `Apps: ${vault.hydratedApps.length}`, lit: vault.hydratedApps.length > 0 },
  ];

  return (
    <Card theme={theme} gap={SPACING[2]}>
      {!vault.configured && !vault.ghAuthenticated ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
            <Icon name="Shield" size={14} color={theme.colors.statusWarning} />
            <Text style={text(theme, "badge")}>PRIVATE VAULT</Text>
            <Pill theme={theme} label={vault.ghInstalled ? "GitHub Login Required" : "Install GitHub CLI (gh)"} tone="statusWarning" lit />
            <Text style={text(theme, "meta")}>Step 1: Run</Text>
            <Pill theme={theme} label={loginCmd} mono />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Btn theme={theme} small icon="Copy" label={copied ? "Copied!" : "Copy Command"} tone="foregroundMuted" onPress={copyLoginCommand} />
            <Btn theme={theme} small solid icon="RefreshCw" label="Check GitHub Login" tone="accent" disabled={busy} onPress={onRefresh} />
            <Btn
              theme={theme}
              small
              label="⚙"
              tone="foregroundMuted"
              onPress={() => {
                setSettingsOpen((v) => !v);
                setImportOpen(false);
              }}
            />
          </View>
        </View>
      ) : null}

      {!vault.configured && vault.ghAuthenticated ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
            <Icon name="Shield" size={14} color={theme.colors.accent} />
            <Text style={text(theme, "badge")}>PRIVATE VAULT</Text>
            <Pill theme={theme} label={`@${vault.ghUser ?? "github"}`} tone="statusSuccess" lit mono />
            <Text style={text(theme, "meta")}>Ready to provision private vault</Text>
            <Pill theme={theme} label={suggestedRepo} mono />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Btn
              theme={theme}
              small
              solid
              icon="RefreshCw"
              label={syncing ? "Setting up & Syncing…" : "Enable & Sync Vault"}
              tone="accent"
              disabled={busy}
              onPress={() => onVaultSync({ repo: suggestedRepo })}
            />
            <Btn
              theme={theme}
              small
              label="+ Import Key"
              tone="foregroundMuted"
              disabled={busy}
              onPress={() => {
                setImportOpen((v) => !v);
                setSettingsOpen(false);
              }}
            />
            <Btn
              theme={theme}
              small
              label="⚙"
              tone="foregroundMuted"
              onPress={() => {
                setSettingsOpen((v) => !v);
                setImportOpen(false);
              }}
            />
          </View>
        </View>
      ) : null}

      {vault.configured ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
            <Icon name="Shield" size={14} color={theme.colors.statusSuccess} />
            <Text style={text(theme, "badge")}>{`Vault: ${vault.repo ?? "—"}`}</Text>
            {pills.map((pill) => (
              <Pill key={pill.label} theme={theme} label={pill.label} tone={pill.lit ? "statusSuccess" : "foregroundMuted"} lit={pill.lit} />
            ))}
            {vault.hasPassphrase ? <Pill theme={theme} label="Passphrase" tone="accent" lit /> : null}
            <Text style={text(theme, "meta")}>
              {syncAgeSeconds !== null
                ? `synced ${readAgo(syncAgeSeconds)}`
                : lastSyncStamp !== null
                  ? `synced ${lastSyncStamp.slice(0, 19).replace("T", " ")}`
                  : "not synced yet"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Btn
              theme={theme}
              small
              solid
              icon="RefreshCw"
              label={syncing ? "Syncing Vault…" : "Sync Vault"}
              tone="accent"
              disabled={busy}
              onPress={() => onVaultSync({})}
            />
            <Btn
              theme={theme}
              small
              label="+ Import Key"
              tone="foregroundMuted"
              disabled={busy}
              onPress={() => {
                setImportOpen((v) => !v);
                setSettingsOpen(false);
              }}
            />
            <Btn
              theme={theme}
              small
              label="⚙"
              tone="foregroundMuted"
              onPress={() => {
                setSettingsOpen((v) => !v);
                setImportOpen(false);
              }}
            />
          </View>
        </View>
      ) : null}

      {vaultNote !== null ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: tint(theme.colors[vaultNote.tone], "66"),
            borderRadius: RADIUS.md,
            backgroundColor: tint(theme.colors[vaultNote.tone], "12"),
            paddingHorizontal: SPACING[2.5],
            paddingVertical: SPACING[1.5],
          }}
        >
          <Text style={text(theme, "label", vaultNote.tone)}>{vaultNote.text}</Text>
        </View>
      ) : null}

      {vault.error !== null ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: tint(theme.colors.statusDanger, "66"),
            borderRadius: RADIUS.md,
            backgroundColor: tint(theme.colors.statusDanger, "12"),
            paddingHorizontal: SPACING[2.5],
            paddingVertical: SPACING[1.5],
          }}
        >
          <Text style={text(theme, "label", "statusDanger")}>{vault.error}</Text>
        </View>
      ) : null}

      {importOpen ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: SPACING[2],
            gap: SPACING[2],
          }}
        >
          <Text style={text(theme, "label")}>Import store credentials into Private Vault (`0o600` under `vault-runtime/secrets/`)</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
            <VaultField theme={theme} label="ASC .p8 Key Path (ascKeyPath)" value={ascKeyPath} onChange={setAscKeyPath} placeholder="~/Downloads/AuthKey_ABC123.p8" />
            <VaultField theme={theme} label="ASC Key ID (ascKeyId)" value={ascKeyId} onChange={setAscKeyId} placeholder="ABC123DEFG" />
            <VaultField theme={theme} label="ASC Issuer ID (ascIssuer)" value={ascIssuer} onChange={setAscIssuer} placeholder="00000000-0000-0000-0000-000000000000" />
            <VaultField theme={theme} label="Google Play JSON Path (gplayKeyPath)" value={gplayKeyPath} onChange={setGplayKeyPath} placeholder="~/Downloads/service-account.json" />
            <VaultField theme={theme} label="Eye Config Path (eyeConfigPath)" value={eyeConfigPath} onChange={setEyeConfigPath} placeholder="~/.paseo-factory/plugin-state/paseo-factory/eye.json" />
            <VaultField theme={theme} label="App Key (appKey)" value={appKey} onChange={setAppKey} placeholder="patigame" />
            <VaultField theme={theme} label="Android Keystore Path (keystorePath)" value={keystorePath} onChange={setKeystorePath} placeholder="~/keys/release.keystore" />
            <VaultField theme={theme} label="Keystore Password (storePass)" value={storePass} onChange={setStorePass} placeholder="optional keystore password" secure />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
            <Btn
              theme={theme}
              small
              solid
              label={importing ? "Importing & Syncing…" : "Import & Sync"}
              tone="accent"
              disabled={busy}
              onPress={() =>
                onVaultImport({
                  ...(ascKeyPath.trim() === "" ? {} : { ascKeyPath: ascKeyPath.trim() }),
                  ...(ascKeyId.trim() === "" ? {} : { ascKeyId: ascKeyId.trim() }),
                  ...(ascIssuer.trim() === "" ? {} : { ascIssuer: ascIssuer.trim() }),
                  ...(gplayKeyPath.trim() === "" ? {} : { gplayKeyPath: gplayKeyPath.trim() }),
                  ...(eyeConfigPath.trim() === "" ? {} : { eyeConfigPath: eyeConfigPath.trim() }),
                  ...(appKey.trim() === "" ? {} : { appKey: appKey.trim() }),
                  ...(keystorePath.trim() === "" ? {} : { keystorePath: keystorePath.trim() }),
                  ...(storePass.trim() === "" ? {} : { storePass: storePass.trim() }),
                  syncAfterImport: true,
                })
              }
            />
            <Btn theme={theme} small label="Close" tone="foregroundMuted" onPress={() => setImportOpen(false)} />
          </View>
        </View>
      ) : null}

      {settingsOpen ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: SPACING[2],
            gap: SPACING[2],
          }}
        >
          <Text style={text(theme, "label")}>
            Advanced Vault Settings (`node: {vault.nodeId}` · `checkout: {vault.cloneExists ? "cached" : "none"}`)
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
            <VaultField theme={theme} label="Repository" value={repo} onChange={setRepo} placeholder={suggestedRepo} />
            <VaultField theme={theme} label="Branch" value={branch} onChange={setBranch} placeholder="main" />
            <VaultField
              theme={theme}
              label="Passphrase (optional)"
              value={passphrase}
              onChange={setPassphrase}
              placeholder={vault.hasPassphrase ? "set — leave blank to keep" : "optional — zero-passphrase default"}
              secure
            />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Btn
              theme={theme}
              small
              solid
              label="Save Config"
              disabled={busy || trimmedRepo === ""}
              onPress={() =>
                onVaultConfigure({
                  repo: trimmedRepo,
                  branch: trimmedBranch === "" ? "main" : trimmedBranch,
                  ...(trimmedPassphrase === "" ? {} : { passphrase: trimmedPassphrase }),
                })
              }
            />
            <Btn
              theme={theme}
              small
              label="Direct Hydrate (gh api)"
              disabled={busy}
              onPress={() => onVaultHydrate(trimmedRepo === "" ? undefined : trimmedRepo, trimmedBranch === "" ? undefined : trimmedBranch)}
            />
            <Btn theme={theme} small label="Close" tone="foregroundMuted" onPress={() => setSettingsOpen(false)} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

type StatKey = "needsHuman" | "running" | "readyToAccept" | "accepted";

const STATS: { key: StatKey; label: string; colour: Colour; icon: string }[] = [
  { key: "needsHuman", label: "Needs Human", colour: "statusWarning", icon: "Bell" },
  { key: "running", label: "Running", colour: "accent", icon: "Play" },
  { key: "readyToAccept", label: "Ready to Accept", colour: "statusSuccess", icon: "CheckCircle2" },
  { key: "accepted", label: "Accepted", colour: "foregroundMuted", icon: "Archive" },
];

function headlineOf(view: FactoryView): string {
  if (view.kpis.needsHuman > 0) return `${view.kpis.needsHuman} task${view.kpis.needsHuman === 1 ? "" : "s"} need${view.kpis.needsHuman === 1 ? "s" : ""} you`;
  if (view.kpis.running > 0) return `${view.kpis.running} under the gate`;
  if (view.kpis.readyToAccept > 0) return `${view.kpis.readyToAccept} green attempt${view.kpis.readyToAccept === 1 ? "" : "s"} await acceptance`;
  if (view.kpis.accepted > 0) return "Everything accepted";
  return "No tasks yet";
}

function readAgo(seconds: number): string {
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function StatTile({
  theme,
  n,
  label,
  colour,
  icon,
  highlight = false,
}: {
  theme: PluginTheme;
  n: number | string;
  label: string;
  colour: string;
  icon: string;
  highlight?: boolean;
}) {
  const lit = highlight || (typeof n === "number" && n > 0);
  return (
    <View
      accessibilityLabel={`${label}: ${n}`}
      style={{
        flex: 1,
        flexBasis: 120,
        minWidth: 120,
        paddingHorizontal: SPACING[3],
        paddingVertical: SPACING[2.5],
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: lit ? tint(colour, "66") : theme.colors.border,
        backgroundColor: lit ? tint(colour, "12") : theme.colors.surface1,
        gap: SPACING[1],
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[1.5] }}>
        <Text style={text(theme, "label")} numberOfLines={1}>
          {label}
        </Text>
        <Icon name={icon} size={13} color={lit ? colour : theme.colors.foregroundMuted} />
      </View>
      <Text
        style={{
          ...text(theme, "stat"),
          fontSize: 22,
          lineHeight: 26,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
          color: lit ? colour : theme.colors.foreground,
        }}
        numberOfLines={1}
      >
        {n}
      </Text>
    </View>
  );
}

/** One selector chip's label — the root's last path segment, falling back to the slug. */
function projectLabel(slug: string, root: string): string {
  const last = root.split("/").filter((segment) => segment !== "");
  return last.length > 0 ? (last[last.length - 1] as string) : slug;
}

/** One standing seat's live state chip (v0.0.27, ADR 0017 §3) — the daemon's own status while the seat lives. */
function SeatState({ theme, name, status }: { theme: PluginTheme; name: string; status: string }) {
  const running = status === "running";
  return <Pill theme={theme} label={`${name}: ${status}`} tone={running ? "accent" : "foregroundMuted"} lit={running} />;
}

export function Header({
  theme,
  view,
  at,
  now,
  actions,
  busyAct = null,
  vaultNote = null,
  onVaultSync = () => {},
  onVaultImport = () => {},
  onVaultConfigure = () => {},
  onVaultHydrate = () => {},
  onRefresh = () => {},
}: {
  theme: PluginTheme;
  view: FactoryView;
  at: number | null;
  now: number;
  actions: HeaderActions;
  busyAct?: string | null;
  vaultNote?: VaultNote | null;
  onVaultSync?: (input?: VaultSyncInput) => void;
  onVaultImport?: (input: VaultImportInput) => void;
  onVaultConfigure?: (input: { repo: string; branch: string; passphrase?: string }) => void;
  onVaultHydrate?: (repo?: string, ref?: string) => void;
  onRefresh?: () => void;
}) {
  const [pickingPath, setPickingPath] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  useEffect(() => {
    if (!confirmingReset) return;
    const timer = setTimeout(() => setConfirmingReset(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmingReset]);
  const busy = view.kpis.running + view.kpis.needsHuman > 0;

  const fresh = at !== null && now - at <= pollEvery(busy) + GRACE_MS;
  const dollars = view.kpis.totalCostUsd > 0 ? `$${view.kpis.totalCostUsd.toFixed(2)}` : "$0";
  const project = view.project;
  const submitPath = (): void => {
    const trimmed = customPath.trim();
    if (trimmed === "") return;
    actions.pickProject(trimmed);
    setPickingPath(false);
  };
  return (
    <View style={{ gap: SPACING[3] }}>
      {/* Top status bar: Headline + Freshness */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexShrink: 1 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 99,
              backgroundColor:
                view.kpis.needsHuman > 0
                  ? theme.colors.statusWarning
                  : view.kpis.running > 0
                    ? theme.colors.accent
                    : view.kpis.readyToAccept > 0
                      ? theme.colors.statusSuccess
                      : theme.colors.foregroundMuted,
            }}
          />
          <Text
            accessibilityRole="header"
            style={{
              ...text(theme, "detailTitle"),
              fontSize: 18,
              lineHeight: 24,
              fontWeight: "600",
              flexShrink: 1,
              color: view.kpis.needsHuman > 0 ? theme.colors.statusWarning : theme.colors.foreground,
            }}
          >
            {headlineOf(view)}
          </Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: SPACING[1.5],
            paddingHorizontal: SPACING[2.5],
            paddingVertical: 3,
            borderRadius: RADIUS.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          {at !== null ? (
            <View
              accessibilityLabel={fresh ? "up to date" : "overdue"}
              style={{
                width: DOT - 2,
                height: DOT - 2,
                borderRadius: DOT,
                backgroundColor: fresh ? theme.colors.statusSuccess : theme.colors.statusWarning,
              }}
            />
          ) : null}
          <Text style={{ ...text(theme, "badge"), fontVariant: ["tabular-nums"] }} numberOfLines={1}>
            {at !== null ? `updated ${readAgo(Math.max(0, Math.round((now - at) / 1000)))}` : "never updated"}
            {view.daemonError === null ? "" : " · daemon unreadable"}
          </Text>
        </View>
      </View>

      {/* Equal-width KPI Stat Tiles */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[2] }}>
        {STATS.map((stat) => (
          <StatTile key={stat.key} theme={theme} n={view.kpis[stat.key]} label={stat.label} colour={theme.colors[stat.colour]} icon={stat.icon} />
        ))}
        <StatTile theme={theme} n={dollars} label="Total Cost" colour={theme.colors.foreground} icon="Coins" />
      </View>

      {/* Project Scope Bar */}
      <Card theme={theme} gap={SPACING[2]}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1], paddingRight: SPACING[1] }}>
            <Icon name="FolderGit2" size={13} color={theme.colors.foregroundMuted} />
            <Text style={text(theme, "badge")}>PROJECT</Text>
          </View>
          <Chip theme={theme} label="All projects" active={project === null} count={0} onPress={() => actions.pickProject(null)} />
          {view.projects.map((entry) => (
            <Chip
              key={entry.slug}
              theme={theme}
              label={projectLabel(entry.slug, entry.root)}
              active={project?.slug === entry.slug}
              count={0}
              onPress={() => actions.pickProject(entry.root)}
            />
          ))}
          <Btn
            theme={theme}
            small
            icon={pickingPath ? "X" : "FolderPlus"}
            label={pickingPath ? "Cancel" : "Add repo"}
            tone="foregroundMuted"
            onPress={() => setPickingPath((v) => !v)}
          />
          <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
            {project !== null ? <Pill theme={theme} label={project.slug} mono /> : null}
            {/* The seat states (v0.0.27, ADR 0017 §3): a seat starts only from
                Paseo's native New Chat picker ("Supervisor (Factory)") — the
                Supervisor spawns the Lead itself. The Header reports each
                seat's live status with an Open jump to its conversation while
                it lives, and the picker hint while it is vacant. */}
            {project !== null ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                {view.supervisor !== null ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                    <SeatState theme={theme} name="Supervisor" status={view.supervisor.status} />
                    <Btn theme={theme} small icon="Shield" label="Open Supervisor" tone="accent" onPress={() => actions.openSupervisor()} />
                  </View>
                ) : (
                  <Text style={text(theme, "meta")}>Select "Supervisor (Factory)" in New Chat to start</Text>
                )}
                {view.lead !== null ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5], flexWrap: "wrap" }}>
                    <SeatState theme={theme} name="Lead" status={view.lead.status} />
                    <Btn theme={theme} small icon="Compass" label="Open Lead" tone="accent" onPress={() => actions.openLead()} />
                  </View>
                ) : (
                  <Text style={text(theme, "meta")}>Spawned automatically by Supervisor</Text>
                )}
                {confirmingReset ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
                    <Btn
                      theme={theme}
                      small
                      solid
                      icon="RotateCcw"
                      label="Confirm Reset"
                      tone="statusDanger"
                      disabled={actions.busy}
                      onPress={() => {
                        setConfirmingReset(false);
                        actions.resetProject();
                      }}
                    />
                    <Btn
                      theme={theme}
                      small
                      icon="X"
                      label="Cancel"
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => setConfirmingReset(false)}
                    />
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Btn
                      theme={theme}
                      small
                      icon="RotateCcw"
                      label="Reset Project"
                      tone="foregroundMuted"
                      disabled={actions.busy}
                      onPress={() => setConfirmingReset(true)}
                    />
                  </View>
                )}
              </View>
            ) : null}

          </View>
        </View>

        {pickingPath ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
            <View
              style={{
                flexBasis: 240,
                flexGrow: 1,
                minHeight: CONTROL_SM,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <TextInput
                value={customPath}
                onChangeText={setCustomPath}
                placeholder="/path/to/git-repo"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 4, color: theme.colors.foreground, fontSize: 12 }}
                onSubmitEditing={submitPath}
              />
            </View>
            <Btn theme={theme} small icon="Check" label="Select Project" tone="accent" disabled={customPath.trim() === ""} onPress={submitPath} />
          </View>
        ) : null}
      </Card>

      {/* Built-in Private Vault Cloud Sync Bar (v0.0.22, ADR 0014) */}
      <VaultSyncBar
        theme={theme}
        vault={view.vault}
        busy={actions.busy}
        busyAct={busyAct}
        vaultNote={vaultNote}
        onVaultSync={onVaultSync}
        onVaultImport={onVaultImport}
        onVaultConfigure={onVaultConfigure}
        onVaultHydrate={onVaultHydrate}
        onRefresh={onRefresh}
      />

      {view.daemonError !== null ? (
        <Card theme={theme} style={{ borderColor: tint(theme.colors.statusWarning, "66"), backgroundColor: tint(theme.colors.statusWarning, "12") }}>
          <Text style={text(theme, "label", "statusWarning")}>{view.daemonError}</Text>
        </Card>
      ) : null}
    </View>
  );
}
