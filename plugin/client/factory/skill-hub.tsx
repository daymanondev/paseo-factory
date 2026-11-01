import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import type { SkillHubView } from "../../shared/view.ts";
import { Btn, Card, Chip, Pill } from "../kit/pill.tsx";
import { CONTROL_SM, DOT, RADIUS, SPACING, text, tint } from "../kit/theme.ts";

type HubTab = "installed" | "hosts" | "matrix";

const FILTERS: ReadonlyArray< readonly [string, string] > = [
  ["all", "All"],
  ["core", "Core"],
  ["expo", "Expo"],
  ["firebase", "Firebase"],
  ["zcode-3d", "3D/ZCode"],
  ["science", "Science"],
  ["workflow", "Workflow"],
  ["custom", "Custom"],
  ["outdated", "Outdated"],
];

const ROLES: Record<string, string> = {
  supervisor: "Sup",
  lead: "Lead",
  peer: "Peer",
  pm: "PM",
  ux: "UX",
  architect: "Arch",
  dev: "Dev",
  qa: "QA",
};

const ROLE_TITLES: Record<string, string> = {
  supervisor: "Supervisor (Owner Interface)",
  lead: "Lead (Verification & Contracts)",
  peer: "Peer (Implementation Seat)",
  pm: "Product Manager",
  ux: "UX / UI Specialist",
  architect: "System Architect",
  dev: "Developer Specialist",
  qa: "QA Verification Specialist",
};

const PACK_BADGE: Record<string, string> = {
  core: "CORE",
  expo: "EXPO",
  firebase: "FIREBASE",
  "zcode-3d": "3D",
  science: "SCIENCE",
  workflow: "WORKFLOW",
  custom: "CUSTOM",
};

const PACK_META: Record<string, { tagline: string; hostId: string; totalHint: number }> = {
  expo: {
    tagline: "24 official Expo Router, Native UI, SwiftUI/Compose, EAS Build & Workflows skills",
    hostId: "expo:official-pack",
    totalHint: 24,
  },
  firebase: {
    tagline: "Auth, Firestore, Security Rules, Hosting, App Hosting, Data Connect & Crashlytics",
    hostId: "antigravity:firebase",
    totalHint: 13,
  },
  "zcode-3d": {
    tagline: "Blender, Godot, Unity, Unreal Engine & 3D asset generation workflows",
    hostId: "zcode:blender",
    totalHint: 6,
  },
  science: {
    tagline: "AlphaFold, AlphaGenome, ChEMBL, ClinVar, Ensembl, PDB, PubMed & UniProt",
    hostId: "antigravity:science",
    totalHint: 28,
  },
};

