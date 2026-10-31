import type { PluginTheme } from '@getpaseo/plugin';
import { TextInput } from '@getpaseo/plugin/client/ui';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { FactoryView } from '../../shared/view.ts';
import type { ScrumAction } from './scrum.tsx';
import { Btn } from '../kit/pill.tsx';
import { SPACING, text } from '../kit/theme.ts';
type Run = NonNullable<NonNullable<FactoryView['execution']>['run']>;
type Request = NonNullable<Run['ownerRequests']>[number];

export function useOwnerCommand(run: Run, action?: ScrumAction) {
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const request = useRef<{ key: string; id: string; revision: number } | null>(null);
  const submitting = useRef(false), rejected = useRef(false);
  const submit = async (operation: string, payload: Record<string, unknown>) => {
    if (!action || submitting.current) return;
    const key = JSON.stringify({ runId: run.runId, operation, payload });
    if (request.current?.key !== key) request.current = { key, id: `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`, revision: run.revision };
    submitting.current = true; rejected.current = false; setPending(true); setError(''); setMessage('');
    try {
      const reply = await action(operation, payload, run.runId, request.current.revision, request.current.id);
      if (!reply.ok) { rejected.current = true; setError(reply.error ?? 'Command failed. Refresh the run before changing or resubmitting this request.'); }
      else { request.current = null; setMessage('Recorded.'); }
    } catch (err) { setError(`${String(err)}. Retry sends the same request safely.`); }
    finally { submitting.current = false; setPending(false); }
  };
  const refresh = async () => {
    if (!action || submitting.current) return;
    submitting.current = true; setPending(true);
    try {
      const reply = await action('get');
      if (reply.ok) { if (rejected.current) request.current = null; setError(''); setMessage(request.current ? 'Run refreshed. Retry sends the original request safely.' : 'Run refreshed. Check its current state before submitting again.'); }
      else setError(reply.error ?? 'Could not refresh run. Try again.');
    } catch (err) { setError(String(err)); }
    finally { submitting.current = false; setPending(false); }
  };
  return { pending, error, message, submit, refresh };
}

