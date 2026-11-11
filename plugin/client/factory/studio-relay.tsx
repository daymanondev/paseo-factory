import { useEffect, useMemo, useState } from 'react';
import { DocumentFrame, Modal } from '@getpaseo/plugin/client/ui';
import type { PluginTheme } from '@getpaseo/plugin';
import { Text, View } from 'react-native';
import { Btn } from '../kit/pill.tsx';
import { text, SPACING } from '../kit/theme.ts';
export interface StudioPayload { studioHtml: string; channel: string; activeGateId: string | null; model: { revision: number; runId: string; design: { revision: number; digest: string } } }
type MessageSource = { postMessage?: (message: unknown, origin: string) => void } | null;
export function StudioRelay({ theme, bundle, decide, close }: { theme: PluginTheme; bundle: StudioPayload; decide?: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: unknown }>; close: () => void }) {
  const [error, setError] = useState('');
  // The SDK frame takes a document URL (no DOM iframe on Paseo mobile); the Studio page travels as a data document.
  const url = useMemo(() => `data:text/html;charset=utf-8,${encodeURIComponent(bundle.studioHtml)}`, [bundle.studioHtml]);
  useEffect(() => {
    // React Native's `window` has no event methods: relay decisions only where the host can deliver them.
    const receive = async (event: MessageEvent) => {
      const data = event.data;
      // The SDK frame exposes no contentWindow, so authenticity rests on the per-open channel, gate and design digest.
      if (!event.source || data?.type !== 'factory:studio-decision' || data.channel !== bundle.channel || data.activeGateId !== bundle.activeGateId || !bundle.activeGateId || typeof data.id !== 'string') return;
      const payload = data.decision;
      if (!payload || payload.digest !== bundle.model.design.digest || payload.revision !== bundle.model.design.revision) return;
      let result: { ok: boolean; error?: string; data?: unknown };
      try { result = decide ? await decide(payload) : { ok: false, error: 'No active approval gate.' }; }
      catch (e) { result = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      if (!result.ok) setError(result.error ?? 'Decision rejected. Reopen Studio to refresh.');
      (event.source as MessageSource)?.postMessage?.({ type: 'factory:studio-result', channel: bundle.channel, id: data.id, ...result }, '*');
    };
    if (typeof window?.addEventListener === 'function') window.addEventListener('message', receive);
    return () => { if (typeof window?.removeEventListener === 'function') window.removeEventListener('message', receive); };
  }, [bundle, decide]);
  return <Modal open title="Open Design Studio" onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content><View style={{ gap: SPACING[2] }}>
      <Btn theme={theme} label="Close Studio" icon="X" onPress={close} />
      {error ? <Text style={text(theme, 'label', 'statusDanger')}>{error}</Text> : null}
      <View style={{ height: 480 }}><DocumentFrame url={url} testID="studio-frame" /></View>
    </View></Modal.Content>
  </Modal>;
}