export function SkillHubCard({
  theme,
  hub,
  busy,
  projectRoot,
  defaultOpen = false,
  importSkill,
  togglePack,
  healSkills,
  updateSkills,
}: {
  theme: PluginTheme;
  hub?: SkillHubView;
  busy: boolean;
  projectRoot?: string;
  defaultOpen?: boolean;
  healSkills?: () => void;
  updateSkills?: () => void;
  importSkill?: (id: string) => void;
  togglePack?: (pack: string, enabled: boolean) => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<HubTab>("installed");
  const [filter, setFilter] = useState("all");
  const [hostEcoFilter, setHostEcoFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expandedRoles, setExpandedRoles] = useState<Record<string, boolean>>({});

  if (!hub) return null;

  const trimmedSearch = search.trim().toLowerCase();
  const expoEntry = hub.hostCatalog.find((e) => e.id === "expo:official-pack");
  const expoLinked = expoEntry?.status === "linked";
  const enabledPackCount = hub.projectPacks.filter((p) => p.enabled).length;
  const availableHostCount = hub.hostCatalog.filter((e) => e.status === "available" && e.skills.length > 0).length;

  const packCounts: Record<string, number> = {
    all: hub.installedSkills.length,
    outdated: hub.updateAvailableCount,
  };
  for (const s of hub.installedSkills) {
    packCounts[s.pack] = (packCounts[s.pack] ?? 0) + 1;
  }

  const filteredSkills = hub.installedSkills.filter((s) => {
    const matchesPack =
      filter === "all" ||
      s.pack === filter ||
      (filter === "outdated" && s.freshness === "update_available");
    if (!matchesPack) return false;
    if (!trimmedSearch) return true;
    return (
      s.name.toLowerCase().includes(trimmedSearch) ||
      s.source.toLowerCase().includes(trimmedSearch) ||
      s.pack.toLowerCase().includes(trimmedSearch)
    );
  });

  const ecosystems = Array.from(new Set(hub.hostCatalog.map((e) => e.ecosystem)));
  const filteredHosts = hub.hostCatalog.filter((e) => {
    if (hostEcoFilter !== "all" && e.ecosystem !== hostEcoFilter) return false;
    if (!trimmedSearch) return true;
    return (
      e.name.toLowerCase().includes(trimmedSearch) ||
      e.ecosystem.toLowerCase().includes(trimmedSearch) ||
      e.skills.some((sk) => sk.toLowerCase().includes(trimmedSearch))
    );
  });

  const selectTab = (nextTab: HubTab): void => {
    if (drawerOpen && tab === nextTab) {
      setDrawerOpen(false);
    } else {
      setTab(nextTab);
      setDrawerOpen(true);
    }
  };

  return (
    <Card theme={theme} gap={SPACING[2]}>
      {/* Row 1 (Compact Header — matches HelperMcpsCard & CompanionCard): Icon + Title + Summary Pills on left, Primary CTA + ⋯ Manage on right */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
          <Icon name="Sparkles" size={15} color={theme.colors.accent} />
          <Text style={text(theme, "rowTitle")}>
            Skill Hub — Inventory, Host Ecosystems &amp; Role Matrix
          </Text>
          <Pill theme={theme} label="CORE + PACKS" tone="accent" lit />
          <Pill
            theme={theme}
            label={`${hub.totalInstalled} installed (${hub.upToDateCount} up to date)`}
            tone={hub.totalInstalled > 0 && hub.updateAvailableCount === 0 ? "statusSuccess" : "foregroundMuted"}
          />
          {hub.updateAvailableCount > 0 ? (
            <Pill
              theme={theme}
              label={`${hub.updateAvailableCount} update${hub.updateAvailableCount > 1 ? "s" : ""} available`}
              tone="statusWarning"
              lit
            />
          ) : null}
          {hub.symlinkDriftCount > 0 ? (
            <Pill theme={theme} label={`${hub.symlinkDriftCount} with link drift`} tone="statusWarning" lit />
          ) : hub.totalInstalled > 0 ? (
            <Pill theme={theme} label="5/5 harnesses linked" tone="statusSuccess" />
          ) : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          {!expoLinked ? (
            <Btn
              theme={theme}
              small
              icon="Download"
              label="Install Expo Pack (24)"
              tone="accent"
              disabled={busy || !importSkill}
              onPress={() => importSkill?.("expo:official-pack")}
            />
          ) : null}
          {hub.updateAvailableCount > 0 ? (
            <Btn
              theme={theme}
              small
              solid
              icon="RefreshCw"
              label={`Update Skills (${hub.updateAvailableCount})`}
              disabled={busy || !updateSkills}
              onPress={() => updateSkills?.()}
            />
          ) : null}
          {hub.symlinkDriftCount > 0 ? (
            <Btn
              theme={theme}
              small
              tone="statusWarning"
              icon="Wrench"
              label="Heal Symlinks"
              disabled={busy || !healSkills}
              onPress={() => healSkills?.()}
            />
          ) : null}
          <Btn
            theme={theme}
            small
            tone="foregroundMuted"
            label={drawerOpen ? "Hide" : `⋯ Manage (${hub.totalInstalled})`}
            onPress={() => setDrawerOpen(!drawerOpen)}
          />
        </View>
      </View>

      {/* Row 2 (Always-visible 2×2 Project Skill Packs Grid): Clean domain pack cards with auto-detection & per-Project toggle */}
      <View style={{ gap: SPACING[1.5] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
            <Text style={text(theme, "label")}>Project Skill Packs</Text>
            <Pill
              theme={theme}
              label={enabledPackCount > 0 ? `${enabledPackCount} active for Project` : "Baseline only"}
              tone={enabledPackCount > 0 ? "statusSuccess" : "foregroundMuted"}
            />
          </View>
          <Text style={text(theme, "meta", "foregroundMuted")}>
            {!projectRoot
              ? "Select a Project to enable skill packs."
              : "Auto-detected from package.json / app.json or toggled per Project"}
          </Text>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
          {hub.projectPacks.map((pack) => {
            const meta = PACK_META[pack.id];
            const installedInPack = hub.installedSkills.filter((s) => s.pack === pack.id).length;
            return (
              <View
                key={pack.id}
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  flexBasis: 260,
                  minWidth: 0,
                  borderWidth: 1,
                  borderColor: pack.enabled ? tint(theme.colors.accent, "66") : theme.colors.border,
                  borderRadius: RADIUS.md,
                  backgroundColor: pack.enabled ? tint(theme.colors.accent, "0c") : theme.colors.surface0,
                  paddingHorizontal: SPACING[2.5],
                  paddingVertical: SPACING[1.5],
                  gap: SPACING[1],
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1 }}>
                    <View
                      style={{
                        width: DOT,
                        height: DOT,
                        borderRadius: DOT / 2,
                        backgroundColor: pack.enabled
                          ? theme.colors.statusSuccess
                          : installedInPack > 0
                            ? theme.colors.accent
                            : theme.colors.foregroundMuted,
                      }}
                    />
                    <Text style={text(theme, "section")} numberOfLines={1}>
                      {pack.label}
                    </Text>
                    {pack.autoDetected ? (
                      <Pill theme={theme} label="Auto-detected" tone="accent" lit />
                    ) : null}
                    <Pill
                      theme={theme}
                      label={meta ? `${installedInPack}/${meta.totalHint} installed` : `${installedInPack} installed`}
                      mono
                      tone={installedInPack > 0 ? "statusSuccess" : "foregroundMuted"}
                    />
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
                    {installedInPack === 0 && meta?.hostId && importSkill ? (
                      <Btn
                        theme={theme}
                        small
                        tone="accent"
                        label="Install Pack"
                        disabled={busy}
                        onPress={() => importSkill(meta.hostId)}
                      />
                    ) : null}
                    <Btn
                      theme={theme}
                      small
                      tone={pack.enabled ? "foregroundMuted" : "accent"}
                      label={pack.enabled ? "Enabled — disable" : "Enable for Project"}
                      disabled={busy || !projectRoot || !togglePack}
                      onPress={() => togglePack?.(pack.id, !pack.enabled)}
                    />
                  </View>
                </View>

                {meta ? (
                  <Text style={text(theme, "meta", "foregroundMuted")} numberOfLines={1}>
                    {meta.tagline}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      </View>

      {/* Row 3 (Quick-Jump Sub-View Bar): Clicking any chip opens/switches the collapsible drawer */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
          <Chip
            theme={theme}
            icon="Package"
            label={`Installed in Factory (${hub.totalInstalled})`}
            count={hub.updateAvailableCount}
            active={drawerOpen && tab === "installed"}
            onPress={() => selectTab("installed")}
          />
          <Chip
            theme={theme}
            icon="Layers"
            label={`Host Ecosystems (${hub.hostCatalog.length})`}
            count={availableHostCount}
            active={drawerOpen && tab === "hosts"}
            onPress={() => selectTab("hosts")}
          />
          <Chip
            theme={theme}
            icon="GitBranch"
            label="Role ↔ Skill Matrix"
            count={0}
            active={drawerOpen && tab === "matrix"}
            onPress={() => selectTab("matrix")}
          />
        </View>
        {!drawerOpen ? (
          <Text style={text(theme, "meta", "foregroundMuted")}>
            Click a tab above or ⋯ Manage to inspect individual skills, import from Claude/Codex/Antigravity/ZCode, or view the Role Matrix.
          </Text>
        ) : null}
      </View>

      {/* Collapsible ⋯ Manage Drawer: Search, Category Chips, and 2-Column Structured Cards */}
      {drawerOpen ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: SPACING[2], gap: SPACING[2] }}>
          {tab !== "matrix" ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
              {/* Search Box */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  flexBasis: 240,
                  flexGrow: 1,
                  maxWidth: 360,
                  minHeight: CONTROL_SM,
                  paddingHorizontal: SPACING[2],
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: RADIUS.md,
                  backgroundColor: theme.colors.surface0,
                  gap: SPACING[1.5],
                }}
              >
                <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder={tab === "installed" ? "Search installed skills or repo…" : "Search host plugins or skills…"}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{ flex: 1, paddingVertical: 3, color: theme.colors.foreground, fontSize: 12 }}
                />
                {search.length > 0 ? (
                  <Btn theme={theme} small tone="foregroundMuted" label="Clear" onPress={() => setSearch("")} />
                ) : null}
              </View>

              {/* Maintenance Actions */}
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                <Btn
                  theme={theme}
                  small
                  tone={expoLinked ? "foregroundMuted" : "accent"}
                  label={expoLinked ? "Update Expo Pack" : "Install Expo Pack (24)"}
                  disabled={busy || !importSkill}
                  onPress={() => importSkill?.("expo:official-pack")}
                />
                <Btn
                  theme={theme}
                  small
                  tone="foregroundMuted"
                  label="Update Core & Tracked Skills"
                  disabled={busy || !updateSkills}
                  onPress={() => updateSkills?.()}
                />
                <Btn
                  theme={theme}
                  small
                  tone="foregroundMuted"
                  label="Heal Symlinks"
                  disabled={busy || !healSkills}
                  onPress={() => healSkills?.()}
                />
              </View>
            </View>
          ) : null}

          {tab === "installed" ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                {FILTERS.filter(([id]) => id === "all" || id === filter || (packCounts[id] ?? 0) > 0).map(([id, label]) => (
                  <Chip
                    key={id}
                    theme={theme}
                    label={label}
                    count={packCounts[id] ?? 0}
                    active={filter === id}
                    onPress={() => setFilter(id)}
                  />
                ))}
              </View>

              {filteredSkills.length === 0 ? (
                <Text style={text(theme, "meta", "foregroundMuted")}>
                  No skills match this filter. Import a pack from Host Ecosystems or clear the search filter.
                </Text>
              ) : (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
                  {filteredSkills.map((skill) => {
                    const availableHarnesses = skill.harnesses.filter((h) => h.available);
                    const healthyHarnesses = availableHarnesses.filter((h) => h.healthy);
                    const driftHarnesses = availableHarnesses.filter((h) => !h.healthy);
                    const isOutdated = skill.freshness === "update_available";
                    const hasDrift = driftHarnesses.length > 0;
                    const dotTone =
                      isOutdated || hasDrift
                        ? "statusWarning"
                        : skill.freshness === "up_to_date"
                          ? "statusSuccess"
                          : "accent";

                    return (
                      <View
                        key={skill.name}
                        style={{
                          flexGrow: 1,
                          flexShrink: 1,
                          flexBasis: 290,
                          minWidth: 0,
                          borderWidth: 1,
                          borderColor:
                            isOutdated || hasDrift
                              ? tint(theme.colors.statusWarning, "66")
                              : theme.colors.border,
                          borderRadius: RADIUS.md,
                          backgroundColor: theme.colors.surface0,
                          paddingHorizontal: SPACING[2.5],
                          paddingVertical: SPACING[1.5],
                          gap: SPACING[1],
                        }}
                      >
                        {/* Row 1: Dot + Skill Name + Pack Badge on left, Freshness + Compact Harness Status on right */}
                        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
                          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1, minWidth: 0 }}>
                            <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: theme.colors[dotTone] }} />
                            <Text style={{ ...text(theme, "code"), flexShrink: 1 }} numberOfLines={1}>
                              {skill.name}
                            </Text>
                            <Pill theme={theme} label={PACK_BADGE[skill.pack] ?? skill.pack.toUpperCase()} mono />
                          </View>

                          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
                            <Pill
                              theme={theme}
                              label={
                                skill.freshness === "local"
                                  ? "Local/Custom"
                                  : skill.freshness === "update_available"
                                    ? "Update Available"
                                    : "Up to Date"
                              }
                              tone={
                                skill.freshness === "update_available"
                                  ? "statusWarning"
                                  : skill.freshness === "up_to_date"
                                    ? "statusSuccess"
                                    : "foregroundMuted"
                              }
                              lit={skill.freshness === "update_available"}
                            />
                            {hasDrift ? (
                              <Pill
                                theme={theme}
                                label={`${driftHarnesses.map((h) => h.name).join(", ")}: drift`}
                                tone="statusWarning"
                                lit
                              />
                            ) : (
                              <Pill
                                theme={theme}
                                label={`${healthyHarnesses.length}/${availableHarnesses.length} linked`}
                                mono
                              />
                            )}
                          </View>
                        </View>

                        {/* Row 2: Source repo · rev on left, Compact Role Badges on right */}
                        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
                          <Text style={{ ...text(theme, "meta", "foregroundMuted"), flexShrink: 1 }} numberOfLines={1}>
                            {skill.source} · {skill.revision?.slice(0, 7) ?? "local"}
                          </Text>
                          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
                            {skill.roles.length >= 6 ? (
                              <Pill theme={theme} label={`All Roles (${skill.roles.length})`} />
                            ) : (
                              <>
                                {skill.roles.slice(0, 4).map((role) => (
                                  <Pill key={role} theme={theme} label={ROLES[role] ?? role} />
                                ))}
                                {skill.roles.length > 4 ? (
                                  <Pill theme={theme} label={`+${skill.roles.length - 4}`} />
                                ) : null}
                              </>
                            )}
                          </View>
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </>
          ) : tab === "hosts" ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                  <Chip
                    theme={theme}
                    label="All Ecosystems"
                    count={hub.hostCatalog.length}
                    active={hostEcoFilter === "all"}
                    onPress={() => setHostEcoFilter("all")}
                  />
                  {ecosystems.map((eco) => (
                    <Chip
                      key={eco}
                      theme={theme}
                      label={eco}
                      count={hub.hostCatalog.filter((e) => e.ecosystem === eco).length}
                      active={hostEcoFilter === eco}
                      onPress={() => setHostEcoFilter(eco)}
                    />
                  ))}
                </View>
                <Text style={text(theme, "meta", "foregroundMuted")}>
                  Host catalogs are read-only. Import copies portable skills into ~/.agents/skills and links all 5 harnesses.
                </Text>
              </View>

              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
                {filteredHosts.map((entry) => (
                  <View
                    key={entry.id}
                    style={{
                      flexGrow: 1,
                      flexShrink: 1,
                      flexBasis: 290,
                      minWidth: 0,
                      borderWidth: 1,
                      borderColor: entry.status === "linked" ? tint(theme.colors.statusSuccess, "44") : theme.colors.border,
                      borderRadius: RADIUS.md,
                      backgroundColor: theme.colors.surface0,
                      paddingHorizontal: SPACING[2.5],
                      paddingVertical: SPACING[1.5],
                      gap: SPACING[1],
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
                      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5], flexShrink: 1, minWidth: 0 }}>
                        <Pill theme={theme} label={entry.ecosystem.toUpperCase()} tone="accent" mono />
                        <Text style={{ ...text(theme, "section"), flexShrink: 1 }} numberOfLines={1}>
                          {entry.name}
                        </Text>
                      </View>

                      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}>
                        <Pill
                          theme={theme}
                          label={entry.status === "linked" ? "Linked in Factory" : "Available on Host"}
                          tone={entry.status === "linked" ? "statusSuccess" : "foregroundMuted"}
                        />
                        {entry.status === "available" && entry.skills.length > 0 ? (
                          <Btn
                            theme={theme}
                            small
                            tone="accent"
                            label="+ Import to Factory"
                            disabled={busy || !importSkill}
                            onPress={() => importSkill?.(entry.id)}
                          />
                        ) : null}
                      </View>
                    </View>

                    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
                      <Pill theme={theme} label={`${entry.skills.length} skill${entry.skills.length === 1 ? "" : "s"}`} mono />
                      {entry.mcpServers.map((mcp) => (
                        <Pill key={mcp} theme={theme} label={`MCP: ${mcp}`} tone="accent" mono />
                      ))}
                      {entry.skills.slice(0, 4).map((sk) => (
                        <Pill key={sk} theme={theme} label={sk} mono />
                      ))}
                      {entry.skills.length > 4 ? (
                        <Pill theme={theme} label={`+${entry.skills.length - 4} more`} />
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            </>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[3] }}>
              {(["slp", "scrum"] as const).map((mode) => (
                <View key={mode} style={{ flex: 1, minWidth: 280, gap: SPACING[1.5] }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                    <Icon name={mode === "slp" ? "Shield" : "Layers"} size={14} color={theme.colors.accent} />
                    <Text style={text(theme, "section")}>
                      {mode === "slp" ? "SLP Roles (Supervisor · Lead · Peer)" : "Agile Scrum Roles (PM · UX · Arch · Dev · QA)"}
                    </Text>
                  </View>
                  {hub.roleMatrix
                    .filter((r) => r.mode === mode)
                    .map((r) => {
                      const isExpanded = expandedRoles[r.role] === true;
                      const visibleSkills = isExpanded ? r.skills : r.skills.slice(0, 10);
                      const hiddenCount = r.skills.length - visibleSkills.length;
                      return (
                        <View
                          key={r.role}
                          style={{
                            borderWidth: 1,
                            borderColor: theme.colors.border,
                            borderRadius: RADIUS.md,
                            backgroundColor: theme.colors.surface0,
                            paddingHorizontal: SPACING[2.5],
                            paddingVertical: SPACING[1.5],
                            gap: SPACING[1],
                          }}
                        >
                          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[1.5] }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
                              <Pill theme={theme} label={ROLES[r.role] ?? r.role} tone="accent" lit />
                              <Text style={text(theme, "section")}>{ROLE_TITLES[r.role] ?? r.role}</Text>
                            </View>
                            <Pill theme={theme} label={`${r.skills.length} skills`} mono />
                          </View>

                          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
                            {visibleSkills.length === 0 ? (
                              <Text style={text(theme, "meta", "foregroundMuted")}>No skills assigned</Text>
                            ) : (
                              visibleSkills.map((sk) => (
                                <Pill key={sk} theme={theme} label={sk} mono />
                              ))
                            )}
                            {r.skills.length > 10 ? (
                              <Btn
                                theme={theme}
                                small
                                tone="foregroundMuted"
                                label={isExpanded ? "Show less" : `+${hiddenCount} more`}
                                onPress={() => setExpandedRoles({ ...expandedRoles, [r.role]: !isExpanded })}
                              />
                            ) : null}
                          </View>

                          {r.taskGrants.map((g) => (
                            <View key={g.task} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1] }}>
                              <Pill theme={theme} label={`Task ${g.task}`} tone="accent" lit />
                              {g.skills.map((sk) => (
                                <Pill key={sk} theme={theme} label={sk} tone="accent" mono />
                              ))}
                            </View>
                          ))}
                        </View>
                      );
                    })}
                </View>
              ))}
            </View>
          )}
        </View>
      ) : null}
    </Card>
  );
}
