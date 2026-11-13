/** Real React error lifecycle without class syntax, which Hermes' bundle gate forbids. */
import type { PluginTheme } from "@getpaseo/plugin";
import { Component } from "react";
import type { ComponentClass, ErrorInfo, ReactNode } from "react";
import { Text, View } from "react-native";
import { SPACING, text } from "../kit/theme.ts";

type Props = { theme: PluginTheme; section: string; children: ReactNode };
type State = { error: Error | null };
type Instance = Component<Props, State>;

function Boundary(this: Instance, props: Props) {
  Component.call(this, props, undefined);
  this.state = { error: null };
}
Boundary.prototype = Object.create(Component.prototype);
Boundary.prototype.constructor = Boundary;
Boundary.getDerivedStateFromError = (error: unknown): State => ({ error: error instanceof Error ? error : new Error(String(error)) });
Boundary.prototype.componentDidCatch = function(this: Instance, error: Error, info: ErrorInfo) {
  console.error(`[Factory tab: ${this.props.section}]`, error, info.componentStack);
};
Boundary.prototype.render = function(this: Instance): ReactNode {
  const { theme, section, children } = this.props;
  if (this.state.error === null) return children;
  return <View testID="factory-tab-error" style={{ gap: SPACING[1], padding: SPACING[3] }}>
    <Text style={text(theme, "rowTitle", "statusDanger")}>{section} could not render</Text>
    <Text style={text(theme, "meta")}>{this.state.error.message}</Text>
  </View>;
};

export const FactoryTabErrorBoundary = Boundary as unknown as ComponentClass<Props, State>;
