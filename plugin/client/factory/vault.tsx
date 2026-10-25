/**
 * Dedicated Private Vault tab and sync bar (v0.0.22, ADR 0014 §1–§5; moved to
 * its own fifth tab in v0.0.35, ADR 0025):
 * Renders inside the `Vault` tab (`tab === "vault"`) and on the Settings screen
 * with a 3-state guided flow:
 * 1. `!vault.configured && !vault.ghAuthenticated`: guided 2-step `gh auth login --web -p https` banner.
 * 2. `!vault.configured && vault.ghAuthenticated`: `@<ghUser>` greeting + `<ghUser>/factory-vault` + 1-click `Enable & Sync Vault`.
 * 3. `vault.configured`: `Vault: <repo>` + readiness pills + `Sync Vault` + `+ Import Key` & `⚙` drawers.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";

import type { VaultStatusView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { CONTROL_SM, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import { historyFeedback } from "./vault-feedback.ts";

export type VaultActName = "Vault Sync" | "Vault Import" | "Vault Configure" | "Vault Hydrate" | "Vault Save";

const VAULT_ACT_NAMES: ReadonlySet<string> = new Set<VaultActName>([
  "Vault Sync",
  "Vault Import",
  "Vault Configure",
  "Vault Hydrate",
  "Vault Save",
]);

export function isVaultActName(name: string): name is VaultActName {
  return VAULT_ACT_NAMES.has(name);
}

export interface VaultNote {
  text: string;
  tone: "statusSuccess" | "statusWarning" | "statusDanger";
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

export function readAgo(seconds: number): string {
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
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

export interface VaultSyncBarProps {
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
}

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
}: VaultSyncBarProps) {
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
  const history = historyFeedback(vault.historyImports);
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
                ? `transported ${readAgo(syncAgeSeconds)}`
                : lastSyncStamp !== null
                  ? `transported ${lastSyncStamp.slice(0, 19).replace("T", " ")}`
                  : "no transport yet"}
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

      {history !== null ? <Text style={text(theme, "label", history.tone)}>{history.text}</Text> : null}

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

/** Dedicated fifth tab view (`Vault`) on the Factory surface and Settings screen (v0.0.35, ADR 0025). */
export function VaultPane(props: VaultSyncBarProps) {
  return (
    <View style={{ gap: SPACING[3] }}>
      <VaultSyncBar {...props} />
    </View>
  );
}
