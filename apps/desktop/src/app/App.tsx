import { StatePill } from '@/components/workbench/primitives';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { api, normalizeUrl, subscribe } from '@/lib/api';
import type { Connection, Dataset, EngineEvent, Source } from '@/lib/api';

import Explorer from '@/features/explorer/Explorer';
import QueryHistory from '@/features/sql/QueryHistory';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import Models from '@/features/transformations/Transformations';
import Access from '@/features/access/Access';
import BackupsView from '@/features/security/Backups';
import Dashboard from '@/features/overview/Overview';
import Connect from '@/features/connections/Connect';
import Sources from '@/features/connections/Connections';
import Jobs from '@/features/jobs/Jobs';
import { RunTable } from '@/features/jobs/RunTable';
import { can, canPage } from '@/features/access/access-model';
import { Breadcrumb, Button, Icon, Pill, Feedback } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import { ReadOnlyScope } from '@/components/workbench/ReadOnlyScope';
import { backupTime, datasetLabel, relativeTime } from '@/lib/view-model';
import { tableReference } from '@/features/sql/sql-model';
import { ConsoleDrawer, RunHistory, Skeleton, StatusChip } from '@/features/console/ConsoleDrawer';
import type { Command } from '@/features/console/workbench-model';
import { datasetState } from '@/features/console/workbench-model';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from './ErrorBoundary';
import { Sidebar } from './Sidebar';
import { ShortcutsDialog } from './ShortcutsDialog';
import { TitleBar } from './TitleBar';
import { useEngineData } from './useEngineData';
import { lastPage, useRouteStore } from '@/stores/route';
import { isRoute, laterRoutes, routeLabels } from '@/stores/route-history';
import type { Route } from '@/stores/route-history';
import { routeAvailable, navigation, sectionLabels, sectionOf } from './navigation';
import { queryApi } from '@/lib/queryApi';
import { queryKeys } from '@/lib/queryKeys';
import { eventQueryKeys } from '@/lib/events';
import { useLibrary } from '@/stores/library';
import type { LibraryEntry } from '@/stores/library';
import { LibraryPage } from '@/features/library/LibraryPage';
import { LaterPage } from '@/features/library/LaterPage';
import { safeStorage } from '@/stores/storage';
const Optimizer = lazy(() => import('@/features/optimizer/Optimizer'));
const Pipelines = lazy(() => import('@/features/pipelines/Pipelines'));
const Quality = lazy(() => import('@/features/quality/Quality'));
const Analytics = lazy(() => import('@/features/analytics/Analytics'));
const UsageChart = lazy(() => import('@/features/lineage/UsageChart'));
const Dashboards = lazy(() => import('@/features/dashboards/Dashboards'));
const Activity = lazy(() => import('@/features/activity/Activity'));
const Schedules = lazy(() => import('@/features/schedules/Schedules'));
const SqlView = lazy(() => import('@/features/sql/SqlWorkspace'));
const DataMapView = lazy(() => import('@/features/lineage/Lineage'));
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
  const [modelRequest, setModelRequest] = useState<{ id: string | null; nonce: number } | null>(
    null,
  );
  const [entityRequest, setEntityRequest] = useState<{
    kind: string;
    id: string;
    runId?: string;
    nonce: number;
  } | null>(null);
  const [usageChart, setUsageChart] = useState('');
  useEffect(() => {
    if (page !== 'Analytics') setUsageChart('');
  }, [page]);
  const [mapFocus, setMapFocus] = useState('');
  const [mapStatusFilter, setMapStatusFilter] = useState('');
  const [jobStateFilter, setJobStateFilter] = useState('');
  const [sheet, setSheet] = useState<'source' | 'job' | null>(null);
  const [jobSeed, setJobSeed] = useState<Dataset | null>(null);
  const querySeed = 'SELECT 1;';
  const setQuerySeed = (sql: string) => useSqlWorkspace.getState().add(sql);
  const [selection, setSelection] = useState('');
  const [selectionId, setSelectionId] = useState('');
  const selectEntity = useCallback((name: string, id = '') => {
    setSelection(name);
    setSelectionId(id);
  }, []);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [asRole, setAsRole] = useState('');
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState('Disconnected');
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const rawClient = useMemo(() => (connection ? api(connection) : null), [connection]);
  const client = useMemo(() => (rawClient ? queryApi(rawClient, cache) : null), [rawClient, cache]);
  const {
    me,
    roles,
    models,
    status,
    sources,
    jobs,
    runs,
    map,
    backups,
    loading,
    error: queryError,
  } = useEngineData(rawClient, asRole);
  // Global key handlers are registered once; they read the current identity through this ref.
  const meRef = useRef(me);
  meRef.current = me;
  const { visit, toggle, favorites } = useLibrary();
  const scope = (connection?.url ?? 'disconnected') + '|' + (me?.user.id ?? 'anonymous');
  const workspace = connection ? new URL(connection.url).host : 'Not connected';
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: queryKeys.all });
    setRevision((value) => value + 1);
  };
  function installConnection(next: Connection | null) {
    cache.clear();
    setAsRole('');
    setEvents([]);
    setLive(next ? 'Connecting' : 'Disconnected');
    selectEntity('');
    setMapFocus('');
    setModelRequest(null);
    setEntityRequest(null);
    setSheet(null);
    setConnection(next);
    resetRoute(next ? lastPage() : 'Connect');
  }
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    // The keychain can be briefly busy right after a restart or reload; retry once before
    // reporting, and keep install errors out of the "could not be loaded" message.
    const load = () => invoke<Connection | null>('load_connection');
    void load()
      .catch(() => new Promise((resolve) => setTimeout(resolve, 400)).then(load))
      .then(
        (saved) => {
          if (active && saved) installConnection({ ...saved, url: normalizeUrl(saved.url) });
        },
        () => {
          if (active)
            setError('Saved connection could not be loaded. Enter your connection below.');
        },
      );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setSelection('');
    if (page !== 'Models') setModelRequest(null);
  }, [page]);
  useEffect(() => {
    if (me && !routeAvailable(me, page)) setPage('Dashboard');
  }, [me, page, setPage]);
  useEffect(() => {
    if (!connection) return;
    return subscribe(
      connection,
      (event) => {
        if (event.type !== 'resync_required')
          setEvents((values) => [{ ...event, received_at: Date.now() }, ...values].slice(0, 500));
        const keys = eventQueryKeys(event);
        for (const queryKey of keys) void cache.invalidateQueries({ queryKey });
        if (keys.length) setRevision((value) => value + 1);
      },
      setLive,
    );
  }, [connection, cache]);
  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, [connection, cache]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest(
        'input, textarea, select, [contenteditable="true"], .monaco-editor',
      );
      if (event.key === '?' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setShortcutsOpen(true);
      }
      // Alt+1..5 jumps to a top-bar section's first page the user can open.
      if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {
        const group = navigation[Number(event.key) - 1];
        const target = group?.items.find((item) => routeAvailable(meRef.current, item.route));
        if (target) {
          event.preventDefault();
          useRouteStore.getState().navigate(target.route);
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if (
        event.altKey &&
        ['ArrowLeft', 'ArrowRight'].includes(event.key) &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        const routes = useRouteStore.getState();
        if (event.key === 'ArrowLeft') routes.back();
        else routes.forward();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  useEffect(() => {
    if (['Favorites', 'Recent', 'Connect'].includes(page) || !me || !routeAvailable(me, page))
      return;
    visit({
      id: 'page:' + page,
      label: routeLabels[page],
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
  const pageLabel = routeLabels[page];
  const newJob = () => {
    setJobSeed(null);
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
  const [qualityCreateRequest, setQualityCreateRequest] = useState(0);
  useEffect(() => {
    setQualityCreateRequest(0);
  }, [page]);
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
            : (page === 'Dashboard' || page === 'Jobs') && can(me, 'sync_admin')
              ? { label: 'New sync job', run: newJob }
              : null;
  const commands: Command[] = [
    ...[...navigation.flatMap((group) => group.items.map((item) => item.route)), 'Connect' as Route]
      .filter((route) => routeAvailable(me, route))
      .map((route) => ({
        id: 'route:' + route,
        label: routeLabels[route],
        kind: 'action' as const,
        detail: 'Go to page',
      })),
    ...(can(me, 'read')
      ? [{ id: 'sql', label: 'Open SQL', kind: 'action' as const, detail: 'SQL Studio' }]
      : []),
    ...(me
      ? [
          {
            id: 'new-model',
            label: 'New model',
            kind: 'action' as const,
            detail: 'SQL transformation',
          },
        ]
      : []),
    ...(can(me, 'sync_admin')
      ? [
          {
            id: 'new-job',
            label: 'New sync job',
            kind: 'action' as const,
            keywords: 'create pipeline',
          },
        ]
      : []),
    ...datasets.map((d) => ({
      id: 'dataset:' + d.id,
      label: datasetLabel(d),
      kind: 'dataset' as const,
      detail: d.sql_schema + '.' + d.sql_table,
    })),
    ...models.map((m) => ({
      id: 'model:' + m.id,
      label: m.name,
      kind: 'model' as const,
      detail: m.materialization + ' · ' + m.trigger,
    })),
    ...jobs.map((j) => ({
      id: 'job:' + j.id,
      label: 'Run job ' + j.name,
      kind: 'job' as const,
      detail: j.dataset,
    })),
    ...(canPage(me, 'Sources')
      ? sources.map((s) => ({
          id: 'source:' + s.id,
          label: s.name,
          kind: 'source' as const,
          detail: s.kind,
        }))
      : []),
  ];
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
    } else if (command.id === 'new-job') newJob();
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
      : { id: 'page:' + page, kind: 'page' as const, label: pageLabel, route: page };
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
        <Sidebar me={me} onNavigate={setPage} />
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
          <header className="page-header">
            <div>
              {page !== 'Dashboard' && page !== 'Connect' && (
                <Breadcrumb
                  items={[
                    sectionLabels[sectionOf(page).label],
                    pageLabel,
                    ...(selection && graphPage ? [selection] : []),
                  ]}
                />
              )}
              <div className="page-title">
                <h1>{graphPage && selection ? selection : pageLabel}</h1>
                {selectedDataset && (
                  <StatusChip state={datasetState(selectedDataset, jobs, runs)} />
                )}
                {selectedModel && (
                  <>
                    <StatusChip
                      state={
                        selectedModel.status === 'broken'
                          ? 'failed'
                          : (selectedModel.last_run_status ?? selectedModel.status)
                      }
                    />
                    <Pill>{selectedModel.materialization}</Pill>
                    <Pill>{selectedModel.cron ?? selectedModel.trigger}</Pill>
                  </>
                )}
                {page === 'Jobs' && (
                  <StatePill
                    state={runs.some((r) => r.state === 'running') ? 'running' : 'idle'}
                    label={runs.filter((r) => r.state === 'running').length + ' running'}
                  />
                )}
              </div>
              {status && page === 'Dashboard' && (
                <div
                  className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3 tabular-nums"
                  aria-label="Engine telemetry"
                >
                  <span>Queue {status.queue_depth}</span>
                  <span>
                    Running{' '}
                    {can(me, 'sync_admin')
                      ? runs.filter((run) => run.state === 'running').length
                      : '—'}
                  </span>
                  <span>
                    Up {Math.floor(status.uptime_seconds / 3600)} h{' '}
                    {Math.floor((status.uptime_seconds % 3600) / 60)} m
                  </span>
                  <span>Backup {relativeTime(backupTime(status.last_backup))}</span>
                </div>
              )}
            </div>
            <div className="actions">
              <span id="page-actions" className="contents" />
              {primary && (
                <Button
                  type="button"
                  variant="default"
                  disabled={!online || busy}
                  onClick={primary.run}
                >
                  <Icon name="plus" />
                  {primary.label}
                </Button>
              )}
              {!['Connect', 'Favorites', 'Recent'].includes(page) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={favorite ? 'Remove favorite' : 'Favorite this page or selection'}
                  aria-pressed={favorite}
                  onClick={() => toggle(currentEntry)}
                >
                  <Star size={18} className={favorite ? 'fill-ink' : ''} />
                </Button>
              )}
              {page === 'Data Map' && can(me, 'admin') && (
                <Field label="View as role">
                  <select
                    value={asRole}
                    onChange={(e) => {
                      setAsRole(e.target.value);
                    }}
                  >
                    <option value="">My access</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {connection && (
                <Button type="button" variant="ghost" disabled={busy} onClick={refresh}>
                  <Icon name="refresh" />
                  Refresh
                </Button>
              )}
            </div>
          </header>
          <div
            className={
              'page-content' +
              (graphPage || page === 'SQL' || page === 'Explorer' ? ' workbench-page' : '') +
              (page === 'Connect' ? ' connect-page' : '')
            }
          >
            <ReadOnlyScope
              disabled={!online && ['Sources', 'Jobs', 'Access', 'Backups'].includes(page)}
            >
              {queryError && <Feedback message={queryError} error onClose={() => {}} />}
              {loading && page !== 'Connect' && <Skeleton label="Loading engine workspace…" />}
              {laterRoutes.includes(page) && <LaterPage name={pageLabel} />}
              {(page === 'Favorites' || page === 'Recent') && (
                <LibraryPage
                  kind={page}
                  scope={scope}
                  onOpen={openEntry}
                  available={(entry) => routeAvailable(me, entry.route)}
                />
              )}
              {error && <Feedback message={error} error onClose={() => setError('')} />}
              {notice && <Feedback message={notice} onClose={() => setNotice('')} />}
              {page === 'Connect' && (
                <Connect
                  connection={connection}
                  busy={busy}
                  connect={(c) =>
                    action(async () => {
                      await api(c).me();
                      await invoke('save_connection', c as unknown as Record<string, unknown>);
                      installConnection(c);
                    }, 'Connection tested and saved in OS keychain')
                  }
                  forget={forget}
                />
              )}
              {client &&
                !loading &&
                me &&
                [
                  'Pipelines',
                  'Data Quality',
                  'Analytics',
                  'Dashboards',
                  'Activity',
                  'Schedules',
                ].includes(page) && (
                  <Suspense fallback={<Skeleton label={'Loading ' + pageLabel + '…'} />}>
                    {page === 'Pipelines' && (
                      <Pipelines
                        client={client}
                        me={me}
                        jobs={jobs}
                        models={models}
                        readOnly={!online}
                        request={entityRequest?.kind === 'pipeline' ? entityRequest : null}
                      />
                    )}
                    {page === 'Data Quality' && (
                      <Quality
                        client={client}
                        me={me}
                        datasets={datasets}
                        models={models}
                        readOnly={!online}
                        request={entityRequest?.kind === 'check' ? entityRequest : null}
                        createRequest={qualityCreateRequest}
                      />
                    )}
                    {page === 'Analytics' &&
                      (usageChart ? (
                        <UsageChart
                          client={client}
                          id={usageChart}
                          scope={scope}
                          onClose={() => setUsageChart('')}
                        />
                      ) : (
                        <Analytics client={client} me={me} scope={scope} readOnly={!online} />
                      ))}
                    {page === 'Dashboards' && (
                      <Dashboards
                        client={client}
                        me={me}
                        scope={scope}
                        readOnly={!online}
                        onAnalytics={() => setPage('Analytics')}
                      />
                    )}
                    {page === 'Activity' && <Activity client={client} me={me} />}
                    {page === 'Schedules' && (
                      <Schedules
                        client={client}
                        jobs={jobs}
                        models={models}
                        canSeeJobs={can(me, 'sync_admin')}
                        onNavigate={setPage}
                      />
                    )}
                  </Suspense>
                )}
              {client && !loading && me && page === 'Dashboard' && (
                <Dashboard
                  client={client}
                  me={me}
                  sources={map.nodes.filter((n) => n.type === 'source')}
                  models={models}
                  scope={scope}
                  readOnly={!online}
                  onQuery={(sql) => {
                    useSqlWorkspace.getState().add(sql);
                    setPage('SQL');
                  }}
                  backups={backups}
                  datasets={datasets}
                  runs={runs}
                  jobs={jobs}
                  status={status}
                  events={events}
                  canNavigate={(target) => canPage(me, target)}
                  navigate={(target, filter) => {
                    setPage(target);
                    setJobStateFilter(filter ?? '');
                    if (target === 'Data Map') setMapStatusFilter('succeeded');
                  }}
                >
                  <RunTable runs={runs.slice(0, 12)} jobs={jobs} />
                </Dashboard>
              )}
              {client && !loading && me && page === 'Models' && (
                <ErrorBoundary>
                  <Models
                    client={client}
                    me={me}
                    revision={revision}
                    changed={refresh}
                    events={events}
                    jobs={jobs}
                    runs={runs}
                    catalog={map}
                    cachedModels={models}
                    canCreateJob={(dataset) =>
                      online &&
                      can(me, 'sync_admin', dataset.source_id, dataset.id) &&
                      map.nodes.some(
                        (node) =>
                          node.type === 'source' &&
                          node.id === dataset.source_id &&
                          [
                            'postgres',
                            'sqlserver',
                            'sqlite',
                            'csv',
                            'stripe',
                            'salesforce',
                            'noop',
                          ].includes(node.kind),
                      )
                    }
                    onCreateJob={(dataset) => {
                      setJobSeed(dataset);
                      setSheet('job');
                      setPage('Jobs');
                    }}
                    onSelection={selectEntity}
                    onQueryDataset={(dataset) => {
                      setQuerySeed(
                        'SELECT * FROM ' +
                          tableReference(dataset.sql_schema, dataset.sql_table) +
                          ' LIMIT 100',
                      );
                      setPage('SQL');
                    }}
                    request={modelRequest}
                    consoleCollapsed={consoleCollapsed}
                    onConsoleCollapsed={setConsoleCollapsed}
                    readOnly={!online}
                    onQuery={(model) => {
                      setQuerySeed(
                        'SELECT * FROM ' + tableReference('models', model.name) + ' LIMIT 100',
                      );
                      setPage('SQL');
                    }}
                  />
                </ErrorBoundary>
              )}
              {client && !loading && me && canPage(me, 'Optimizer') && page === 'Optimizer' && (
                <Suspense fallback={<p role="status">Loading optimizer…</p>}>
                  <Optimizer client={client} me={me} datasets={datasets} readOnly={!online} />
                </Suspense>
              )}
              {client && !loading && canPage(me, 'Backups') && page === 'Backups' && (
                <BackupsView
                  client={client}
                  backups={backups}
                  status={status}
                  datasets={datasets}
                  me={me}
                  readOnly={!online}
                  revision={revision}
                  onChanged={refresh}
                />
              )}
              {client && !loading && canPage(me, 'Sources') && page === 'Sources' && (
                <Sources
                  sources={sources}
                  client={client}
                  busy={busy}
                  action={action}
                  open={sheet === 'source'}
                  onClose={() => setSheet(null)}
                />
              )}
              {client && !loading && can(me, 'sync_admin') && page === 'Jobs' && (
                <Jobs
                  sources={
                    [
                      ...sources,
                      ...map.nodes.filter(
                        (n) => n.type === 'source' && !sources.some((s) => s.id === n.id),
                      ),
                    ] as Pick<Source, 'id' | 'name' | 'kind'>[]
                  }
                  datasets={datasets}
                  jobs={jobs}
                  runs={runs}
                  events={events}
                  focusRun={entityRequest?.kind === 'run' ? entityRequest : null}
                  initialStateFilter={jobStateFilter}
                  open={sheet === 'job'}
                  onClose={() => setSheet(null)}
                  seed={jobSeed}
                  client={client}
                  action={action}
                  busy={busy}
                />
              )}
              {client && !loading && can(me, 'read') && page === 'Explorer' && (
                <Explorer
                  client={client}
                  scope={scope}
                  readOnly={!online}
                  onQuery={(sql) => {
                    useSqlWorkspace.getState().add(sql);
                    setPage('SQL');
                  }}
                />
              )}
              {can(me, 'read') && page === 'Query History' && (
                <QueryHistory
                  scope={scope}
                  onOpen={(sql) => {
                    useSqlWorkspace.getState().add(sql);
                    setPage('SQL');
                  }}
                />
              )}
              {client && !loading && can(me, 'read') && page === 'SQL' && (
                <Suspense fallback={<Skeleton label="Loading SQL Workspace…" />}>
                  <SqlView
                    scope={scope}
                    me={me!}
                    client={client}
                    revision={revision}
                    initialQuery={querySeed}
                    consoleCollapsed={consoleCollapsed}
                    onConsoleCollapsed={setConsoleCollapsed}
                    readOnly={!online}
                  />
                </Suspense>
              )}
              {client && !loading && can(me, 'admin') && page === 'Access' && (
                <Access client={client} sources={sources} datasets={datasets} onChanged={refresh} />
              )}
              {client && !loading && connection && can(me, 'read') && page === 'Data Map' && (
                <ErrorBoundary>
                  <Suspense fallback={<Skeleton label="Loading Data Map…" />}>
                    <DataMapView
                      map={map}
                      jobs={jobs}
                      runs={runs}
                      events={events}
                      onNavigateUsage={(entity) => {
                        if (entity.kind === 'model') {
                          setModelRequest({ id: entity.id, nonce: Date.now() });
                          setPage('Models');
                        } else if (entity.kind === 'view') {
                          setMapFocus(entity.id);
                        } else if (entity.kind === 'check') {
                          setEntityRequest({ kind: 'check', id: entity.id, nonce: Date.now() });
                          setPage('Data Quality');
                        } else {
                          setUsageChart(entity.id);
                          setPage('Analytics');
                        }
                      }}
                      focusId={mapFocus}
                      initialStatusFilter={mapStatusFilter}
                      consoleCollapsed={consoleCollapsed}
                      onConsoleCollapsed={setConsoleCollapsed}
                      onConnectSource={
                        canPage(me, 'Sources')
                          ? () => {
                              setPage('Sources');
                              setSheet('source');
                            }
                          : undefined
                      }
                      canManage={online && can(me, 'admin') && !asRole}
                      canCreateJob={(d) =>
                        online && !asRole && can(me, 'sync_admin', d.source_id, d.id)
                      }
                      onSelection={setSelection}
                      onQuery={(dataset) => {
                        setQuerySeed(
                          'SELECT * FROM ' +
                            tableReference(dataset.sql_schema, dataset.sql_table) +
                            ' LIMIT 100',
                        );
                        setPage('SQL');
                      }}
                      onCreateJob={(dataset) => {
                        setJobSeed(dataset);
                        setSheet('job');
                        setPage('Jobs');
                      }}
                      engineUrl={connection.url}
                      client={client}
                      action={action}
                      busy={busy || !online}
                    />
                  </Suspense>
                </ErrorBoundary>
              )}
            </ReadOnlyScope>
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
