import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { SkillHubView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";

const FILTERS = [
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
export function SkillHubCard({
  theme,
  hub,
  busy,
  projectRoot,
  importSkill,
  togglePack,
  healSkills,
  updateSkills,
}: {
  theme: PluginTheme;
  hub?: SkillHubView;
  busy: boolean;
  projectRoot?: string;
  healSkills?: () => void;
  updateSkills?: () => void;
  importSkill?: (id: string) => void;
  togglePack?: (pack: string, enabled: boolean) => void;
}) {
  const [tab, setTab] = useState("installed"),
    [filter, setFilter] = useState("all");
  const row = {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: SPACING[1.5],
    alignItems: "center" as const,
  };
  if (!hub) return null;
  const skills = hub.installedSkills.filter(
    (s) =>
      filter === "all" ||
      s.pack === filter ||
      (filter === "outdated" && s.freshness === "update_available"),
  );
  return (
    <Card theme={theme} gap={SPACING[2.5]}>
      <Text style={text(theme, "section")}>
        Skill Hub — Inventory, Host Ecosystems &amp; Role Matrix
      </Text>
      <Text style={text(theme, "label", "foregroundMuted")}>
        {hub.totalInstalled} installed · {hub.updateAvailableCount} updates ·{" "}
        {hub.localCustomCount} local/custom · {hub.symlinkDriftCount} with link
        drift
      </Text>
      <View style={row}>
        {[
          ["installed", `Installed in Factory (${hub.totalInstalled})`],
          ["hosts", `Host Ecosystems (${hub.hostCatalog.length})`],
          ["matrix", "Role ↔ Skill Matrix"],
        ].map(([id, label]) => (
          <Btn
            key={id}
            theme={theme}
            label={label!}
            small
            solid={tab === id}
            onPress={() => setTab(id!)}
          />
        ))}
      </View>
      {tab === "installed" ? (
        <>
          <View style={row}>
            <Btn
              theme={theme}
              small
              label={
                hub.hostCatalog.find((e) => e.id === "expo:official-pack")
                  ?.status === "linked"
                  ? "Update Expo Pack"
                  : "Install Expo Pack (24)"
              }
              disabled={busy || !importSkill}
              onPress={() => importSkill?.("expo:official-pack")}
            />
            <Btn
              theme={theme}
              small
              label="Update Core & Tracked Skills"
              disabled={busy || !updateSkills}
              onPress={() => updateSkills?.()}
            />
            <Btn
              theme={theme}
              small
              label="Heal Symlinks"
              disabled={busy || !healSkills}
              onPress={() => healSkills?.()}
            />
          </View>
          <Text style={text(theme, "label")}>Project Skill Packs</Text>
          {!projectRoot ? (
            <Text style={text(theme, "label", "foregroundMuted")}>
              Select a Project to enable skill packs.
            </Text>
          ) : null}
          {hub.projectPacks.map((pack) => (
            <View key={pack.id} style={row}>
              <Text style={text(theme, "label")}>{pack.label}</Text>
              {pack.autoDetected ? (
                <Pill theme={theme} label="Auto-detected" />
              ) : null}
              <Btn
                theme={theme}
                small
                label={
                  pack.enabled ? "Enabled — disable" : "Enable for Project"
                }
                disabled={busy || !projectRoot || !togglePack}
                onPress={() => togglePack?.(pack.id, !pack.enabled)}
              />
            </View>
          ))}
          <Text style={text(theme, "label", "foregroundMuted")}>
            Pack changes apply to new seats. Existing sessions keep their
            current skills.
          </Text>
          <View style={row}>
            {FILTERS.map(([id, label]) => (
              <Btn
                key={id}
                theme={theme}
                small
                label={label!}
                solid={filter === id}
                onPress={() => setFilter(id!)}
              />
            ))}
          </View>
          {!skills.length ? (
            <Text style={text(theme, "label", "foregroundMuted")}>
              No skills match this filter. Import a pack from Host Ecosystems.
            </Text>
          ) : null}
          {skills.map((skill) => (
            <View key={skill.name} style={{ gap: SPACING[1] }}>
              <View style={row}>
                <Text style={text(theme, "label")}>{skill.name}</Text>
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
                      : "foregroundMuted"
                  }
                />
              </View>
              <Text style={text(theme, "label", "foregroundMuted")}>
                {skill.source} · {skill.revision?.slice(0, 7) ?? "local"}
              </Text>
              <View style={row}>
                {skill.harnesses.map((h) => (
                  <Pill
                    key={h.name}
                    theme={theme}
                    label={`${h.name}: ${!h.available ? "not installed" : h.healthy ? "linked" : "drift"}`}
                    tone={
                      h.available && !h.healthy
                        ? "statusWarning"
                        : "foregroundMuted"
                    }
                  />
                ))}
              </View>
              <View style={row}>
                {skill.roles.map((role) => (
                  <Pill key={role} theme={theme} label={ROLES[role] ?? role} />
                ))}
              </View>
            </View>
          ))}
        </>
      ) : tab === "hosts" ? (
        <>
          <Text style={text(theme, "label", "foregroundMuted")}>
            Host catalogs are read-only. Import copies portable skills into
            Factory.
          </Text>
          {hub.hostCatalog.map((entry) => (
            <View key={entry.id} style={{ gap: SPACING[1] }}>
              <Text style={text(theme, "label")}>
                {entry.name} · {entry.ecosystem}
              </Text>
              <Text style={text(theme, "label", "foregroundMuted")}>
                {entry.skills.length} skills
                {entry.mcpServers.length
                  ? ` · MCP: ${entry.mcpServers.join(", ")}`
                  : ""}
              </Text>
              <View style={row}>
                <Pill
                  theme={theme}
                  label={
                    entry.status === "linked"
                      ? "Linked in Factory"
                      : "Available on Host"
                  }
                />
                {entry.status === "available" && entry.skills.length ? (
                  <Btn
                    theme={theme}
                    small
                    label="+ Import to Factory"
                    disabled={busy || !importSkill}
                    onPress={() => importSkill?.(entry.id)}
                  />
                ) : null}
              </View>
            </View>
          ))}
        </>
      ) : (
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[4] }}
        >
          {["slp", "scrum"].map((mode) => (
            <View
              key={mode}
              style={{ flex: 1, minWidth: 220, gap: SPACING[2.5] }}
            >
              <Text style={text(theme, "section")}>
                {mode === "slp" ? "SLP Roles" : "Agile Scrum Roles"}
              </Text>
              {hub.roleMatrix
                .filter((r) => r.mode === mode)
                .map((r) => (
                  <View key={r.role} style={{ gap: SPACING[1] }}>
                    <Text style={text(theme, "label")}>
                      {ROLES[r.role] ?? r.role} ({r.skills.length})
                    </Text>
                    <Text style={text(theme, "label", "foregroundMuted")}>
                      {r.skills.join(" · ") || "No skills"}
                    </Text>
                    {r.taskGrants.map((g) => (
                      <Text
                        key={g.task}
                        style={text(theme, "label", "foregroundMuted")}
                      >
                        Task {g.task}: {g.skills.join(" · ")}
                      </Text>
                    ))}
                  </View>
                ))}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}
