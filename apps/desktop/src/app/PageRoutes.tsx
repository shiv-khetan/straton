import { lazy, Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api } from '@/lib/api';
import type { Api, Connection, Dataset, EngineEvent, Source } from '@/lib/api';
import Explorer from '@/features/explorer/Explorer';
import QueryHistory from '@/features/sql/QueryHistory';
import Models from '@/features/transformations/Transformations';
import Access from '@/features/access/Access';
import BackupsView from '@/features/security/Backups';
import Dashboard from '@/features/overview/Overview';
import Connect from '@/features/connections/Connect';
import Sources from '@/features/connections/Connections';
import Jobs from '@/features/jobs/Jobs';
import { RunTable } from '@/features/jobs/RunTable';
import { can, canPage } from '@/features/access/access-model';
import { Feedback } from '@/components/workbench/primitives';
import { ReadOnlyScope } from '@/components/workbench/ReadOnlyScope';
import { tableReference } from '@/features/sql/sql-model';
import { syncableKinds } from '@/lib/view-model';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import { laterRoutes } from '@/stores/route-history';
import type { Route } from '@/stores/route-history';
import type { LibraryEntry } from '@/stores/library';
import { LibraryPage } from '@/features/library/LibraryPage';
import { LaterPage } from '@/features/library/LaterPage';
import { ErrorBoundary } from './ErrorBoundary';
import { routeAvailable } from './navigation';
import type { useEngineData } from './useEngineData';
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

export type EntityRequest = { kind: string; id: string; runId?: string; nonce: number };
export type ModelRequest = { id: string | null; nonce: number };

/** Shell state the routed pages read and the cross-page requests they raise. */
export type PageRoutesProps = {
  page: Route;
  pageLabel: string;
  navigate: (route: Route) => void;
  scope: string;
  data: ReturnType<typeof useEngineData>;
  datasets: Dataset[];
  events: EngineEvent[];
  connection: Connection | null;
  client: Api | null;
  online: boolean;
  busy: boolean;
  action: (work: () => Promise<unknown>, message?: string, local?: boolean) => Promise<void>;
  error: string;
  notice: string;
  onDismissError: () => void;
  onDismissNotice: () => void;
  installConnection: (next: Connection | null) => void;
  forget: () => Promise<void>;
  revision: number;
  refresh: () => void;
  asRole: string;
  entityRequest: EntityRequest | null;
  onEntityRequest: (request: EntityRequest) => void;
  modelRequest: ModelRequest | null;
  onModelRequest: (request: ModelRequest) => void;
  qualityCreateRequest: number;
  usageChart: string;
  onUsageChart: (id: string) => void;
  jobStateFilter: string;
  onJobStateFilter: (filter: string) => void;
  mapStatusFilter: string;
  onMapStatusFilter: (filter: string) => void;
  mapFocus: string;
  onMapFocus: (id: string) => void;
  sheet: 'source' | 'job' | null;
  onSheet: (sheet: 'source' | 'job' | null) => void;
  jobSeed: Dataset | null;
  openJobSheet: (seed: Dataset | null) => void;
  onSelection: (name: string, id?: string) => void;
  consoleCollapsed: boolean;
  onConsoleCollapsed: (value: boolean) => void;
  openEntry: (entry: LibraryEntry) => void;
};

const lazyPages: Route[] = [
  'Pipelines',
  'Data Quality',
  'Analytics',
  'Dashboards',
  'Activity',
  'Schedules',
];

