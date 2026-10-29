import { useDraftExit, useDraftValue } from '@/features/analytics/DraftExit';
import {
  clearDraft,
  draftKey,
  readDraft,
  snapshotSave,
  writeDraft,
} from '@/features/analytics/draft-store';
import type { DashboardContinuation } from '@/features/analytics/draft-store';
import { Plus } from 'lucide-react';
import { PageActions } from '@/components/workbench/primitives';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AnalyticsDashboard,
  Api,
  Chart,
  ChartRange,
  DashboardInput,
  Me,
  SqlCell,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { Field } from '@/components/workbench/Field';
import {
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
  Choice,
  useFeatureAction,
} from '@/components/workbench/FeatureState';
import { Pill } from '@/components/workbench/primitives';
import { ResultGrid } from '@/components/workbench/ResultGrid';
import { ChartPreview } from '@/features/analytics/ChartPreview';
import { addDashboardChart, packLayout, reorderLayout } from './layout-model';
import './styles.css';
function DashboardLibrary({
  client,
  me,
  scope,
  readOnly,
  onAnalytics,
}: {
  client: Api;
  me: Me;
  scope: string;
  readOnly: boolean;
  onAnalytics: () => void;
}) {
  const [id, setId] = useDraftValue<string | null>(draftKey(scope, 'dashboard'), () => null);
  const list = useQuery({
    queryKey: [...queryKeys.dashboards, 'view', 'list'],
    queryFn: () => client.dashboards(),
  });
  const detail = useQuery({
    queryKey: [...queryKeys.dashboards, 'view', 'detail', id],
    queryFn: () => client.dashboard(id!),
    enabled: !!id && id !== 'new',
  });
  return (
    <section className="space-y-4">
      {id ? (
        <>
          {id === 'new' ? (
            <DashboardView
              key="new"
              client={client}
              me={me}
              scope={scope}
              readOnly={readOnly}
              onAnalytics={onAnalytics}
              onClose={() => setId(null)}
            />
          ) : detail.isPending ? (
            <FeatureLoading label="Loading dashboard" />
          ) : detail.isError ? (
            <FeatureError error={detail.error} retry={() => void detail.refetch()} />
          ) : (
            <DashboardView
              key={id}
              dashboard={detail.data}
              client={client}
              me={me}
              scope={scope}
              readOnly={readOnly}
              onAnalytics={onAnalytics}
              onClose={() => setId(null)}
            />
          )}
        </>
      ) : (
        <>
          <div className="section-toolbar">
            <p className="text-ink-2">Arrange saved charts into a shared view of your data.</p>
            <PageActions>
              <Button disabled={readOnly} onClick={() => setId('new')}>
                <Plus size={16} aria-hidden="true" />
                New dashboard
              </Button>
            </PageActions>
          </div>
          {list.isPending && <FeatureLoading label="Loading dashboards" />}
          <FeatureError error={list.error} retry={() => void list.refetch()} />
          {list.data?.length === 0 && (
            <FeatureEmpty
              title="Bring your charts together"
              action="New dashboard"
              disabled={readOnly}
              onAction={() => setId('new')}
            >
              Create a dashboard, choose charts from Analytics, and arrange their widths and order.
            </FeatureEmpty>
          )}
          {!!list.data?.length && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dashboard</TableHead>
                  <TableHead>Charts</TableHead>
                  <TableHead>Visibility</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Button variant="link" onClick={() => setId(d.id)}>
                        {d.name}
                      </Button>
                      <p className="text-caption text-ink-2">{d.description}</p>
                    </TableCell>
                    <TableCell>
                      <code>{d.layout.length}</code>
                    </TableCell>
                    <TableCell>
                      <Pill>{d.shared ? 'Shared' : 'Private'}</Pill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}
function DashboardView({
  dashboard,
  client,
  me,
  scope,
  readOnly,
  onClose,
  onAnalytics,
}: {
  dashboard?: AnalyticsDashboard;
  client: Api;
  me: Me;
  scope: string;
  readOnly: boolean;
  onClose: () => void;
  onAnalytics: () => void;
}) {
  const key = draftKey(scope, 'dashboard', dashboard?.id ?? 'new');
  const initial: DashboardInput = dashboard
    ? {
        name: dashboard.name,
        description: dashboard.description,
        layout: dashboard.layout,
        shared: dashboard.shared,
      }
    : { name: '', description: '', layout: [], shared: false };
  const [draft, setDraft] = useDraftValue<DashboardInput>(key, () => initial);
  const [saved, setSaved] = useDraftValue<DashboardInput>(key + ':saved', () => initial);
  const [savedId, setSavedId] = useDraftValue<string | undefined>(key + ':id', () => dashboard?.id);
  const [editing, setEditing] = useDraftValue<boolean>(key + ':editing', () => !dashboard);
  const exit = useDraftExit(JSON.stringify(draft) !== JSON.stringify(saved), () => {
    setDraft(saved);
    setEditing(!savedId);
  });
  const close = () =>
    exit.request(() => {
      clearDraft(key);
      clearDraft(key + ':saved');
      clearDraft(key + ':id');
      clearDraft(key + ':editing');
      onClose();
    });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [range, setRange] = useState<ChartRange>({
    from: new Date(Date.now() - 7 * 86400000).toISOString(),
    to: new Date().toISOString(),
  });
  const [chartId, setChartId] = useState('');
  const [drill, setDrill] = useState<{ chart: Chart; x: SqlCell; range: ChartRange } | null>(null);
  const charts = useQuery({
    queryKey: [...queryKeys.charts, 'view', 'dashboard-library'],
    queryFn: () => client.charts(),
  });
  const action = useFeatureAction();
  const writable = !dashboard || me.privileges.admin || dashboard.owner_id === me.user.id;
  const patch = (v: Partial<DashboardInput>) => setDraft((d) => ({ ...d, ...v }));
  const used = new Set(draft.layout.map((t) => t.chart_id));
  useEffect(() => {
    const continuationKey = draftKey(scope, 'dashboard-continuation');
    const continuation = readDraft<DashboardContinuation>(continuationKey);
    if (continuation?.chartId && continuation.dashboardId === (dashboard?.id ?? 'new')) {
      const chartId = continuation.chartId;
      setDraft((current) => addDashboardChart(current, chartId));
      setEditing(true);
      clearDraft(continuationKey);
    }
  }, [scope, dashboard?.id]);
  return (
    <div className="space-y-4">
      {exit.dialog}
      <FeatureError error={action.error} />
      <Button variant="ghost" disabled={action.pending} onClick={close}>
        ← Dashboards
      </Button>
      <div className="section-toolbar">
        <h2 className="text-lg font-medium">{draft.name || 'New dashboard'}</h2>
        <div className="flex gap-2">
          {writable && !editing && (
            <Button variant="outline" disabled={readOnly} onClick={() => setEditing(true)}>
              Edit dashboard
            </Button>
          )}
          {writable && savedId && (
            <Button
              variant="destructive"
              disabled={readOnly || action.pending}
              onClick={() => {
                if (!confirmDelete) setConfirmDelete(true);
                else
                  void action.run(async () => {
                    await client.deleteDashboard(savedId);
                    clearDraft(key);
                    clearDraft(key + ':saved');
                    clearDraft(key + ':id');
                    clearDraft(key + ':editing');
                    exit.allow(onClose);
                  }, 'Dashboard deleted');
              }}
            >
              {confirmDelete ? 'Confirm delete' : 'Delete dashboard'}
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <fieldset
          disabled={readOnly || action.pending}
          className="space-y-4 rounded-card border border-line bg-panel p-4"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name">
              <Input
                maxLength={200}
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <Textarea
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={draft.shared}
              onCheckedChange={(v) => patch({ shared: v === true })}
            />
            Shared with workspace
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <Choice
              label="Add a chart"
              value={chartId}
              options={[
                { value: '', label: 'Choose saved chart' },
                ...(charts.data ?? [])
                  .filter((c) => !used.has(c.id))
                  .map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={setChartId}
            />
            <Button
              variant="outline"
              disabled={readOnly || !chartId}
              onClick={() => {
                setDraft((current) => addDashboardChart(current, chartId));
                setChartId('');
              }}
            >
              Add chart
            </Button>
          </div>
        </fieldset>
      ) : (
        <p className="text-ink-2">{draft.description}</p>
      )}
      {editing && (
        <PageActions>
          {' '}
          <Button
            disabled={readOnly || action.pending || !draft.name.trim()}
            onClick={() =>
              void action.run(async () => {
                const snapshot = snapshotSave(savedId, draft);
                const result = snapshot.target
                  ? await client.updateDashboard(snapshot.target, snapshot.value)
                  : await client.createDashboard(snapshot.value);
                setSavedId(result.id);
                const value = {
                  name: result.name,
                  description: result.description,
                  layout: result.layout,
                  shared: result.shared,
                };
                setDraft(value);
                setSaved(value);
                setEditing(false);
              }, 'Dashboard saved')
            }
          >
            Save dashboard
          </Button>
          {
            <Button
              variant="outline"
              disabled={action.pending}
              onClick={() => {
                exit.request(() => {
                  setDraft(saved);
                  setEditing(false);
                });
              }}
            >
              Cancel
            </Button>
          }
        </PageActions>
      )}
      <TimeRange onChange={setRange} />
      <FeatureError error={charts.error} retry={() => void charts.refetch()} />
      {charts.isPending && <FeatureLoading label="Loading chart library" />}
      {!draft.layout.length && (
        <FeatureEmpty
          title="This dashboard has no charts"
          action={writable ? (editing ? 'Open Analytics' : 'Add charts') : undefined}
          onAction={() => {
            if (editing) {
              writeDraft(draftKey(scope, 'dashboard-continuation'), {
                dashboardId: dashboard?.id ?? 'new',
              });
              exit.allow(onAnalytics);
            } else setEditing(true);
          }}
          disabled={readOnly}
        >
          Save a chart in Analytics, then add it here. Width and reorder controls keep layout
          changes precise.
        </FeatureEmpty>
      )}
      <div className="dashboard-layout">
        {draft.layout.map((tile, index) => {
          const chart = charts.data?.find((c) => c.id === tile.chart_id);
          return (
            <section
              key={tile.chart_id}
              className="dashboard-tile"
              style={{
                gridColumn:
                  Math.min(11, tile.x) +
                  1 +
                  ' / span ' +
                  Math.max(1, Math.min(12 - tile.x, tile.w)),
                gridRow: tile.y + 1 + ' / span ' + Math.max(1, tile.h),
              }}
            >
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel px-4 py-2">
                <h3 className="font-medium">{chart?.name ?? 'Chart unavailable'}</h3>
                {editing && (
                  <div className="flex flex-wrap items-end gap-2">
                    <Choice
                      label="Width"
                      value={String(tile.w)}
                      options={[
                        { value: '4', label: 'Third' },
                        { value: '6', label: 'Half' },
                        { value: '12', label: 'Full' },
                        ...(![4, 6, 12].includes(tile.w)
                          ? [{ value: String(tile.w), label: tile.w + '/12' }]
                          : []),
                      ]}
                      onChange={(v) =>
                        patch({
                          layout: packLayout(
                            draft.layout.map((t) =>
                              t.chart_id === tile.chart_id ? { ...t, w: Number(v) } : t,
                            ),
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={index === 0}
                      aria-label={'Move ' + (chart?.name ?? 'chart') + ' earlier'}
                      onClick={() =>
                        patch({ layout: reorderLayout(draft.layout, tile.chart_id, -1) })
                      }
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={index === draft.layout.length - 1}
                      aria-label={'Move ' + (chart?.name ?? 'chart') + ' later'}
                      onClick={() =>
                        patch({ layout: reorderLayout(draft.layout, tile.chart_id, 1) })
                      }
                    >
                      ↓
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        patch({
                          layout: packLayout(
                            draft.layout.filter((t) => t.chart_id !== tile.chart_id),
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </header>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {chart ? (
                  <ChartTile
                    client={client}
                    chart={chart}
                    range={range}
                    scope={scope}
                    onDrill={(x, applied) => setDrill({ chart, x, range: applied })}
                  />
                ) : charts.isPending ? (
                  <FeatureLoading />
                ) : (
                  <p className="text-ink-2">
                    This chart was deleted or is outside your access.{' '}
                    {writable
                      ? 'Remove it in Edit dashboard.'
                      : 'Ask the dashboard owner to update its layout.'}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {drill && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setDrill(null);
          }}
        >
          <SheetContent className="w-[90vw] rounded-l-lg sm:max-w-5xl">
            <SheetHeader>
              <SheetTitle>
                {drill.chart.name} · {String(drill.x ?? 'NULL')}
              </SheetTitle>
              <SheetDescription>
                Underlying rows for the selected x value. Your access rules and the chart time range
                apply. Maximum 500 rows.
              </SheetDescription>
            </SheetHeader>
            <Drill
              client={client}
              chart={drill.chart}
              x={drill.x}
              range={drill.range}
              scope={scope}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
function TimeRange({ onChange }: { onChange: (range: ChartRange) => void }) {
  const [choice, setChoice] = useState('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  function apply(value: string) {
    setChoice(value);
    setError('');
    if (value !== 'custom') {
      const now = Date.now();
      onChange({
        from: new Date(
          now - ({ '24h': 1, '7d': 7, '30d': 30 }[value] ?? 7) * 86400000,
        ).toISOString(),
        to: new Date(now).toISOString(),
      });
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Choice
        label="Time range"
        value={choice}
        options={['24h', '7d', '30d', 'custom'].map((v) => ({
          value: v,
          label: v === 'custom' ? 'Custom' : v,
        }))}
        onChange={apply}
      />
      {choice === 'custom' && (
        <>
          <Field label="From (local time)">
            <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To (local time)">
            <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button
            variant="outline"
            onClick={() => {
              const a = new Date(from),
                b = new Date(to);
              if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || a > b) {
                setError('Choose valid dates with From before To.');
                return;
              }
              setError('');
              onChange({ from: a.toISOString(), to: b.toISOString() });
            }}
          >
            Apply range
          </Button>
        </>
      )}
      <span className="text-caption text-ink-2">Applies to charts with a time column.</span>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
function ChartTile({
  client,
  chart,
  range,
  scope,
  onDrill,
}: {
  client: Api;
  chart: Chart;
  range: ChartRange;
  scope: string;
  onDrill: (x: SqlCell, range: ChartRange) => void;
}) {
  const applied = useMemo(
    () => (chart.config.time_column ? range : {}),
    [chart.config.time_column, range],
  );
  const query = useQuery({
    queryKey: [...queryKeys.charts, 'view', 'data', chart.id, chart.updated_at, applied],
    queryFn: () => client.chartData(chart.id, applied),
  });
  return (
    <>
      {query.isPending && <FeatureLoading label={'Loading ' + chart.name} />}
      <FeatureError error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <ChartPreview
          data={query.data}
          kind={chart.kind}
          config={chart.config}
          scope={scope}
          onDrill={chart.config.x ? (x) => onDrill(x, applied) : undefined}
        />
      )}
      {!chart.config.time_column && (
        <p className="text-caption text-ink-2">All time · no time column configured</p>
      )}
    </>
  );
}
function Drill({
  client,
  chart,
  x,
  range,
  scope,
}: {
  client: Api;
  chart: Chart;
  x: SqlCell;
  range: ChartRange;
  scope: string;
}) {
  const query = useQuery({
    queryKey: [...queryKeys.charts, 'view', 'drill', chart.id, x, range],
    queryFn: () => client.drillChart(chart.id, { x_value: x, ...range }),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      {query.isPending && <FeatureLoading label="Loading underlying rows" />}
      <FeatureError error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <>
          <p className="mb-2 text-caption text-ink-2">
            {query.data.rows.length} rows
            {query.data.rows.length === 500 ? ' · result limit reached' : ''}
          </p>
          <ResultGrid
            columns={query.data.columns}
            rows={query.data.rows}
            scope={scope}
            tableKey={'drill:' + chart.id}
          />
        </>
      )}
    </div>
  );
}

export default function Dashboards(props: Parameters<typeof DashboardLibrary>[0]) {
  return <DashboardLibrary key={props.scope} {...props} />;
}
