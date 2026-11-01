import { lazy, Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api } from '@/lib/api';
import type { Api, Connection, Dataset, EngineEvent, Source } from '@/lib/api';
import Explorer from '@/features/explorer/Explorer';

import Models from '@/features/transformations/Transformations';
import Access from '@/features/access/Access';
import BackupsView from '@/features/security/Backups';
import Dashboard from '@/features/overview/Overview';
import Connect from '@/features/connections/Connect';
import Sources from '@/features/connections/Connections';
import Jobs from '@/features/jobs/Jobs';
import { can, canPage } from '@/features/access/access-model';
import { Button, Feedback, Icon } from '@/components/workbench/primitives';
import { ReadOnlyScope } from '@/components/workbench/ReadOnlyScope';
import { tableReference } from '@/features/sql/sql-model';
import { syncableKinds } from '@/lib/view-model';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import { laterRoutes, routeLabels } from '@/stores/route-history';
import type { Route } from '@/stores/route-history';
import type { LibraryEntry } from '@/stores/library';
import { LibraryPage } from '@/features/library/LibraryPage';
import { LaterPage } from '@/features/library/LaterPage';
import Settings from '@/features/settings/Settings';
import { CombinedPage } from './CombinedPage';
import type { CombinedSection } from './CombinedPage';
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

const lazyPages: Route[] = ['Data Quality'];
const orchestration: Route[] = ['Pipelines', 'Jobs', 'Schedules'];
const analytics: Route[] = ['Analytics', 'Dashboards'];

export function PageRoutes(p: PageRoutesProps) {
  const { page, data, client, online } = p;
  const { me, loading, sources, backups, status } = data;
  const ready = !!client && !loading;
  return (
    <ReadOnlyScope
      // Jobs disables its own mutations offline so cached history stays browsable.
      disabled={!online && ['Sources', 'Access', 'Backups'].includes(page)}
    >
      {data.error && <Feedback message={data.error} error onClose={() => {}} />}
      {loading && page !== 'Connect' && <Skeleton label="Loading engine workspace…" />}
      {laterRoutes.includes(page) && <LaterPage name={p.pageLabel} />}
      {page === 'Settings' && canPage(me, 'Settings') && (
        <Settings client={client} me={me} connection={p.connection} />
      )}
      {(page === 'Favorites' || page === 'Recent') && (
        <CombinedPage
          page={page}
          onNavigate={p.navigate}
          sections={(['Favorites', 'Recent'] as const).map((kind) => ({
            route: kind,
            label: routeLabels[kind],
            content: (
              <LibraryPage
                kind={kind}
                scope={p.scope}
                onOpen={p.openEntry}
                available={(entry) => routeAvailable(me, entry.route)}
              />
            ),
          }))}
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
      {ready && me && orchestration.includes(page) && <OrchestrationPage {...p} client={client} />}
      {ready && me && analytics.includes(page) && <AnalyticsPage {...p} client={client} />}
      {ready && me && (page === 'Dashboard' || page === 'Activity') && (
        <OverviewPage {...p} client={client} />
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
          jobs={data.jobs}
          runs={data.runs}
          datasets={p.datasets}
          client={client}
          busy={p.busy}
          action={p.action}
          open={p.sheet === 'source'}
          onClose={() => p.onSheet(null)}
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

      {ready && can(me, 'read') && (page === 'SQL' || page === 'Query History') && (
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
            showHistory={page === 'Query History'}
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
  const { page, client, online } = p;
  const me = p.data.me!;
  return (
    <Suspense fallback={<Skeleton label={'Loading ' + p.pageLabel + '…'} />}>
      {page === 'Data Quality' && (
        <Quality
          client={client}
          me={me}
          datasets={p.datasets}
          models={p.data.models}
          readOnly={!online}
          request={p.entityRequest?.kind === 'check' ? p.entityRequest : null}
          createRequest={p.qualityCreateRequest}
        />
      )}
    </Suspense>
  );
}

// Engine health first, then the workspace activity feed, on one page.
function OverviewPage(p: PageRoutesProps & { client: Api }) {
  const { client, online } = p;
  const { runs, jobs, models, map, backups, status } = p.data;
  const me = p.data.me!;
  return (
    <Suspense fallback={<Skeleton label={'Loading ' + p.pageLabel + '…'} />}>
      <CombinedPage
        page={p.page}
        onNavigate={p.navigate}
        sections={[
          {
            route: 'Dashboard',
            label: 'Summary',
            content: (
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
                canNavigate={(target) => canPage(me, target)}
                navigate={(target, filter) => {
                  p.navigate(target);
                  p.onJobStateFilter(filter ?? '');
                  if (target === 'Data Map') p.onMapStatusFilter('succeeded');
                }}
              />
            ),
          },
          {
            route: 'Activity',
            label: routeLabels.Activity,
            content: <Activity client={client} me={me} />,
          },
        ]}
      />
    </Suspense>
  );
}

// Pipelines, sync jobs and schedules on one page.
function OrchestrationPage(p: PageRoutesProps & { client: Api }) {
  const { client, online } = p;
  const { jobs, runs, models, sources, map } = p.data;
  const me = p.data.me!;
  const sections: CombinedSection[] = [];
  if (canPage(me, 'Pipelines'))
    sections.push({
      route: 'Pipelines',
      label: routeLabels.Pipelines,
      content: (
        <Pipelines
          client={client}
          me={me}
          jobs={jobs}
          models={models}
          readOnly={!online}
          request={p.entityRequest?.kind === 'pipeline' ? p.entityRequest : null}
        />
      ),
    });
  if (can(me, 'sync_admin'))
    sections.push({
      route: 'Jobs',
      label: routeLabels.Jobs,
      actions: (
        <Button type="button" disabled={!online || p.busy} onClick={() => p.openJobSheet(null)}>
          <Icon name="plus" />
          New sync job
        </Button>
      ),
      content: (
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
      ),
    });
  if (canPage(me, 'Schedules'))
    sections.push({
      route: 'Schedules',
      label: routeLabels.Schedules,
      content: (
        <Schedules
          client={client}
          jobs={jobs}
          models={models}
          canSeeJobs={can(me, 'sync_admin')}
          onNavigate={p.navigate}
        />
      ),
    });
  return (
    <Suspense fallback={<Skeleton label={'Loading ' + p.pageLabel + '…'} />}>
      <CombinedPage page={p.page} sections={sections} onNavigate={p.navigate} />
    </Suspense>
  );
}

// The chart builder and the dashboards that collect its charts, on one page.
function AnalyticsPage(p: PageRoutesProps & { client: Api }) {
  const { client, online, scope } = p;
  const me = p.data.me!;
  return (
    <Suspense fallback={<Skeleton label={'Loading ' + p.pageLabel + '…'} />}>
      <CombinedPage
        page={p.page}
        onNavigate={p.navigate}
        sections={[
          {
            route: 'Analytics',
            label: 'Charts',
            content: p.usageChart ? (
              <UsageChart
                client={client}
                id={p.usageChart}
                scope={scope}
                onClose={() => p.onUsageChart('')}
              />
            ) : (
              <Analytics client={client} me={me} scope={scope} readOnly={!online} />
            ),
          },
          {
            route: 'Dashboards',
            label: routeLabels.Dashboards,
            content: (
              <Dashboards
                client={client}
                me={me}
                scope={scope}
                readOnly={!online}
                onAnalytics={() => p.navigate('Analytics')}
              />
            ),
          },
        ]}
      />
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
