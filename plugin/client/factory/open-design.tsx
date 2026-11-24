import type { PluginTheme } from '@getpaseo/plugin';
import { useRpc, openExternalUrl } from '@getpaseo/plugin/client';
import { Modal, ScrollView } from '@getpaseo/plugin/client/ui';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { openDesignCatalog, openDesignStatus, openDesignSync, openDesignUnlink, openDesignPreview } from '../../shared/rpc.ts';
import type { z } from 'zod';
import { Btn } from '../kit/pill.tsx';
import { RADIUS, SPACING, factoryPalette, text, tint } from '../kit/theme.ts';
import { resolveReachableStudioUrl } from './studio-url.ts';
import { StudioRelay } from './studio-relay.tsx';
import type { StudioPayload } from './studio-relay.tsx';
import { readLocalDesign, readGrantedDesign, readLocalDesignCatalog, designDirectoryStore } from './local-design.ts';
import type { DesignDirectory } from './local-design.ts';

type Catalog = Extract<z.output<typeof openDesignCatalog.output>, { ok: true }>['projects'];
type Link = Extract<z.output<typeof openDesignStatus.output>, { ok: true }>['link'];
/**
 * The Open Design controller (v0.6.0 W6, ADR 0056; unified Project-tab row in
 * v0.23.x): `unified` owns the single 5s granted-folder sync poll, Link/Change,
 * Open Studio, Sync, and 1-click Unlink in one row; legacy `card` and `menu`
 * parts remain supported for split hosts. Mobile mounts none — the card shows
 * the link status alone. Remote runs consume the pushed workspace copy.
 */