export function PageRoutes(p: PageRoutesProps) {
  const { page, data, client, online } = p;
  const { me, loading, sources, jobs, runs, map, backups, status, models } = data;
  const ready = !!client && !loading;
  return (
    <ReadOnlyScope
      // Jobs disables its own mutations offline so cached history stays browsable.
      disabled={!online && ['Sources', 'Access', 'Backups'].includes(page)}
    >
      {data.error && <Feedback message={data.error} error onClose={() => {}} />}
      {loading && page !== 'Connect' && <Skeleton label="Loading engine workspace…" />}
      {laterRoutes.includes(page) && <LaterPage name={p.pageLabel} />}
      {(page === 'Favorites' || page === 'Recent') && (
        <LibraryPage
          kind={page}
          scope={p.scope}
          onOpen={p.openEntry}
          available={(entry) => routeAvailable(me, entry.route)}
        />
      )}
      {p.error && <Feedback message={p.error} error onClose={p.onDismissError} />}
      {p.notice && <Feedback message={p.notice} onClose={p.onDismissNotice} />}
      {page === 'Connect' && (
        <Connect
          connection={p.connection}
          busy={p.busy}
          connect={(c) =>
            p.action(async () => {
              await api(c).me();
              await invoke('save_connection', c as unknown as Record<string, unknown>);
              p.installConnection(c);
            }, 'Connection tested and saved in OS keychain')
          }
          forget={p.forget}
        />
      )}
      {ready && me && lazyPages.includes(page) && <LazyPage {...p} client={client} />}
      {ready && me && page === 'Dashboard' && (
        <Dashboard
          client={client}
          me={me}
          sources={map.nodes.filter((n) => n.type === 'source')}
          models={models}
          scope={p.scope}
          readOnly={!online}
          onQuery={(sql) => openSql(p, sql)}
          backups={backups}
          datasets={p.datasets}
          runs={runs}
          jobs={jobs}
          status={status}
          events={p.events}
          canNavigate={(target) => canPage(me, target)}
          navigate={(target, filter) => {
            p.navigate(target);
            p.onJobStateFilter(filter ?? '');
            if (target === 'Data Map') p.onMapStatusFilter('succeeded');
          }}
        >
          <RunTable runs={runs.slice(0, 12)} jobs={jobs} />
        </Dashboard>
      )}
      {ready && me && page === 'Models' && <ModelsPage {...p} client={client} />}
      {ready && me && canPage(me, 'Optimizer') && page === 'Optimizer' && (
        <Suspense fallback={<p role="status">Loading optimizer…</p>}>
          <Optimizer client={client} me={me} datasets={p.datasets} readOnly={!online} />
        </Suspense>
      )}
      {ready && canPage(me, 'Backups') && page === 'Backups' && (
        <BackupsView
          client={client}
          backups={backups}
          status={status}
          datasets={p.datasets}
          me={me}
          readOnly={!online}
          revision={p.revision}
          onChanged={p.refresh}
        />
      )}
      {ready && canPage(me, 'Sources') && page === 'Sources' && (
        <Sources
          sources={sources}
          client={client}
          busy={p.busy}
          action={p.action}
          open={p.sheet === 'source'}
          onClose={() => p.onSheet(null)}
        />
      )}
      {ready && can(me, 'sync_admin') && page === 'Jobs' && (
        <Jobs
          sources={
            [
              ...sources,
              ...map.nodes.filter(
                (n) => n.type === 'source' && !sources.some((s) => s.id === n.id),
              ),
            ] as Pick<Source, 'id' | 'name' | 'kind'>[]
          }
          datasets={p.datasets}
          jobs={jobs}
          runs={runs}
          events={p.events}
          focusRun={p.entityRequest?.kind === 'run' ? p.entityRequest : null}
          initialStateFilter={p.jobStateFilter}
          open={p.sheet === 'job'}
          onClose={() => p.onSheet(null)}
          seed={p.jobSeed}
          client={client}
          action={p.action}
          busy={p.busy}
        />
      )}
      {ready && can(me, 'read') && page === 'Explorer' && (
        <Explorer
          client={client}
          scope={p.scope}
          readOnly={!online}
          onQuery={(sql) => openSql(p, sql)}
        />
      )}
      {can(me, 'read') && page === 'Query History' && (
        <QueryHistory scope={p.scope} onOpen={(sql) => openSql(p, sql)} />
      )}
      {ready && can(me, 'read') && page === 'SQL' && (
        <Suspense fallback={<Skeleton label="Loading SQL Workspace…" />}>
          <SqlView
            scope={p.scope}
            me={me!}
            client={client}
            revision={p.revision}
            initialQuery="SELECT 1;"
            consoleCollapsed={p.consoleCollapsed}
            onConsoleCollapsed={p.onConsoleCollapsed}
            readOnly={!online}
          />
        </Suspense>
      )}
      {ready && can(me, 'admin') && page === 'Access' && (
        <Access client={client} sources={sources} datasets={p.datasets} onChanged={p.refresh} />
      )}
      {ready && p.connection && can(me, 'read') && page === 'Data Map' && (
        <DataMapPage {...p} client={client} connection={p.connection} />
      )}
    </ReadOnlyScope>
  );
}

function openSql(p: PageRoutesProps, sql: string) {
  useSqlWorkspace.getState().add(sql);
  p.navigate('SQL');
}

const previewSql = (dataset: Dataset) =>
  'SELECT * FROM ' + tableReference(dataset.sql_schema, dataset.sql_table) + ' LIMIT 100';

