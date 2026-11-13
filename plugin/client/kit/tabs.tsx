/**
 * Underline tabs — a controlled row over one hairline; the active tab's 2px
 * accent bar sits on the hairline. React Native primitives, theme colours only.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import { RADIUS, SPACING, hoveredOf, text } from "./theme.ts";

export function Tabs<Id extends string>({
  theme,
  tabs,
  value,
  onChange,
  testID,
}: {
  theme: PluginTheme;
  tabs: readonly { id: Id; label: string; badge?: number }[];
  value: Id;
  onChange: (id: Id) => void;
  /** The container hook; each tab is `${testID}-${id}`. */
  testID: string;
}) {
  return (
    <View
      accessibilityRole="tablist"
      testID={testID}
      style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            testID={`${testID}-${tab.id}`}
            onPress={() => {
              if (!selected) onChange(tab.id);
            }}
            style={(state) => ({
              paddingHorizontal: SPACING[3],
              paddingVertical: SPACING[2],
              flexDirection: "row",
              alignItems: "center",
              gap: SPACING[1.5],
              // The 2px bar is the tab's own bottom border pulled down over the container's hairline.
              borderBottomWidth: 2,
              borderBottomColor: selected ? theme.colors.accent : "transparent",
              marginBottom: -1,
              // Hover only brightens the label, so it never reads as selection.
              opacity: state.pressed ? 0.8 : 1,
            })}
          >
            {(state) => {
              const hovered = hoveredOf(state);
              return (
                <>
                  <Text
                    style={{
                      ...text(theme, "section"),
                      color: selected || hovered ? theme.colors.foreground : theme.colors.foregroundMuted,
                    }}
                    numberOfLines={1}
                  >
                    {tab.label}
                  </Text>
                  {tab.badge !== undefined && tab.badge > 0 ? (
                    <View
                      style={{
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                        borderRadius: RADIUS.sm,
                        backgroundColor: theme.colors.surface2,
                      }}
                    >
                      <Text style={{ ...text(theme, "badge"), fontSize: 10, lineHeight: 13, fontVariant: ["tabular-nums"] }}>{tab.badge}</Text>
                    </View>
                  ) : null}
                </>
              );
            }}
          </Pressable>
        );
      })}
    </View>
  );
}
