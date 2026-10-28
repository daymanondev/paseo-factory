import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { createElement, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { FactoryView } from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { SPACING, text } from "../kit/theme.ts";
export type ScrumLane =
  | "supervisor"
  | "lead"
  | "pm"
  | "ux"
  | "architect"
  | "dev"
  | "qa"
  | "watch"
  | "retro";
export type ScrumAction = (
  operation: string,
  payload?: Record<string, unknown>,
  runId?: string,
  expectedRevision?: number,
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
export function ExecutionSelector({
  theme,
  view,
  setMode,
  busy,
}: {
  theme: PluginTheme;
  view: FactoryView;
  setMode?: (mode: "slp" | "scrum") => void;
  busy: boolean;
}) {
  const execution = view.execution;
  return (
    <View style={{ gap: SPACING[1] }}>
      <View
        style={{
          flexDirection: "row",
          gap: SPACING[2],
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Text style={text(theme, "label")}>
          {view.project ? "Execution" : "New Project default"}
        </Text>
        {(["slp", "scrum"] as const).map((mode) => (
          <Btn
            key={mode}
            theme={theme}
            label={
              (mode === "slp" ? "SLP" : "Agile Scrum") +
              (execution?.pendingMode === mode ? " · Resume switch" : "")
            }
            onPress={() => setMode?.(mode)}
            disabled={
              busy ||
              !setMode ||
              ((execution?.selectedMode ?? "slp") === mode &&
                execution?.pendingMode === undefined)
            }
          />
        ))}
        {execution?.run ? (
          <Pill
            theme={theme}
            label={`${execution.run.runId} · ${execution.run.phase} · r${execution.run.revision}`}
            tone="accent"
          />
        ) : null}
      </View>
      {execution?.error ? (
        <Text style={text(theme, "label")}>{execution.error}</Text>
      ) : null}
      {execution?.pendingMode ? (
        <Text style={text(theme, "label")}>
          Seat transition needs recovery. Dispatch is held until the switch
          completes.
        </Text>
      ) : null}
    </View>
  );
}
const CARDS: { title: string; lanes: ScrumLane[]; hint: string }[] = [
  {
    title: "Supervisor",
    lanes: ["supervisor"],
    hint: "Owner conversation and decisions",
  },
  {
    title: "Scrum Lead / PO",
    lanes: ["lead"],
    hint: "Tracks, contracts and semantic review",
  },
  {
    title: "PM / Analyst",
    lanes: ["pm"],
    hint: "Outcomes, requirements and assumptions",
  },
  {
    title: "UX Designer",
    lanes: ["ux"],
    hint: "Flows, states and browser mockups",
  },
  {
    title: "System Architect",
    lanes: ["architect"],
    hint: "Architecture rules and compatibility",
  },
  {
    title: "Senior Dev",
    lanes: ["dev"],
    hint: "Bounded vertical stories and test promotion",
  },
  {
    title: "QA / Test Architect",
    lanes: ["qa"],
    hint: "Independent product evidence",
  },
  {
    title: "Watch & Retro",
    lanes: ["watch", "retro"],
    hint: "Record-only verification feedback",
  },
];
export function ScrumSeatsPane({
  theme,
  view,
  busy,
  action,
  setMode,
  renderEditor,
}: {
  theme: PluginTheme;
  view: FactoryView;
  busy: boolean;
  action?: ScrumAction;
  setMode?: (mode: "slp" | "scrum") => void;
  renderEditor: (
    title: string,
    current: string,
    save: (value: string) => void,
    close: () => void,
  ) => ReactNode;
}) {
  const [editing, setEditing] = useState<number | null>(null),
    [name, setName] = useState(""),
    [armed, setArmed] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
      html: string;
      digest: string;
    } | null>(null),
    [rationale, setRationale] = useState("");
  const config = view.execution?.config,
    run = view.execution?.run;
  const save = (lanes: ScrumLane[], value: string) => {
    if (!config) return;
    void action?.("config.set", {
      config: {
        ...config,
        lanes: {
          ...config.lanes,
          ...Object.fromEntries(lanes.map((l) => [l, value])),
        },
      },
    });
    setEditing(null);
  };
  return (
    <View style={{ gap: SPACING[4] }}>
      <ExecutionSelector
        theme={theme}
        view={view}
        setMode={setMode}
        busy={busy}
      />
      <Card theme={theme} gap={SPACING[2]}>
        <Text style={text(theme, "section")}>Agile Scrum Team</Text>
        <Text style={text(theme, "label")}>
          Owner ⇄ Supervisor ⇄ Scrum Lead / PO ⇄ Specialist Tasks
        </Text>
        <Text style={text(theme, "label")}>
          {run && !["completed", "cancelled"].includes(run.phase)
            ? `Run roster frozen at configuration r${run.configRevision}. Edits below apply to future runs.`
            : "Each role has an independent model. Specialist Tasks use isolated worktrees."}
        </Text>
        <Btn
          theme={theme}
          label={`UI approval: ${config?.requireUiApproval === false ? "Optional" : "Required"}`}
          disabled={busy || !config}
          onPress={() =>
            config &&
            void action?.("config.set", {
              config: {
                ...config,
                requireUiApproval: !config.requireUiApproval,
              },
            })
          }
        />
      </Card>
      <Card theme={theme} gap={SPACING[2]}>
        <Text style={text(theme, "rowTitle")}>Scrum profiles</Text>
        <View
          style={{ flexDirection: "row", gap: SPACING[2], flexWrap: "wrap" }}
        >
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Profile name"
            accessibilityLabel="Scrum profile name"
          />
          <Btn
            theme={theme}
            label="Save profile"
            disabled={busy || !name.trim()}
            onPress={() =>
              void action?.("profile.save", {
                id: name
                  .trim()
                  .toLowerCase()
                  .replace(/[^a-z0-9._-]+/g, "-"),
                name: name.trim(),
              })
            }
          />
          <Btn
            theme={theme}
            label="Reset to Machine Default"
            disabled={busy}
            onPress={() => void action?.("config.reset")}
          />
        </View>
        {(view.execution?.profiles ?? []).map((profile) => (
          <View
            key={profile.id}
            style={{
              flexDirection: "row",
              gap: SPACING[2],
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <Text style={text(theme, "label")}>{profile.name}</Text>
            <Btn
              theme={theme}
              label="Apply"
              disabled={busy}
              onPress={() => void action?.("profile.apply", { id: profile.id })}
            />
            <Btn
              theme={theme}
              label="Update"
              disabled={busy}
              onPress={() =>
                void action?.("profile.save", {
                  id: profile.id,
                  name: profile.name,
                })
              }
            />
            <Btn
              theme={theme}
              label={armed === profile.id ? "Confirm delete" : "Delete"}
              disabled={busy}
              onPress={() =>
                armed === profile.id
                  ? (void action?.("profile.delete", { id: profile.id }),
                    setArmed(null))
                  : setArmed(profile.id)
              }
            />
          </View>
        ))}
      </Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[3] }}>
        {CARDS.map((card, i) => (
          <View key={card.title} style={{ flexGrow: 1, flexBasis: 260 }}>
            <Card theme={theme} gap={SPACING[2]}>
              <Text style={text(theme, "rowTitle")}>{card.title}</Text>
              <Text style={text(theme, "label")}>{card.hint}</Text>
              <Text style={text(theme, "code")}>
                {card.lanes
                  .map((l) => config?.lanes[l] ?? "Not configured")
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .join(" / ")}
              </Text>
              <Btn
                theme={theme}
                label="Choose model"
                disabled={busy || !config}
                onPress={() => setEditing(i)}
              />
            </Card>
          </View>
        ))}
      </View>
      {editing === null || !config
        ? null
        : renderEditor(
            CARDS[editing]!.title,
            config.lanes[CARDS[editing]!.lanes[0]!],
            (value) => save(CARDS[editing]!.lanes, value),
            () => setEditing(null),
          )}
      {run ? (
        <Card theme={theme} gap={SPACING[2]}>
          <Text style={text(theme, "rowTitle")}>
            {run.runId} · {run.phase}
          </Text>
          <Text style={text(theme, "label")}>
            QA: {run.qaResult?.status ?? "Awaiting audit"}. Fix rounds:{" "}
            {run.fixRounds}. Owner decisions: {run.decisions}. Design:{" "}
            {run.design?.decision ?? "Awaiting evidence"}.
          </Text>
          {run.design ? (
            <>
              <Text style={text(theme, "code")}>
                Design r{run.design.revision} · {run.design.digest.slice(0, 16)}
              </Text>
              <Btn
                theme={theme}
                label="Open accepted design preview"
                disabled={busy}
                onPress={() =>
                  void action?.("preview", {}, run.runId).then((reply) => {
                    const data = reply.data as
                      | { html?: string; digest?: string }
                      | undefined;
                    if (reply.ok && data?.html && data.digest)
                      setPreview({ html: data.html, digest: data.digest });
                  })
                }
              />
              {preview && preview.digest === run.design.digest
                ? createElement("iframe", {
                    title: "Accepted Scrum design preview",
                    sandbox: "allow-scripts",
                    srcDoc: preview.html,
                    referrerPolicy: "no-referrer",
                    style: { width: "100%", height: 520, border: 0 },
                  })
                : null}
              <TextInput
                value={rationale}
                onChangeText={setRationale}
                placeholder="Decision rationale"
                accessibilityLabel="Design decision rationale"
              />
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: SPACING[2],
                }}
              >
                {(["approved", "changes_requested", "waived"] as const).map(
                  (decision) => (
                    <Btn
                      key={decision}
                      theme={theme}
                      label={
                        decision === "approved"
                          ? "Approve revision"
                          : decision === "changes_requested"
                            ? "Request changes"
                            : "Waive this revision"
                      }
                      disabled={busy || !rationale.trim()}
                      onPress={() =>
                        void action?.(
                          "design.decide",
                          {
                            decision,
                            rationale: rationale.trim(),
                            revision: run.design!.revision,
                            digest: run.design!.digest,
                          },
                          run.runId,
                          run.revision,
                        )
                      }
                    />
                  ),
                )}
              </View>
            </>
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}