export function OpenDesignControl({
  theme,
  root,
  sourceKey = root,
  onChanged,
  part = 'card',
}: {
  theme: PluginTheme;
  root: string;
  sourceKey?: string;
  onChanged: () => void;
  part?: 'card' | 'menu' | 'unified';
}) {
  const palette = factoryPalette(theme);
  const isCard = part === 'card';
  const isMenu = part === 'menu';
  const isUnified = part === 'unified';
  const ownsPoll = isCard || isUnified;
  const catalog = useRpc(openDesignCatalog), status = useRpc(openDesignStatus), sync = useRpc(openDesignSync), unlink = useRpc(openDesignUnlink), preview = useRpc(openDesignPreview);
  const [link, setLink] = useState<Link>(null), [update, setUpdate] = useState(false), [projects, setProjects] = useState<Catalog>([]);
  const [localProjects, setLocalProjects] = useState<Awaited<ReturnType<typeof readLocalDesignCatalog>>>([]);
  const [picking, setPicking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [studio, setStudio] = useState<StudioPayload | null>(null);
  const lane = useRef<Promise<void>>(Promise.resolve());
  const serialized = <T,>(work: () => Promise<T>): Promise<T> => { const next = lane.current.catch(() => {}).then(work); lane.current = next.then(() => {}, () => {}); return next; };
  const local = useRef<DesignDirectory | undefined>(undefined), current = useRef<Link>(null), syncing = useRef(false);
  const refresh = async () => {
    const result = await status({ projectRoot: root }); if (!result.ok) throw new Error(result.error);
    setLink(result.link); current.current = result.link; setUpdate(result.updateAvailable);
    return result;
  };
  useEffect(() => {
    // The menu part only reads the link once — card and unified parts own the poll.
    if (!ownsPoll) { void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e))); return; }
    let stopped = false;
    const poll = async () => {
      if (syncing.current) return;
      syncing.current = true;
      try { await serialized(async () => {
        if (stopped) return;
        const state = await status({ projectRoot: root }); if (!state.ok) throw new Error(state.error);
        if (stopped) return;
        setLink(state.link); current.current = state.link; setUpdate(state.updateAvailable);
        if (!local.current) local.current = await designDirectoryStore(sourceKey);
        if (local.current && state.link && await local.current.queryPermission({ mode: 'read' }) === 'granted') {
          const bundle = await readGrantedDesign(local.current);
          if (stopped) return;
          if (bundle.project.projectId !== state.link.projectId) { local.current = undefined; await designDirectoryStore(sourceKey, null); setError('The linked project changed in another window. Select its source folder to resume syncing.'); return; }
          if (state.syncRequestId || bundle.project.digest !== state.link.digest || bundle.project.sourceUpdatedAt > state.link.sourceUpdatedAt) {
            setUpdate(true);
            // A granted client folder is synchronized while the Owner is working in Factory.
            const result = await sync({ projectRoot: root, bundle, syncRequestId: state.syncRequestId, expectedDigest: state.link.digest }); if (!result.ok) throw new Error(result.error);
            if (!stopped) { setLink(result.link); setUpdate(false); }
          }
        }
      }); } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : String(e)); }
      finally { syncing.current = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [root, sourceKey, status, sync, ownsPoll]);
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await serialized(work); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const openPicker = () => void act(async () => {
    setPicking(true);
    const response = await catalog({});
    if (!response.ok) throw new Error(response.error);
    setProjects(response.projects);
    const saved = await designDirectoryStore('catalog');
    if (saved && await saved.queryPermission({ mode: 'read' }) === 'granted') setLocalProjects(await readLocalDesignCatalog(saved));
  });
  const runSync = () => void act(async () => {
    const bundle = local.current ? await readGrantedDesign(local.current) : undefined;
    const response = await sync({ projectRoot: root, bundle });
    if (!response.ok) throw new Error(response.error);
    await refresh();
  });
  const openStudio = () => void act(async () => {
    if (!link) return;
    let url: string | null = null;
    try { const response = await preview({ projectRoot: root, operation: 'preview.url' }); if (response.ok) url = await resolveReachableStudioUrl(response.urls ?? (response.url ? [response.url] : []), link.digest); } catch { /* Relay remains available. */ }
    if (url) await openExternalUrl(url);
    else { const response = await preview({ projectRoot: root, operation: 'preview.bundle' }); if (!response.ok) throw new Error(response.error); setStudio(response.bundle as StudioPayload); }
  });
  const runUnlink = () => void act(async () => {
    const response = await unlink({ projectRoot: root });
    if (!response.ok) throw new Error(response.error);
    local.current = undefined;
    await designDirectoryStore(sourceKey, null);
    await refresh();
  });
  const linkLocal = async () => {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<DesignDirectory> }).showDirectoryPicker;
    if (!picker) throw new Error('Local folder access is unavailable here. Open Factory in Paseo Desktop on the design host to link its catalog.');
    const directory = await picker({ mode: 'read' });
    try { await directory.getDirectoryHandle('projects'); const entries = await readLocalDesignCatalog(directory); await designDirectoryStore('catalog', directory); setLocalProjects(entries); return; } catch { /* A single project folder also works. */ }
    const bundle = await readLocalDesign(directory);
    const result = await sync({ projectRoot: root, bundle }); if (!result.ok) throw new Error(result.error);
    local.current = directory; await designDirectoryStore(sourceKey, directory); setPicking(false); await refresh();
  };
  const syncLabel = busy ? 'Syncing…' : update ? 'Update available — Sync' : 'Sync';
  const errorNode = error ? (
    <View style={{ borderRadius: RADIUS.md, borderWidth: 1, borderColor: tint(palette.bad, '66'), backgroundColor: tint(palette.bad, '12'), paddingHorizontal: SPACING[2], paddingVertical: SPACING[1.5] }}>
      <Text accessibilityRole="alert" style={{ ...text(theme, 'label'), color: palette.bad }}>{error}</Text>
    </View>
  ) : null;
  return <View style={{ gap: SPACING[2] }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING[1.5] }}>
      {isMenu ? <Btn theme={theme} small icon="Palette" label={link ? `Linked: ${link.projectName} — change…` : 'Link Open Design…'} disabled={busy} onPress={openPicker} /> : null}
      {isMenu && link ? <Btn theme={theme} small label="Unlink" disabled={busy} onPress={runUnlink} /> : null}
      {isCard && link ? <>
        <Btn theme={theme} small icon="RefreshCw" testID="factory-open-design-sync" label={syncLabel} disabled={busy} onPress={runSync} />
        <Btn theme={theme} small icon="ExternalLink" testID="factory-open-design-studio" label="Open Design Studio" disabled={busy} onPress={openStudio} />
      </> : null}
      {isUnified && !link ? <Btn theme={theme} small icon="Palette" variant="secondary" testID="factory-open-design-link" label="Link Open Design…" disabled={busy} onPress={openPicker} /> : null}
      {isUnified && link ? <>
        <Btn theme={theme} small icon="ExternalLink" variant="primary" accentColour={palette.lead} testID="factory-open-design-studio" label="Open Studio" disabled={busy} onPress={openStudio} />
        <Btn theme={theme} small icon="RefreshCw" variant={update ? 'primary' : 'secondary'} {...(update ? { accentColour: palette.wait } : {})} testID="factory-open-design-sync" label={syncLabel} disabled={busy} onPress={runSync} />
        <Btn theme={theme} small variant="ghost" testID="factory-open-design-change" label="Change…" disabled={busy} onPress={openPicker} />
        <Btn theme={theme} small variant="ghost" accentColour={palette.bad} testID="factory-open-design-unlink" label="Unlink" disabled={busy} onPress={runUnlink} />
      </> : null}
    </View>
    {errorNode}
    {(isMenu || isUnified) && picking ? <Modal open title="Link Open Design project" onOpenChange={setPicking}><Modal.Content>
      <View style={{ gap: SPACING[3] }}>
        <Text style={text(theme, 'meta')}>Choose a project below. To discover designs on this computer, select the Open Design data folder once; an individual project folder also works.</Text>
        <Btn theme={theme} variant="primary" accentColour={palette.lead} icon="FolderOpen" label="Choose Open Design folder on this computer…" disabled={busy} onPress={() => void act(linkLocal)} />
        {errorNode}
        <ScrollView style={{ maxHeight: 420 }}><View style={{ gap: SPACING[2] }}>
          {localProjects.map(({ directory, bundle }) => <View key={'local-' + bundle.project.projectId} style={{ gap: SPACING[1] }}>
            <Btn theme={theme} label={bundle.project.projectName + ' · This computer'} disabled={busy} onPress={() => void act(async () => {
              const latest = await readGrantedDesign(directory); const result = await sync({ projectRoot: root, bundle: latest }); if (!result.ok) throw new Error(result.error);
              local.current = directory; await designDirectoryStore(sourceKey, directory); setPicking(false); await refresh();
            })} />
            <Text style={text(theme, 'meta')}>{bundle.project.screenCount} screens · {bundle.project.designSystemId ?? bundle.project.directionId ?? 'Custom design'} · {new Date(bundle.project.sourceUpdatedAt < 1e12 ? bundle.project.sourceUpdatedAt * 1000 : bundle.project.sourceUpdatedAt).toLocaleString()}</Text>
          </View>)}
          {projects.length === 0 ? <Text style={text(theme, 'meta')}>No Open Design projects found on this host.</Text> : projects.map(project => <View key={project.projectId} style={{ gap: SPACING[1] }}>
            <Btn theme={theme} label={project.projectName} disabled={busy} onPress={() => void act(async () => { const result = await sync({ projectRoot: root, projectId: project.projectId }); if (!result.ok) throw new Error(result.error); local.current = undefined; await designDirectoryStore(sourceKey, null); setPicking(false); await refresh(); })} />
            <Text style={text(theme, 'meta')}>{project.screenCount} screens · {project.designSystemId ?? project.directionId ?? 'Custom design'} · {new Date(project.sourceUpdatedAt < 1e12 ? project.sourceUpdatedAt * 1000 : project.sourceUpdatedAt).toLocaleString()}</Text>
          </View>)}
        </View></ScrollView>
      </View>
    </Modal.Content></Modal> : null}
    {(isCard || isUnified) && studio !== null ? <StudioRelay theme={theme} bundle={studio} close={() => setStudio(null)} /> : null}
  </View>;
}
