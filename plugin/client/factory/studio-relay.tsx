import { useMemo } from 'react';
import { DocumentFrame, Modal } from '@getpaseo/plugin/client/ui';
import type { PluginTheme } from '@getpaseo/plugin';
import { View } from 'react-native';
import { Btn } from '../kit/pill.tsx';
import { SPACING } from '../kit/theme.ts';
/** The linked-design Studio is view-only (ADR 0056): the Scrum approval/decision relay is retired, so the frame needs no message listener. */
export interface StudioPayload { studioHtml: string; model: { revision: number; runId: string; design: { revision: number; digest: string } } }
export function StudioRelay({ theme, bundle, close }: { theme: PluginTheme; bundle: StudioPayload; close: () => void }) {
  // The SDK frame takes a document URL (no DOM iframe on Paseo mobile); the Studio page travels as a data document.
  const url = useMemo(() => `data:text/html;charset=utf-8,${encodeURIComponent(bundle.studioHtml)}`, [bundle.studioHtml]);
  return <Modal open title="Open Design Studio" onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content><View style={{ gap: SPACING[2] }}>
      <Btn theme={theme} label="Close Studio" icon="X" onPress={close} />
      <View style={{ height: 480 }}><DocumentFrame url={url} testID="studio-frame" /></View>
    </View></Modal.Content>
  </Modal>;
}
