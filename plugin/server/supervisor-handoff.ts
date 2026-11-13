/** Supervisor continuity; called only on the Lead mailbox's serialized Project lane. */
import { z } from 'zod';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, readOptionalJson } from './core/json-store.ts';
import { loadLanes } from './core/lanes.ts';
import { projectStateDir, projectNotebookPath, readProjectRegistration, writeProjectRegistration } from './core/project.ts';
import { readLeadMailbox, requeueLeadMail, deliverLeadMail } from './core/mailbox.ts';
import { buildSeatKickoffPacket } from './core/preflight.ts';
import { capHandoffText, validHandoffText } from './handoff-text.ts';
import { laneRef, laneValue, readHandoffProgress, writeHandoffProgress } from './handoff-progress.ts';
import { buildSubstituteHandover, readHandoverGit, readNotebook } from './substitute-handover.ts';
import type { HandoffProgress, HandoffRequest, HandoffReply } from '../shared/handoff.ts';
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from './surface-rpc.ts';
import type { LeadMailItem } from './core/mailbox.ts';

export const SUPERVISOR_HANDOFF_MAX_BYTES = 4 * 1024;
const EpisodeSchema = z.object({ outgoingId: z.string(), requestedAt: z.string(), successorId: z.string().optional(), text: z.string().optional(), kickoff: z.string().optional(), kickoffDelivered: z.boolean().optional(), noticeSent: z.boolean().optional() });
type Episode = z.infer<typeof EpisodeSchema>;
export function createSupervisorHandoffRuntime(deps: {
  stateDir: string; daemon(): SurfaceDaemonApi; timeoutMs: number;
  onLane<T>(slug: string, job: () => Promise<T>): Promise<T>;
  evidence(slug: string): { digest: string; tasks: string; events: Parameters<typeof buildSeatKickoffPacket>[0]['ledgerEvents'] };
  renderMail(items: readonly LeadMailItem[]): string;
  markKickoffSent(id: string): void;
  retire(slug: string, agent: SurfaceAgentSnapshot): Promise<void>;
  log(message: string): void;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const path = (slug: string, name: string) => join(projectStateDir(deps.stateDir, slug), name);
  const progress = (slug: string) => readHandoffProgress(deps.stateDir, slug, 'supervisor');
  const episode = (slug: string): Episode | undefined => { const parsed = EpisodeSchema.safeParse(readOptionalJson(path(slug, 'supervisor-handoff-extraction.json'))); return parsed.success ? parsed.data : undefined; };
  const save = (slug: string, value: Episode) => atomicJson(path(slug, 'supervisor-handoff-extraction.json'), value);
  const update = (slug: string, patch: Partial<HandoffProgress>) => {
    const current = progress(slug); if (current) writeHandoffProgress(deps.stateDir, slug, { ...current, ...patch, updatedAt: new Date().toISOString() });
  };
  const active = (slug: string) => { const current = progress(slug); return current !== null && current.state !== 'done'; };
  const clearTimer = (slug: string) => { clearTimeout(timers.get(slug)); timers.delete(slug); };
  const live = async () => (await deps.daemon().agents.list({ filter: { includeArchived: false, includeBackground: true } })).entries.map(e => e.agent).filter(a => !a.archivedAt);
  const textOnDisk = (slug: string) => { try { return readFileSync(path(slug, 'supervisor-handoff.md'), 'utf8'); } catch { return ''; } };

  const complete = async (slug: string, extracted?: string | null): Promise<void> => {
    const reg = readProjectRegistration(deps.stateDir, slug); const current = progress(slug); const data = episode(slug);
    if (!reg || !current || !data) return;
    clearTimer(slug);
    const evidence = deps.evidence(slug);
    if (!data.text) {
      let timeline = '(outgoing Supervisor unavailable)';
      try { const entries = (await deps.daemon().agents.ref(data.outgoingId).timeline.refetch({ limit: 10 })).entries; timeline = (entries ?? []).map(e => JSON.stringify(e)).join('\n'); } catch { /* bounded evidence is optional */ }
      const source = validHandoffText(extracted) ? 'extracted' : 'substitute';
      if (source === 'substitute') update(slug, { state: 'substitute' });
      data.text = source === 'extracted' ? capHandoffText(extracted!, SUPERVISOR_HANDOFF_MAX_BYTES) : buildSubstituteHandover({ ...evidence, notebook: readNotebook(projectNotebookPath(deps.stateDir, slug)), git: readHandoverGit(reg.root), timeline, maxBytes: SUPERVISOR_HANDOFF_MAX_BYTES });
      writeFileSync(path(slug, 'supervisor-handoff.md'), data.text);
      save(slug, data); update(slug, { state: 'creating-successor', handover: source });
    }
    const agents = await live();
    if (!data.successorId) {
      const lane = laneValue(current.toLane); const parsed = current.toLane;
      const config = { provider: `${parsed.provider}/${parsed.model}`, ...(parsed.thinking ? { thinkingOptionId: parsed.thinking } : {}) };
      try {
        const input = { config, title: 'Supervisor', labels: { seat: 'supervisor', project: slug } };
        const handle = reg.workspaceId && deps.daemon().workspaces
          ? await deps.daemon().workspaces!.ref(reg.workspaceId).agents.create(input)
          : await deps.daemon().agents.create({ ...input, cwd: reg.root });
        data.successorId = handle.id; save(slug, data);
        deps.log(`Supervisor handoff: created ${handle.id} on ${lane}`);
      } catch (error) { update(slug, { state: 'failed', failure: String(error) }); return; }
    }
    writeProjectRegistration(deps.stateDir, slug, { root: reg.root, supervisor: data.successorId });
    if (!data.kickoffDelivered) {
      const mailboxPath = path(slug, 'mailbox.jsonl');
      let mail = readLeadMailbox(mailboxPath);
      // The outgoing seat's unacknowledged turn belongs to its successor too.
      if (mail.supervisorInFlight?.toAgentId === data.outgoingId) {
        const batch = mail.supervisorInFlight;
        requeueLeadMail(mailboxPath, { to: 'supervisor', deliveryId: batch.deliveryId, mailIds: batch.items.map(i => i.mailId), reason: 'supervisor-handoff' });
        mail = readLeadMailbox(mailboxPath);
      }
      const lanes = loadLanes(deps.stateDir, slug);
      const lead = agents.find(a => a.id === reg.lead);
      data.kickoff ??= `${buildSeatKickoffPacket({ role: 'supervisor', projectSlug: slug, projectRoot: reg.root, ledgerEvents: evidence.events, ...(lanes.ok ? { lanes: lanes.lanes } : {}), stateDir: deps.stateDir, omitSystemPromptDuplicates: true })}\n\n# Supervisor handover\n${data.text}\n\nLive Lead: ${lead?.id ?? '(none)'}\nOpen Tasks:\n${evidence.tasks || '(none)'}\nHeld reports: ${mail.supervisorQueued.length}`;
      save(slug, data);
      // Send before marking any report delivered. A failed send keeps this exact kickoff durable.
      await deps.daemon().agents.ref(data.successorId).send(data.kickoff + (mail.supervisorQueued.length ? `\n\n${deps.renderMail(mail.supervisorQueued)}` : ''));
      deps.markKickoffSent(data.successorId);
      if (mail.supervisorQueued.length) deliverLeadMail(mailboxPath, { to: 'supervisor', mailIds: mail.supervisorQueued.map(i => i.mailId), toAgentId: data.successorId });
      data.kickoffDelivered = true; save(slug, data);
    }
    const outgoing = agents.find(a => a.id === data.outgoingId);
    if (outgoing) {
      if (!data.noticeSent) {
        try { await deps.daemon().agents.ref(outgoing.id).send(`Your successor is Supervisor ${data.successorId}; this chat is released.`); } catch { /* an errored seat may reject the notice */ }
        data.noticeSent = true; save(slug, data);
      }
      await deps.retire(slug, outgoing);
    }
    update(slug, { state: 'done', failure: undefined });
  };
  const arm = (slug: string, ms: number) => {
    clearTimer(slug); const timer = setTimeout(() => { timers.delete(slug); void deps.onLane(slug, () => complete(slug)).catch(error => deps.log(`Supervisor handoff resume failed: ${String(error)}`)); }, Math.max(0, ms)); timer.unref?.(); timers.set(slug, timer);
  };
  const pump = async (slug: string) => {
    if (!active(slug) || progress(slug)?.state === 'failed') return;
    const data = episode(slug); if (!data) return;
    if (data.text) { await complete(slug); return; }
    const remaining = deps.timeoutMs - (Date.now() - Date.parse(data.requestedAt));
    if (remaining <= 0 || !(await live()).some(a => a.id === data.outgoingId && a.status !== 'error')) await complete(slug);
    else if (!timers.has(slug)) arm(slug, remaining);
  };
  return {
    active, pump,
    stop() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
    reset(slug: string) { clearTimer(slug); writeHandoffProgress(deps.stateDir, slug, null, 'supervisor'); rmSync(path(slug, 'supervisor-handoff-extraction.json'), { force: true }); },
    async turnEnded(slug: string, id: string, text: string | null, completed: boolean) {
      if (!active(slug) || episode(slug)?.outgoingId !== id || progress(slug)?.state !== 'handing-over') return false;
      await complete(slug, completed ? text : undefined); return true;
    },
    async request(input: HandoffRequest): Promise<HandoffReply> {
      if (input.action === 'handover') return { ok: true, progress: progress(input.slug), text: textOnDisk(input.slug), source: progress(input.slug)?.handover ?? (textOnDisk(input.slug).startsWith('# Plugin-built') ? 'substitute' : 'extracted') };
      const slug = input.slug; const reg = readProjectRegistration(deps.stateDir, slug); if (!reg) return { ok: false, code: 'unknown-project', error: 'Project not registered' };
      const current = progress(slug);
      if (input.action === 'cancel') return { ok: false, code: 'handoff-not-scheduled', error: 'Supervisor extraction has started and cannot be canceled' };
      if (input.action === 'retry') {
        if (current?.state !== 'failed') return { ok: false, code: 'handoff-not-failed', error: 'Only a failed handoff can be retried' };
        update(slug, { state: 'creating-successor', failure: undefined }); await complete(slug); return { ok: true, progress: progress(slug) };
      }
      if (active(slug)) {
        if (input.action === 'replaceNow' && current && ['handing-over', 'substitute', 'creating-successor', 'failed'].includes(current.state)) { await complete(slug); return { ok: true, progress: progress(slug) }; }
        return { ok: false, code: 'handoff-in-progress', error: 'A Supervisor handoff is already active' };
      }
      const lanes = loadLanes(deps.stateDir, slug); if (!lanes.ok) return { ok: false, code: 'lanes-unreadable', error: lanes.reason };
      const outgoing = (await live()).find(a => a.id === reg.supervisor);
      if (!outgoing && !reg.supervisor) return { ok: false, code: 'no-supervisor', error: 'Start a Supervisor before handing it off' };
      const now = new Date().toISOString(); const data: Episode = { outgoingId: reg.supervisor!, requestedAt: now };
      save(slug, data);
      writeHandoffProgress(deps.stateDir, slug, { seat: 'supervisor', reason: input.reason ?? 'owner', state: 'handing-over', fromLane: laneRef(input.fromLane ?? lanes.lanes.supervisor), toLane: laneRef(input.toLane ?? lanes.lanes.supervisor), startedAt: now, updatedAt: now });
      if (input.action === 'replaceNow' || !outgoing || outgoing.status === 'error') await complete(slug);
      else {
        arm(slug, deps.timeoutMs);
        try { await deps.daemon().agents.ref(outgoing.id).send(`Supervisor handoff: reply first with a short continuity handover in three sections: Owner goals, Decisions taken, Open questions. Keep it below ${SUPERVISOR_HANDOFF_MAX_BYTES} UTF-8 bytes. Do not dispatch work or message the Lead; the plugin persists your reply and hands held reports to your successor.`); }
        catch { await complete(slug); }
      }
      return { ok: true, progress: progress(slug) };
    },
  };
}
