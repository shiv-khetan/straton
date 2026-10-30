import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Dataset } from '@/lib/api';
import { can, canPage } from '@/features/access/access-model';
import { Button, Icon } from '@/components/workbench/primitives';
import { datasetLabel } from '@/lib/view-model';
import { ConsoleDrawer, RunHistory } from '@/features/console/ConsoleDrawer';
import type { Command } from '@/features/console/workbench-model';
import { CommandPalette } from './CommandPalette';
import { buildCommands } from './commands';
import { ErrorBoundary } from './ErrorBoundary';
import { PageHeader } from './PageHeader';
import { PageRoutes } from './PageRoutes';
import type { EntityRequest, ModelRequest } from './PageRoutes';
import { Sidebar } from './Sidebar';
import { ShortcutsDialog } from './ShortcutsDialog';
import { TitleBar } from './TitleBar';
import { useEngineConnection } from './useEngineConnection';
import { useEngineData } from './useEngineData';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { lastPage, useRouteStore } from '@/stores/route';
import { isRoute } from '@/stores/route-history';
import { navItemOf, pageLabelOf, pageLayout, routeAvailable } from './navigation';
import { queryApi } from '@/lib/queryApi';
import { useLibrary } from '@/stores/library';
import type { LibraryEntry } from '@/stores/library';
import { safeStorage } from '@/stores/storage';
export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
function AppContent() {
  const cache = useQueryClient();
  const { page, navigate: setPage, reset: resetRoute } = useRouteStore();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [consoleCollapsed, setConsoleCollapsedState] = useState(
    () => safeStorage.getItem('straton:console:collapsed') !== 'false',
  );
  const setConsoleCollapsed = (value: boolean) => {
    setConsoleCollapsedState(value);
    safeStorage.setItem('straton:console:collapsed', String(value));
  };
  const [consoleTab, setConsoleTab] = useState('Live events');
  const [modelRequest, setModelRequest] = useState<ModelRequest | null>(null);
  const [entityRequest, setEntityRequest] = useState<EntityRequest | null>(null);
  const [usageChart, setUsageChart] = useState('');
  const [mapFocus, setMapFocus] = useState('');
  const [mapStatusFilter, setMapStatusFilter] = useState('');
  const [jobStateFilter, setJobStateFilter] = useState('');
  const [sheet, setSheet] = useState<'source' | 'job' | null>(null);
  const [jobSeed, setJobSeed] = useState<Dataset | null>(null);
  const [selection, setSelection] = useState('');
  const [selectionId, setSelectionId] = useState('');
  const selectEntity = useCallback((name: string, id = '') => {
    setSelection(name);
    setSelectionId(id);
  }, []);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [asRole, setAsRole] = useState('');
  const [busy, setBusy] = useState(false);
  const { connection, live, events, revision, refresh, installConnection } = useEngineConnection(
    cache,
    (next) => {
      setAsRole('');
      selectEntity('');
      setMapFocus('');
      setModelRequest(null);
      setEntityRequest(null);
      setSheet(null);
      resetRoute(next ? lastPage() : 'Connect');
    },
    setError,
  );
  const [qualityCreateRequest, setQualityCreateRequest] = useState(0);
  const rawClient = useMemo(() => (connection ? api(connection) : null), [connection]);
  const client = useMemo(() => (rawClient ? queryApi(rawClient, cache) : null), [rawClient, cache]);
  const data = useEngineData(rawClient, asRole);
  const { me, models, jobs, runs, map } = data;
  useGlobalShortcuts(
    me,
    () => setShortcutsOpen(true),
    () => setPaletteOpen((value) => !value),
  );
  const { visit, toggle, favorites } = useLibrary();
  const scope = (connection?.url ?? 'disconnected') + '|' + (me?.user.id ?? 'anonymous');
  const workspace = connection ? new URL(connection.url).host : 'Not connected';
  // Per-page transient state resets whenever the page changes.
  useEffect(() => {
    setSelection('');
    setQualityCreateRequest(0);
    if (page !== 'Models') setModelRequest(null);
    if (page !== 'Analytics') setUsageChart('');
  }, [page]);
  useEffect(() => {
    if (me && !routeAvailable(me, page)) setPage('Dashboard');
  }, [me, page, setPage]);
  useEffect(() => {
    if (['Favorites', 'Recent', 'Connect'].includes(page) || !me || !routeAvailable(me, page))
      return;
    // One recent entry per sidebar page; it reopens the section last visited.
    visit({
      id: 'page:' + navItemOf(page).route,
      label: pageLabelOf(page),
      kind: 'page',
      route: page,
      scope,
      visitedAt: Date.now(),
    });
  }, [page, scope, me?.user.id, visit]);
  const online = !!connection && live === 'Live';
  async function action(work: () => Promise<unknown>, message = 'Saved', local = false) {
    if (!local && !online && page !== 'Connect') {
      setError('Reconnect the engine before making changes.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
      refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  const datasets = map.nodes.filter((node): node is Dataset => node.type === 'dataset');
  const pageLabel = pageLabelOf(page);
  const openJobSheet = (seed: Dataset | null) => {
    setJobSeed(seed);
    setPage('Jobs');
    setSheet('job');
  };
  const forget = () =>
    action(
      async () => {
        await invoke('forget_connection');
        installConnection(null);
      },
      'Connection forgotten',
      true,
    );
  const primary =
    page === 'Data Quality' && !!me
      ? { label: 'New check', run: () => setQualityCreateRequest((n) => n + 1) }
      : page === 'Models' && !!me
        ? { label: 'New model', run: () => setModelRequest({ id: null, nonce: Date.now() }) }
        : page === 'Sources' && can(me, 'admin')
          ? { label: 'Add source', run: () => setSheet('source') }
          : page === 'Backups' && can(me, 'admin') && client
            ? {
                label: 'Back up now',
                run: () => void action(() => client.backup(), 'Backup created'),
              }
            : navItemOf(page).route === 'Dashboard' && can(me, 'sync_admin')
              ? { label: 'New sync job', run: () => openJobSheet(null) }
              : null;
  const commands = buildCommands(me, datasets, models, jobs, data.sources);
  function selectCommand(command: Command) {
    if (command.id.startsWith('route:')) {
      const route = command.id.slice(6);
      if (isRoute(route) && routeAvailable(me, route)) setPage(route);
      return;
    }
    if (['dataset', 'model', 'source'].includes(command.kind)) {
      visit({
        id: command.id,
        label: command.label,
        kind: command.kind as 'dataset' | 'model' | 'source',
        entityId: command.id.slice(command.id.indexOf(':') + 1),
        detail: command.detail,
        route:
          command.kind === 'dataset' ? 'Data Map' : command.kind === 'model' ? 'Models' : 'Sources',
        scope,
        visitedAt: Date.now(),
      });
    }
    if (command.id === 'sql') setPage('SQL');
    else if (command.id === 'new-model') {
      setPage('Models');
      setModelRequest({ id: null, nonce: Date.now() });
    } else if (command.id === 'new-job') openJobSheet(null);
    else if (command.kind === 'dataset') {
      setMapFocus('');
      requestAnimationFrame(() => setMapFocus(command.id.slice(8)));
      setMapStatusFilter('');
      setPage('Data Map');
    } else if (command.kind === 'model') {
      setPage('Models');
      setModelRequest({ id: command.id.slice(6), nonce: Date.now() });
    } else if (command.kind === 'job') {
      const job = jobs.find((j) => j.id === command.id.slice(4));
      if (job && online) void action(() => client!.runJob(job.id), 'Run queued');
    } else if (command.kind === 'source') {
      setPage('Sources');
      requestAnimationFrame(() => {
        const row = document.getElementById(command.id);
        row?.scrollIntoView({ block: 'center' });
        row?.focus();
      });
    }
  }
  async function openNotificationEntity(kind: string, id: string) {
    if (!client) return;
    if (kind === 'pipeline_run') {
      const run = await client.pipelineRun(id);
      setEntityRequest({ kind: 'pipeline', id: run.pipeline_id, runId: id, nonce: Date.now() });
      setPage('Pipelines');
    } else if (kind === 'check') {
      await client.qualityCheck(id);
      setEntityRequest({ kind, id, nonce: Date.now() });
      setPage('Data Quality');
    } else if (kind === 'run') {
      if (!canPage(me, 'Jobs')) throw new Error('Job history requires sync admin access.');
      setEntityRequest({ kind, id, nonce: Date.now() });
      setJobStateFilter('failed');
      setPage('Jobs');
    } else if (kind === 'backup' || kind === 'audit') {
      if (!canPage(me, 'Backups')) throw new Error('Security and backups require admin access.');
      setPage('Backups');
    } else setPage('Activity');
  }
  const selectedModel =
    page === 'Models' ? models.find((model) => model.id === selectionId) : undefined;
  const selectedDataset =
    page === 'Data Map' ? datasets.find((dataset) => dataset.id === selectionId) : undefined;
  const graphPage = page === 'Data Map' || page === 'Models';
  const entity = selectedDataset
    ? {
        id: 'dataset:' + selectedDataset.id,
        kind: 'dataset' as const,
        entityId: selectedDataset.id,
        label: datasetLabel(selectedDataset),
        route: 'Data Map' as const,
      }
    : selectedModel
      ? {
          id: 'model:' + selectedModel.id,
          kind: 'model' as const,
          entityId: selectedModel.id,
          label: selectedModel.name,
          route: 'Models' as const,
        }
      : {
          // Favorites hold the sidebar page, so the header star and the sidebar pin agree.
          id: 'page:' + navItemOf(page).route,
          kind: 'page' as const,
          label: pageLabel,
          route: navItemOf(page).route,
        };
  const currentEntry: LibraryEntry = { ...entity, scope, visitedAt: Date.now() };
  const favorite = favorites.some((entry) => entry.id === currentEntry.id && entry.scope === scope);
  function openEntry(entry: LibraryEntry) {
    if (!routeAvailable(me, entry.route)) return;
    if (entry.kind === 'page') setPage(entry.route);
    else
      selectCommand({
        id: entry.kind + ':' + entry.entityId,
        label: entry.label,
        kind: entry.kind,
        detail: entry.detail,
      });
  }
  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <TitleBar
        workspace={workspace}
        page={page}
        onNavigate={setPage}
        me={me}
        online={online}
        live={live}
        client={me ? client : null}
        onEntity={openNotificationEntity}
        onSearch={() => setPaletteOpen(true)}
        onConnect={() => setPage('Connect')}
        onForget={() => void forget()}
        busy={busy}
        connected={!!connection}
        consoleDisabled={page === 'Connect'}
        consoleCollapsed={consoleCollapsed}
        onConsole={() => setConsoleCollapsed(!consoleCollapsed)}
        onShortcuts={() => setShortcutsOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar me={me} scope={scope} onNavigate={setPage} />
        <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {connection && !online && (
            <div className="reconnect-banner" role="status">
              <Icon name="warning" />
              <span>{live}. Cached data is read-only while the engine reconnects.</span>
              <Button type="button" variant="ghost" onClick={() => setPage('Connect')}>
                Reconnect
              </Button>
            </div>
          )}
          <PageHeader
            page={page}
            pageLabel={pageLabel}
            selection={graphPage ? selection : ''}
            selectedDataset={selectedDataset}
            selectedModel={selectedModel}
            data={data}
            primary={primary}
            online={online}
            busy={busy}
            favorite={favorite}
            onToggleFavorite={() => toggle(currentEntry)}
            asRole={asRole}
            onAsRole={setAsRole}
            onRefresh={connection ? refresh : undefined}
          />
          <div
            className={
              'page-content' +
              { document: '', workbench: ' workbench-page', connect: ' connect-page' }[
                pageLayout[page]
              ]
            }
          >
            <PageRoutes
              page={page}
              pageLabel={pageLabel}
              navigate={setPage}
              scope={scope}
              data={data}
              datasets={datasets}
              events={events}
              connection={connection}
              client={client}
              online={online}
              busy={busy}
              action={action}
              error={error}
              notice={notice}
              onDismissError={() => setError('')}
              onDismissNotice={() => setNotice('')}
              installConnection={installConnection}
              forget={forget}
              revision={revision}
              refresh={refresh}
              asRole={asRole}
              entityRequest={entityRequest}
              onEntityRequest={setEntityRequest}
              modelRequest={modelRequest}
              onModelRequest={setModelRequest}
              qualityCreateRequest={qualityCreateRequest}
              usageChart={usageChart}
              onUsageChart={setUsageChart}
              jobStateFilter={jobStateFilter}
              onJobStateFilter={setJobStateFilter}
              mapStatusFilter={mapStatusFilter}
              onMapStatusFilter={setMapStatusFilter}
              mapFocus={mapFocus}
              onMapFocus={setMapFocus}
              sheet={sheet}
              onSheet={setSheet}
              jobSeed={jobSeed}
              openJobSheet={openJobSheet}
              onSelection={selectEntity}
              consoleCollapsed={consoleCollapsed}
              onConsoleCollapsed={setConsoleCollapsed}
              openEntry={openEntry}
            />
          </div>
          {!consoleCollapsed && page !== 'Connect' && (
            <ConsoleDrawer
              tab={consoleTab}
              onTab={setConsoleTab}
              collapsed={consoleCollapsed}
              onCollapsed={setConsoleCollapsed}
              events={events}
            >
              <RunHistory
                runs={runs}
                jobs={jobs}
                busy={busy || !online}
                cancel={
                  can(me, 'sync_admin')
                    ? (id) => void action(() => client!.cancelRun(id), 'Cancellation requested')
                    : undefined
                }
              />
            </ConsoleDrawer>
          )}
        </main>
      </div>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
        onSelect={selectCommand}
      />
    </div>
  );
}
