import { createElement, useEffect, useRef, useState } from 'react';
import { Modal } from '@getpaseo/plugin/client/ui';
import type { PluginTheme } from '@getpaseo/plugin';
import { Text, View } from 'react-native';
import { Btn } from '../kit/pill.tsx';
import { text, SPACING } from '../kit/theme.ts';
export interface StudioPayload { studioHtml: string; channel: string; activeGateId: string | null; model: { revision: number; runId: string; design: { revision: number; digest: string } } }
export function StudioRelay({ theme, bundle, decide, close }: { theme: PluginTheme; bundle: StudioPayload; decide?: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: unknown }>; close: () => void }) {
  const frame = useRef<HTMLIFrameElement | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame.current?.contentWindow || data?.type !== 'factory:studio-decision' || data.channel !== bundle.channel || data.activeGateId !== bundle.activeGateId || !bundle.activeGateId || typeof data.id !== 'string') return;
      const payload = data.decision;
      if (!payload || payload.digest !== bundle.model.design.digest || payload.revision !== bundle.model.design.revision) return;
      let result: { ok: boolean; error?: string; data?: unknown };
      try { result = decide ? await decide(payload) : { ok: false, error: 'No active approval gate.' }; }
      catch (e) { result = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      if (!result.ok) setError(result.error ?? 'Decision rejected. Reopen Studio to refresh.');
      frame.current?.contentWindow?.postMessage({ type: 'factory:studio-result', channel: bundle.channel, id: data.id, ...result }, '*');
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [bundle, decide]);
  return <Modal open title="Open Design Studio" onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content><View style={{ gap: SPACING[2] }}>
      <Btn theme={theme} label="Close Studio" icon="X" onPress={close} />
      {error ? <Text style={text(theme, 'label', 'statusDanger')}>{error}</Text> : null}
      {createElement('iframe', { ref: frame, title: 'Open Design Studio over Paseo', srcDoc: bundle.studioHtml, sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', style: { width: '100%', height: '75vh', minHeight: 480, border: 0 } })}
    </View></Modal.Content>
  </Modal>;
}