function LazyPage(p: PageRoutesProps & { client: Api }) {
  const { page, client, online, scope } = p;
  const { jobs, models } = p.data;
  const me = p.data.me!;
  return (
    <Suspense fallback={<Skeleton label={'Loading ' + p.pageLabel + '…'} />}>
      {page === 'Pipelines' && (
        <Pipelines
          client={client}
          me={me}
          jobs={jobs}
          models={models}
          readOnly={!online}
          request={p.entityRequest?.kind === 'pipeline' ? p.entityRequest : null}
        />
      )}
      {page === 'Data Quality' && (
        <Quality
          client={client}
          me={me}
          datasets={p.datasets}
          models={models}
          readOnly={!online}
          request={p.entityRequest?.kind === 'check' ? p.entityRequest : null}
          createRequest={p.qualityCreateRequest}
        />
      )}
      {page === 'Analytics' &&
        (p.usageChart ? (
          <UsageChart
            client={client}
            id={p.usageChart}
            scope={scope}
            onClose={() => p.onUsageChart('')}
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
          onAnalytics={() => p.navigate('Analytics')}
        />
      )}
      {page === 'Activity' && <Activity client={client} me={me} />}
      {page === 'Schedules' && (
        <Schedules
          client={client}
          jobs={jobs}
          models={models}
          canSeeJobs={can(me, 'sync_admin')}
          onNavigate={p.navigate}
        />
      )}
    </Suspense>
  );
}

function ModelsPage(p: PageRoutesProps & { client: Api }) {
  const { map, jobs, runs, models } = p.data;
  const me = p.data.me!;
  return (
    <ErrorBoundary>
      <Models
        client={p.client}
        me={me}
        revision={p.revision}
        changed={p.refresh}
        events={p.events}
        jobs={jobs}
        runs={runs}
        catalog={map}
        cachedModels={models}
        canCreateJob={(dataset) =>
          p.online &&
          can(me, 'sync_admin', dataset.source_id, dataset.id) &&
          map.nodes.some(
            (node) =>
              node.type === 'source' &&
              node.id === dataset.source_id &&
              syncableKinds.includes(node.kind),
          )
        }
        onCreateJob={p.openJobSheet}
        onSelection={p.onSelection}
        onQueryDataset={(dataset) => openSql(p, previewSql(dataset))}
        request={p.modelRequest}
        consoleCollapsed={p.consoleCollapsed}
        onConsoleCollapsed={p.onConsoleCollapsed}
        readOnly={!p.online}
        onQuery={(model) =>
          openSql(p, 'SELECT * FROM ' + tableReference('models', model.name) + ' LIMIT 100')
        }
      />
    </ErrorBoundary>
  );
}

function DataMapPage(p: PageRoutesProps & { client: Api; connection: Connection }) {
  const { me, map, jobs, runs } = p.data;
  return (
    <ErrorBoundary>
      <Suspense fallback={<Skeleton label="Loading Data Map…" />}>
        <DataMapView
          map={map}
          jobs={jobs}
          runs={runs}
          events={p.events}
          onNavigateUsage={(entity) => {
            if (entity.kind === 'model') {
              p.onModelRequest({ id: entity.id, nonce: Date.now() });
              p.navigate('Models');
            } else if (entity.kind === 'view') {
              p.onMapFocus(entity.id);
            } else if (entity.kind === 'check') {
              p.onEntityRequest({ kind: 'check', id: entity.id, nonce: Date.now() });
              p.navigate('Data Quality');
            } else {
              p.onUsageChart(entity.id);
              p.navigate('Analytics');
            }
          }}
          focusId={p.mapFocus}
          initialStatusFilter={p.mapStatusFilter}
          consoleCollapsed={p.consoleCollapsed}
          onConsoleCollapsed={p.onConsoleCollapsed}
          onConnectSource={
            canPage(me, 'Sources')
              ? () => {
                  p.navigate('Sources');
                  p.onSheet('source');
                }
              : undefined
          }
          canManage={p.online && can(me, 'admin') && !p.asRole}
          canCreateJob={(d) => p.online && !p.asRole && can(me, 'sync_admin', d.source_id, d.id)}
          onSelection={p.onSelection}
          onQuery={(dataset) => openSql(p, previewSql(dataset))}
          onCreateJob={p.openJobSheet}
          engineUrl={p.connection.url}
          client={p.client}
          action={p.action}
          busy={p.busy || !p.online}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