export function CommandStatus({ theme, command }: { theme: PluginTheme; command: ReturnType<typeof useOwnerCommand> }) {
  return <View accessibilityLiveRegion="polite" style={{ gap: SPACING[1] }}>
    {command.pending ? <Text style={text(theme, 'meta')}>Recording…</Text> : null}
    {command.error ? <Text accessibilityRole="alert" style={text(theme, 'meta', 'statusDanger')}>{command.error}</Text> : null}
    {command.message ? <Text style={text(theme, 'meta')}>{command.message}</Text> : null}
    {command.error ? <Btn theme={theme} label="Refresh run" disabled={command.pending} onPress={() => void command.refresh()} /> : null}
  </View>;
}
function OwnerField({ theme, label, value, onChange, disabled, numeric = false }: {
  theme: PluginTheme; label: string; value: string; onChange(value: string): void; disabled: boolean; numeric?: boolean;
}) {
  return <View style={{ gap: SPACING[1], minWidth: 0 }}>
    <Text style={text(theme, 'meta')}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled} keyboardType={numeric ? 'number-pad' : 'default'}
      style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, padding: SPACING[2], color: theme.colors.foreground, backgroundColor: theme.colors.surface0, fontSize: 14 }} />
  </View>;
}
function OwnerQuestion({ theme, run, request, action, busy }: { theme: PluginTheme; run: Run; request: Request; action?: ScrumAction; busy: boolean }) {
  const [answer, setAnswer] = useState('');
  const command = useOwnerCommand(run, action), disabled = busy || command.pending || !action;
  return <View style={{ gap: SPACING[2] }}>
    <Text style={text(theme, 'rowTitle')}>{request.question}</Text>
    <Text selectable style={text(theme, 'meta')}>Request {request.id} · From {request.origin.role}</Text>
    <Text style={text(theme, 'meta')}>Holds {request.affected.map(d => `${d.kind} ${d.id}`).join(', ')}. Independent authorized work may continue.</Text>
    <OwnerField theme={theme} label="Answer or cancellation reason" value={answer} onChange={setAnswer} disabled={disabled} />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[2] }}>
      <Btn theme={theme} label="Record answer" solid disabled={disabled || !answer.trim()} onPress={() => void command.submit('wait.answer', { pendingId: request.id, rationale: answer.trim() })} />
      <Btn theme={theme} label="Cancel question" tone="foregroundMuted" disabled={disabled || !answer.trim()} onPress={() => void command.submit('wait.cancel', { pendingId: request.id, rationale: answer.trim() })} />
    </View>
    <Text style={text(theme, 'meta')}>Cancelling supplies no answer; dependent work stays held.</Text>
    <CommandStatus theme={theme} command={command} />
  </View>;
}
export function ScrumOwnerWork({ theme, run, action, busy, designReview }: {
  theme: PluginTheme; run: Run; action?: ScrumAction; busy: boolean; designReview?: ReactNode;
}) {
  const [amount, setAmount] = useState('8'), [rationale, setRationale] = useState(''), [reviewOpen, setReviewOpen] = useState(false);
  const command = useOwnerCommand(run, action), disabled = busy || command.pending || !action || !!run.cancellation || ['completed', 'cancelled'].includes(run.phase);
  const pending = (run.ownerRequests ?? []).filter(r => r.status === 'pending');
  const cancelled = (run.ownerRequests ?? []).filter(r => r.kind === 'question' && r.status === 'cancelled');
  const tasksUsed = run.tasks?.length ?? 0, tasksAllowed = run.budgets?.maxTasks;
  const validAmount = /^\d+$/.test(amount) && Number.isSafeInteger(Number(amount)) && Number(amount) > 0 && Number.isSafeInteger((tasksAllowed ?? 0) + Number(amount));
  const elapsed = run.createdAt ? Math.max(0, Math.floor((Date.now() - Date.parse(run.createdAt)) / 60_000)) : undefined;
  const legacyHeld = run.blockerDetails?.some(b => b.causes.includes('elapsed') || b.causes.includes('ambiguous'));
  return <View style={{ gap: SPACING[4] }}>
    <View style={{ gap: SPACING[2] }}>
      <Text style={text(theme, 'section')}>Waiting for you{pending.length ? ` (${pending.length})` : ''}</Text>
      {!pending.length ? <Text style={text(theme, 'meta')}>No pending Owner requests.</Text> : null}
      {pending.map(request => <View key={request.id} style={{ gap: SPACING[2], paddingVertical: SPACING[2], borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        {request.kind === 'question' ? <OwnerQuestion theme={theme} run={run} request={request} action={action} busy={disabled} /> : <>
          <Text style={text(theme, 'rowTitle')}>{request.question}</Text>
          <Text selectable style={text(theme, 'meta')}>{request.id}</Text>
          <Text style={text(theme, 'meta')}>Holds UI-dependent development. This review stays pending until your decision.</Text>
          <Btn theme={theme} label={reviewOpen ? 'Hide design review' : 'Review design'} disabled={disabled} onPress={() => setReviewOpen(!reviewOpen)} />
          {reviewOpen ? designReview : null}
        </>}
      </View>)}
      {cancelled.map(request => <Text key={request.id} style={text(theme, 'meta', 'statusWarning')}>Cancelled {request.id}: {request.affected.map(d => `${d.kind} ${d.id}`).join(', ')} remains held without an answer or authorized scope change.</Text>)}
    </View>
    <View style={{ gap: SPACING[2] }}>
      <Text style={text(theme, 'section')}>Work allowance</Text>
      <Text style={text(theme, 'rowTitle')}>Tasks {tasksUsed}/{tasksAllowed ?? '—'} used · Automatic QA fix rounds {run.fixRounds}/{run.budgets?.maxQaFixRounds ?? '—'} used</Text>
      {elapsed !== undefined ? <Text style={text(theme, 'meta')}>Elapsed duration (informational): {Math.floor(elapsed / 60)}h {elapsed % 60}m since run creation</Text> : null}
      {tasksAllowed !== undefined && tasksUsed >= tasksAllowed ? <Text style={text(theme, 'meta', 'statusWarning')}>Task capacity exhausted: {tasksUsed}/{tasksAllowed}. Add Task capacity to admit another Task.</Text> : null}
      {run.budgets && run.fixRounds >= run.budgets.maxQaFixRounds ? <Text style={text(theme, 'meta', 'statusWarning')}>Automatic QA fix rounds exhausted: {run.fixRounds}/{run.budgets.maxQaFixRounds}. A further automatic repair requires a separate +1 round.</Text> : null}
      <OwnerField theme={theme} label="Additional Tasks" value={amount} onChange={setAmount} disabled={disabled} numeric />
      {!validAmount ? <Text style={text(theme, 'meta', 'statusWarning')}>Enter a positive whole number within the supported allowance.</Text> : null}
      <OwnerField theme={theme} label="Allowance or continuation rationale" value={rationale} onChange={setRationale} disabled={disabled} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[2] }}>
        <Btn theme={theme} label={`Add ${validAmount ? amount : ''} Tasks`} disabled={disabled || !validAmount || !rationale.trim()} onPress={() => void command.submit('allowance.tasks', { amount: Number(amount), rationale: rationale.trim() })} />
        <Btn theme={theme} label="Add 1 automatic QA fix round" disabled={disabled || !rationale.trim()} onPress={() => void command.submit('allowance.qa', { amount: 1, rationale: rationale.trim() })} />
      </View>
      {legacyHeld ? <>
        <Text style={text(theme, 'meta')}>Legacy continuation removes only a proven elapsed-time hold. Other blockers and design approval still apply.</Text>
        <Btn theme={theme} label="Continue legacy time hold" disabled={disabled || !rationale.trim()} onPress={() => void command.submit('run.continue', { rationale: rationale.trim() })} />
      </> : null}
      <CommandStatus theme={theme} command={command} />
    </View>
  </View>;
}
