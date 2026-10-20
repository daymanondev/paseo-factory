/**
 * Tab 4 — Plugins, the `Companion plugin` catalog (v0.0.17, ADR 0012 §1/§2):
 * a summary header over the Factory companion ecosystem (how many companions
 * run on this daemon, plus Install All when any is uninstalled), then one
 * card per CompanionPluginView — header row (sidebar icon, title, plugin id
 * badge, status pill, Active in Sidebar when running), tagline, description,
 * capability pills, the installation metadata row (canonical source, or
 * installKind + installedSource + short revision), the daemon error banner,
 * and the state-correct action bar (Install / Custom source… when absent;
 * Enable·Disable, Update, Reload, Remove when installed). The Shell owns the
 * RPC calls — this pane is a pure render of the view plus action callbacks.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { CompanionCatalogEntry } from "../../shared/companions.ts";
import type { CompanionPluginView, CompanionStatus, FactoryView, VaultStatusView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { CONTROL_H, RADIUS, SPACING, text, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";

/** The two companion ids the catalog carries — the RPC enums minus "all". */
type CompanionId = CompanionCatalogEntry["id"];

/** The Plugins tab's whole action surface — the Shell owns the RPC calls. */
export interface PluginsActions {
  /** Install one companion (canonical source by default, or a custom source/ref) or every uninstalled companion ("all"). */
  install(target: CompanionId | "all", source?: string, ref?: string): void;
  /** One lifecycle act on an installed companion. */
  manage(pluginId: CompanionId, action: "enable" | "disable" | "reload" | "update" | "remove"): void;
  busy: boolean;
}

/** The status pill's four faces — Running green, Failed danger, the rest muted (the tasks.tsx statusTone law). */
const STATUS: Record<CompanionStatus, { label: string; tone: Colour; lit: boolean }> = {
  running: { label: "Running", tone: "statusSuccess", lit: true },
  disabled: { label: "Disabled", tone: "foregroundMuted", lit: false },
  failed: { label: "Failed", tone: "statusDanger", lit: true },
  not_installed: { label: "Not Installed", tone: "foregroundMuted", lit: false },
};

/** One companion's card — the catalog entry joined with its live daemon state. */
function CompanionCard({ theme, companion, actions }: { theme: PluginTheme; companion: CompanionPluginView; actions: PluginsActions }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const status = STATUS[companion.status];
  // The fold joins COMPANION_CATALOG against the daemon list, so every view
  // id is a catalog id — narrow the wire's plain string back to the enum.
  const id = companion.id as CompanionId;
  const installed = companion.status !== "not_installed";
  const remote = companion.installKind === "git" || companion.installKind === "npm";
  const shortRevision = companion.currentRevision === null ? null : companion.currentRevision.slice(0, 7);
  const trimmedSource = source.trim();
  const trimmedRef = ref.trim();

  return (
    <Card theme={theme} gap={SPACING[2]}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Icon name={companion.sidebarIcon} size={15} color={theme.colors.accent} />
        <Text style={text(theme, "rowTitle")}>{companion.title}</Text>
        <Pill theme={theme} label={companion.id} mono />
        <Pill theme={theme} label={status.label} tone={status.tone} lit={status.lit} />
        {companion.status === "running" ? (
          <Pill theme={theme} label={`Active in Sidebar · ${companion.sidebarLabel}`} tone="accent" lit />
        ) : null}
      </View>

      <Text style={text(theme, "label")}>{companion.tagline}</Text>
      <Text style={text(theme, "meta")}>{companion.description}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
        {companion.capabilities.map((capability) => (
          <Pill key={capability} theme={theme} label={capability} mono />
        ))}
      </View>

      {/* The installation metadata row — what the daemon runs, or would install. */}
      <View
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: RADIUS.md,
          backgroundColor: theme.colors.surface0,
          padding: SPACING[2],
          gap: SPACING[1],
        }}
      >
        <Text style={text(theme, "badge")}>INSTALL</Text>
        {!installed ? (
          <Text style={text(theme, "code")} numberOfLines={1}>
            {companion.canonicalSource}
          </Text>
        ) : (
          <Text style={text(theme, "code")} numberOfLines={1}>
            {companion.installKind} · {companion.installedSource ?? "—"}
            {shortRevision !== null ? ` · ${shortRevision}` : ""}
          </Text>
        )}
      </View>

      {companion.error !== null ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: tint(theme.colors.statusDanger, "66"),
            borderRadius: RADIUS.md,
            backgroundColor: tint(theme.colors.statusDanger, "12"),
            padding: SPACING[2],
          }}
        >
          <Text style={text(theme, "label", "statusDanger")}>{companion.error}</Text>
        </View>
      ) : null}

      {!installed ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Btn theme={theme} small label="Install" solid disabled={actions.busy} onPress={() => actions.install(id)} />
          <Btn theme={theme} small label="Custom source…" tone="foregroundMuted" disabled={actions.busy} onPress={() => setCustomOpen(!customOpen)} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          {companion.enabled ? (
            <Btn theme={theme} small label="Disable" disabled={actions.busy} onPress={() => actions.manage(id, "disable")} />
          ) : (
            <Btn theme={theme} small label="Enable" disabled={actions.busy} onPress={() => actions.manage(id, "enable")} />
          )}
          {remote ? <Btn theme={theme} small label="Update" disabled={actions.busy} onPress={() => actions.manage(id, "update")} /> : null}
          <Btn theme={theme} small label="Reload" tone="foregroundMuted" disabled={actions.busy} onPress={() => actions.manage(id, "reload")} />
          <Btn theme={theme} small label="Remove" tone="statusDanger" disabled={actions.busy} onPress={() => actions.manage(id, "remove")} />
        </View>
      )}

      {/* The developer escape hatch — a custom Git source/ref or an explicit local directory. */}
      {customOpen && !installed ? (
        <View style={{ gap: SPACING[1.5] }}>
          <View style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Source</Text>
            <View
              style={{
                minHeight: CONTROL_H,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <TextInput
                value={source}
                onChangeText={setSource}
                placeholder={`git:daymanondev/${companion.id}:plugin or /path/to/plugin`}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
              />
            </View>
          </View>
          <View style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Ref (branch/tag/commit) — optional</Text>
            <View
              style={{
                minHeight: CONTROL_H,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <TextInput
                value={ref}
                onChangeText={setRef}
                placeholder="e.g. feat/x, v0.2.0, 9f3b2c1"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
              />
            </View>
          </View>
          <Btn
            theme={theme}
            small
            label="Install Custom"
            disabled={actions.busy || trimmedSource === ""}
            onPress={() => actions.install(id, trimmedSource, trimmedRef === "" ? undefined : trimmedRef)}
          />
        </View>
      ) : null}
    </Card>
  );
}

export function PluginsPane({ theme, view, actions }: { theme: PluginTheme; view: FactoryView; actions: PluginsActions }) {
  const running = view.companions.filter((c) => c.status === "running").length;
  const anyUninstalled = view.companions.some((c) => c.status === "not_installed");
  return (
    <View style={{ gap: SPACING[3] }}>
      <Card theme={theme} gap={SPACING[2]}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={text(theme, "section")}>Factory companion ecosystem</Text>
            <Text style={text(theme, "meta")}>
              paseo-factory is the verification core; its companion plugins extend the factory — Burn Lab runs free-model burns under the Supervisor's
              watch, Fleet Connector links peer factories over Tailscale. {running} of {view.companions.length} active on this daemon.
            </Text>
          </View>
          {anyUninstalled ? (
            <Btn theme={theme} small label="Install All" solid disabled={actions.busy} onPress={() => actions.install("all")} />
          ) : null}
        </View>
      </Card>
      {view.companions.map((companion) => (
        <CompanionCard key={companion.id} theme={theme} companion={companion} actions={actions} />
      ))}
    </View>
  );
}

// ---- the Private Vault (GitHub) card (v0.0.21, ADR 0014 §4) --------------------------------
//
// The vault control card the shell renders above the TabBar on the Plugins tab
// and the Settings screen: secret readiness pills from view.vault, the
// repo/branch/passphrase config inputs (the custom-source block's shapes), and
// the three 1-click transport buttons of §User Stories 1–3 plus Save Config.
// The Shell owns every RPC call — this card is a pure render plus callbacks.

/** The Private Vault card's action surface — the Shell owns the RPC calls (the PluginsPane law). */
export interface VaultActions {
  /** Persist repo/branch/passphrase to the 0o600 <stateDir>/vault-config.json and return the refreshed status. */
  configure(input: { repo: string; branch: string; passphrase?: string }): void;
  /** Zero-clone Direct hydrate (`gh api` tarball stream) — the typed repo rides the call when the input carries one. */
  hydrate(repo?: string, ref?: string): void;
  /** `Vault sync`: pull the cached checkout at `<home>/vault`, hydrate, and optionally reconcile node ledgers. */
  pull(mergeLedgers?: boolean): void;
  /** Package this machine's runtime tree (and node-scoped ledger snapshot) back to the remote. */
  push(includeLedgers?: boolean): void;
  busy: boolean;
}

/** One labelled config input — the custom-source block's exact box and type shapes. */
function VaultInput({
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
    <View style={{ gap: SPACING[1] }}>
      <Text style={text(theme, "label")}>{label}</Text>
      <View
        style={{
          minHeight: CONTROL_H,
          justifyContent: "center",
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: RADIUS.md,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          secureTextEntry={secure}
          style={{ paddingHorizontal: SPACING[2.5], paddingVertical: 5, color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}
        />
      </View>
    </View>
  );
}

export function PrivateVaultCard({ theme, vault, actions }: { theme: PluginTheme; vault: VaultStatusView; actions: VaultActions }) {
  const [repo, setRepo] = useState(vault.repo ?? "");
  const [branch, setBranch] = useState(vault.branch);
  const [passphrase, setPassphrase] = useState("");
  const trimmedRepo = repo.trim();
  const trimmedBranch = branch.trim();
  const trimmedPassphrase = passphrase.trim();
  const pills: ReadonlyArray<{ label: string; lit: boolean }> = [
    { label: "ASC .p8", lit: vault.sharedSecrets.ascKey },
    { label: "ASC Credentials", lit: vault.sharedSecrets.ascCredentials },
    { label: "Google Play JSON", lit: vault.sharedSecrets.gplayServiceAccount },
    { label: "Eye Config", lit: vault.sharedSecrets.eyeConfig },
    { label: `Hydrated Apps: ${vault.hydratedApps.length}`, lit: vault.hydratedApps.length > 0 },
  ];
  const lastHydrate = vault.lastHydratedAt === null ? "never" : `${vault.lastHydratedAt}${vault.lastHydrateMode === null ? "" : ` (${vault.lastHydrateMode})`}`;

  return (
    <Card theme={theme} gap={SPACING[2]}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Icon name="Shield" size={15} color={theme.colors.accent} />
        <Text style={text(theme, "rowTitle")}>Private Vault (GitHub)</Text>
        <Pill theme={theme} label={vault.configured ? "Configured" : "Not Configured"} tone={vault.configured ? "statusSuccess" : "foregroundMuted"} lit={vault.configured} />
        {vault.hasPassphrase ? <Pill theme={theme} label="Passphrase Set" tone="accent" lit /> : null}
      </View>

      <Text style={text(theme, "meta")}>
        The Owner's private GitHub repository carries what the open-source plugin repos never can — store credentials, signing keys, Lane configs, and
        node-scoped Ledger history. Any machine logged into GitHub hydrates in one click; passphrase-locked .enc envelopes unseal with the saved
        passphrase.
      </Text>

      {/* The secret readiness pills — the hydrated facts view.vault reports per snapshot. */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
        {pills.map((pill) => (
          <Pill key={pill.label} theme={theme} label={pill.label} tone={pill.lit ? "statusSuccess" : "foregroundMuted"} lit={pill.lit} />
        ))}
      </View>

      {/* The status metadata row — the config of record and this node's sync history. */}
      <View
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: RADIUS.md,
          backgroundColor: theme.colors.surface0,
          padding: SPACING[2],
          gap: SPACING[1],
        }}
      >
        <Text style={text(theme, "badge")}>VAULT</Text>
        <Text style={text(theme, "code")} numberOfLines={1}>
          repo: {vault.repo ?? "—"} · branch: {vault.branch} · node: {vault.nodeId}
        </Text>
        <Text style={text(theme, "code")} numberOfLines={1}>
          checkout: {vault.cloneExists ? "cached at <home>/vault" : "none"} · last hydrate: {lastHydrate} · last push: {vault.lastPushedAt ?? "never"}
        </Text>
        {vault.hydratedApps.length > 0 ? (
          <Text style={text(theme, "code")} numberOfLines={1}>
            hydrated apps: {vault.hydratedApps.join(", ")}
          </Text>
        ) : null}
      </View>

      {vault.error !== null ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: tint(theme.colors.statusDanger, "66"),
            borderRadius: RADIUS.md,
            backgroundColor: tint(theme.colors.statusDanger, "12"),
            padding: SPACING[2],
          }}
        >
          <Text style={text(theme, "label", "statusDanger")}>{vault.error}</Text>
        </View>
      ) : null}

      {/* The config inputs — repo, branch, and the optional passphrase (blank keeps the saved one). */}
      <View style={{ gap: SPACING[1.5] }}>
        <VaultInput theme={theme} label="Repository" value={repo} onChange={setRepo} placeholder="owner/vault-repo (e.g. daymanondev/factory-vault)" />
        <VaultInput theme={theme} label="Branch" value={branch} onChange={setBranch} placeholder="main" />
        <VaultInput
          theme={theme}
          label="Passphrase — optional (unlocks *.enc envelopes)"
          value={passphrase}
          onChange={setPassphrase}
          placeholder={vault.hasPassphrase ? "set — leave blank to keep" : "optional — zero-passphrase is the default"}
          secure
        />
      </View>

      {/* The 1-click transport bar (§User Stories 1–3) plus Save Config — every act through the shell's act(). */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <Btn
          theme={theme}
          small
          solid
          label="Save Config"
          disabled={actions.busy || trimmedRepo === ""}
          onPress={() =>
            actions.configure({
              repo: trimmedRepo,
              branch: trimmedBranch === "" ? "main" : trimmedBranch,
              ...(trimmedPassphrase === "" ? {} : { passphrase: trimmedPassphrase }),
            })
          }
        />
        <Btn
          theme={theme}
          small
          label="Hydrate Direct (gh api)"
          disabled={actions.busy}
          onPress={() => actions.hydrate(trimmedRepo === "" ? undefined : trimmedRepo, trimmedBranch === "" ? undefined : trimmedBranch)}
        />
        <Btn theme={theme} small label="Pull & Sync Vault" disabled={actions.busy} onPress={() => actions.pull(true)} />
        <Btn theme={theme} small label="Push to Vault" disabled={actions.busy} onPress={() => actions.push(true)} />
      </View>
    </Card>
  );
}
