import {
  Table as DataTable,
  TableCaption,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  SourceHealth,
  ActiveWork,
  RecentQueries,
  Storage,
  FailingCheck,
  useOverviewQuality,
} from './CoreOverview';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Dataset, Job, Run, Status } from '@/lib/api';
import {
  EmptyState,
  Icon,
  KpiTile,
  Pill,
  SegmentedControl,
  Tray,
  StatePill,
} from '@/components/workbench/primitives';
import {
  backupTime,
  bucketRuns,
  bucketTooltip,
  chartStates,
  navigateBucket,
  relativeTime,
  runKpi,
  runSparkline,
  timestampSeries,
} from '@/lib/view-model';

function SyncActivity({ runs }: { runs: Run[] }) {
  const [range, setRange] = useState<7 | 30>(7);
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const id = useId();
  const days = bucketRuns(runs, Date.now(), range);
  const totals = days.map((day) => bucketTooltip(day).total);
  const max = Math.max(1, ...totals);
  const tooltip = active === null ? null : bucketTooltip(days[active]);
  const width = 640,
    height = 190,
    plotHeight = 140,
    baseline = 152;
  const step = (width - 60) / days.length;
  const x = (i: number) => 44 + (i + 0.5) * step;
  return (
    <>
      <div className="chart-toolbar">
        <p>
          <code>{totals.reduce((a, b) => a + b, 0).toLocaleString()}</code> runs{' '}
          <span className="hint">· 1-day buckets by scheduled time</span>
        </p>
        <SegmentedControl
          label="Sync activity range"
          items={['7d', '30d']}
          value={range + 'd'}
          onChange={(value) => {
            setRange(value === '7d' ? 7 : 30);
            setActive(null);
          }}
        />
      </div>
      <div className="activity-chart-container">
        <svg
          className="activity-chart"
          viewBox={'0 0 ' + width + ' ' + height}
          tabIndex={0}
          role="group"
          aria-label={'Sync activity, last ' + range + ' days'}
          aria-describedby={id + '-help'}
          onFocus={() => {
            setFocused(true);
            setActive(days.length - 1);
          }}
          onBlur={() => {
            setFocused(false);
            setActive(null);
          }}
          onPointerLeave={() => {
            if (!focused) setActive(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setActive(null);
              return;
            }
            if (
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            setActive(navigateBucket(active ?? days.length - 1, event.key, days.length));
          }}
        >
          <title>Daily sync runs by scheduled time</title>
          <desc>
            Each bar shows one day's total runs. Exact state counts are in the data table below.
          </desc>
          {[...new Set([0, Math.ceil(max / 2), max])].map((value) => (
            <g key={value}>
              <line
                x1="38"
                x2={width - 8}
                y1={baseline - (value / max) * plotHeight}
                y2={baseline - (value / max) * plotHeight}
                stroke="var(--line)"
              />
              <text
                x="30"
                y={baseline - (value / max) * plotHeight + 4}
                textAnchor="end"
                className="activity-axis"
              >
                {value}
              </text>
            </g>
          ))}
          {days.map((day, i) => (
            <g key={day.start} onPointerEnter={() => setActive(i)} onClick={() => setActive(i)}>
              <rect x={x(i) - step / 2} y="8" width={step} height={baseline} fill="transparent" />
              <rect
                x={x(i) - step * 0.3}
                y={baseline - (totals[i] / max) * plotHeight}
                width={step * 0.6}
                height={(totals[i] / max) * plotHeight}
                fill="var(--mark)"
                opacity={active === null || active === i ? 1 : 0.55}
              />
              {(range === 7 || i % 5 === 0) && (
                <text x={x(i)} y={height - 14} textAnchor="middle" className="activity-axis">
                  {day.axisLabel}
                </text>
              )}
            </g>
          ))}
          {active !== null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1="8"
              y2={baseline}
              stroke="var(--ink-3)"
              strokeDasharray="2 4"
              pointerEvents="none"
            />
          )}
        </svg>
        {tooltip && (
          <div
            className="chart-tooltip"
            style={{ left: 'clamp(8px, ' + (x(active!) / width) * 100 + '%, calc(100% - 198px))' }}
            aria-hidden="true"
          >
            <div className="tooltip-heading">
              {tooltip.label}
              <span className="tabular-nums">{tooltip.total} runs</span>
            </div>
            {tooltip.rows.map(({ state, value }) => (
              <div className="tooltip-row" key={state}>
                <StatePill state={state} />
                <span className="ms-auto tabular-nums">{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {!totals.some(Boolean) && (
        <p className="hint">No runs in the loaded history for these days.</p>
      )}
      <p id={id + '-help'} className="hint chart-help">
        Daily buckets. Focus the chart and use arrow keys; Home/End jump to the first/last day.
        Escape dismisses the tooltip.
      </p>
      <span className="visually-hidden" role="status">
        {focused && tooltip
          ? tooltip.label + ': ' + tooltip.rows.map((row) => row.value + ' ' + row.state).join(', ')
          : ''}
      </span>
      <details className="chart-data">
        <summary>View activity data</summary>
        <div className="table-wrap">
          <DataTable>
            <TableCaption>Sync activity by day, last {range} days</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Date</TableHead>
                {chartStates.map((state) => (
                  <TableHead className="text-right tabular-nums" key={state} scope="col">
                    {state[0].toUpperCase() + state.slice(1)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((day) => (
                <TableRow key={day.start}>
                  <TableHead scope="row">{day.label}</TableHead>
                  {chartStates.map((state) => (
                    <TableCell className="text-right tabular-nums" key={state}>
                      {day[state]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        </div>
      </details>
    </>
  );
}
export default function Dashboard({
  datasets,
  runs,
  jobs,
  status,
  backups,
  children,
  navigate,
  events,
  canNavigate,
  client,
  me,
  sources,
  models,
  scope,
  readOnly,
  onQuery,
}: {
  client: import('@/lib/api').Api;
  me: import('@/lib/api').Me;
  sources: import('@/lib/api').MapSource[];
  models: import('@/lib/api').Model[];
  scope: string;
  readOnly: boolean;
  onQuery: (sql: string) => void;
  datasets: Dataset[];
  runs: Run[];
  jobs: Job[];
  status: Status | null;
  backups: string[];
  children: React.ReactNode;
  navigate: (page: 'Jobs' | 'Data Map' | 'Backups' | 'Data Quality', filter?: string) => void;
  events: import('@/lib/api').EngineEvent[];
  canNavigate: (page: 'Jobs' | 'Data Map' | 'Backups' | 'Data Quality') => boolean;
}) {
  const now = Date.now();
  const total = runKpi(runs, now);
  const failed = runKpi(runs, now, 'failed');
  const synced = datasets.filter(
    (dataset) => dataset.source_id !== 'straton-local-lake' && dataset.last_synced_at,
  );
  const backup = backupTime(status?.last_backup);
  const backupAge = backup ? relativeTime(backup, now) : status?.last_backup ? 'Unknown' : 'Never';
  const quality = useOverviewQuality(client);
  const qualityTotal = quality.data
    ? Object.values(quality.data.summary.counts).reduce((a, b) => a + b, 0)
    : 0;
  const qualityRuns = quality.data?.runs ?? [];
  const qualityCounts = timestampSeries(
    qualityRuns.map((r) => r.started_at * 1000),
    now,
  );
  const qualityPassed = timestampSeries(
    qualityRuns.filter((r) => r.status === 'passed').map((r) => r.started_at * 1000),
    now,
  );
  const qualitySeries = qualityCounts.map((count, i) =>
    count ? (qualityPassed[i] / count) * 100 : null,
  );
  const succeeded = runKpi(runs, now, 'succeeded').current;
  const recentRuns = [...runs].sort((a, b) => b.available_at - a.available_at).slice(0, 5);
  return (
    <>
      <div className="kpi-grid" aria-label="Engine overview">
        <KpiTile
          caption="Datasets synced"
          value={canNavigate('Data Map') ? synced.length.toLocaleString() : '—'}
          unit="datasets"
          series={runs.length ? runSparkline(runs, now, 'succeeded') : []}
          seriesLabel="Succeeded sync runs, twelve 2-hour buckets"
          footer={
            synced.length ? synced.length + ' datasets have synced' : 'No datasets synced yet'
          }
          disabled={!canNavigate('Data Map')}
          onClick={() => navigate('Data Map')}
        />
        <KpiTile
          caption="Runs · 24h"
          value={canNavigate('Jobs') ? total.current.toLocaleString() : '—'}
          unit="runs"
          series={runs.length ? runSparkline(runs, now) : []}
          seriesLabel="Runs, twelve 2-hour buckets"
          footer={
            canNavigate('Jobs')
              ? total.current
                ? succeeded === total.current
                  ? 'All succeeded'
                  : succeeded + ' succeeded, ' + failed.current + ' failed'
                : 'No runs in 24h'
              : 'Requires sync admin'
          }
          disabled={!canNavigate('Jobs')}
          onClick={() => navigate('Jobs')}
        />
        <KpiTile
          caption="Failed · 24h"
          value={canNavigate('Jobs') ? failed.current.toLocaleString() : '—'}
          unit="runs"
          series={runs.length ? runSparkline(runs, now, 'failed') : []}
          seriesLabel="Failed runs, twelve 2-hour buckets"
          footer={
            canNavigate('Jobs')
              ? failed.current
                ? failed.current + ' failed in 24h'
                : 'None in 24h'
              : 'Requires sync admin'
          }
          tone={failed.current ? 'danger' : 'neutral'}
          disabled={!canNavigate('Jobs')}
          onClick={() => navigate('Jobs', 'failed')}
        />
        {qualityTotal > 0 ? (
          <KpiTile
            caption="Data quality"
            value={quality.data!.summary.score.toFixed(1) + '%'}
            series={qualitySeries}
            seriesLabel="Quality pass rate, twelve 2-hour buckets; gaps mean no runs"
            footer={
              quality.data!.summary.counts.passed +
              ' passed, ' +
              quality.data!.summary.counts.failed +
              ' failed' +
              (quality.data!.summary.counts.error
                ? ', ' + quality.data!.summary.counts.error + ' errors'
                : '')
            }
            onClick={() => navigate('Data Quality')}
          />
        ) : (
          <KpiTile
            caption="Last backup"
            value={canNavigate('Backups') ? backupAge : '—'}
            series={
              backups.length
                ? timestampSeries(
                    backups.map((path) => Date.parse(backupTime(path) ?? '')),
                    now,
                    86400000,
                  )
                : []
            }
            seriesLabel="Backups, twelve 24-hour buckets"
            footer={
              canNavigate('Backups') ? 'Backup activity in the last 12 days' : 'Requires admin'
            }
            disabled={!canNavigate('Backups')}
            onClick={() => navigate('Backups')}
          />
        )}
      </div>
      <div className="overview-primary">
        <Tray
          title="Recent runs"
          className="recent-runs"
          actions={
            <Button
              variant="link"
              size="sm"
              disabled={!canNavigate('Jobs')}
              onClick={() => navigate('Jobs')}
            >
              View all
            </Button>
          }
        >
          {canNavigate('Jobs') ? (
            recentRuns.length ? (
              <DataTable>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right tabular-nums">Rows</TableHead>
                    <TableHead className="text-right tabular-nums">Scheduled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRuns.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell title={run.id}>
                        {jobs.find((j) => j.id === run.job_id)?.name ?? run.job_id.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <StatePill state={run.state} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {run.rows_read.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <time
                          dateTime={new Date(run.available_at * 1000).toISOString()}
                          title={
                            new Date(run.available_at * 1000).toLocaleString() +
                            ' · scheduled availability; actual start time is not reported'
                          }
                        >
                          {relativeTime(run.available_at * 1000, now)}
                        </time>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            ) : (
              <p className="hint p-4">No runs yet. Create a sync job to get started.</p>
            )
          ) : (
            <p className="hint p-4">Run history requires sync admin access.</p>
          )}
        </Tray>
        <div className="overview-health">
          <SourceHealth
            sources={sources}
            datasets={datasets}
            jobs={jobs}
            runs={runs}
            client={client}
            me={me}
            readOnly={readOnly}
          />
          <FailingCheck query={quality} onOpen={() => navigate('Data Quality')} />
        </div>
      </div>
      <div className="dashboard-grid">
        <Tray title="Sync activity">
          {canNavigate('Jobs') ? (
            <SyncActivity runs={runs} />
          ) : (
            <p className="hint">Run history requires sync admin access.</p>
          )}
        </Tray>
        <Tray title="Recent activity">
          <p className="hint">The latest from your workspace</p>
          <div className="activity-list">
            {events.slice(0, 4).map((event, i) => (
              <div className="activity-item" key={'event-' + i}>
                <Icon name="console" />
                <div>
                  <code>{event.type}</code>
                  <small>{event.message ?? event.id ?? 'engine'}</small>
                </div>
                {event.state && <StatePill state={event.state} />}
              </div>
            ))}
            {!events.length && (
              <EmptyState icon="clock">
                {canNavigate('Jobs')
                  ? 'Live engine events will appear here as work progresses.'
                  : 'Live engine events will appear here.'}
              </EmptyState>
            )}
          </div>
        </Tray>
      </div>
      <div className="overview-core">
        <RecentQueries scope={scope} onQuery={onQuery} />
        {me.privileges.read || me.privileges.admin ? (
          <Storage client={client} readOnly={readOnly} />
        ) : (
          <section>
            <h2>Storage usage</h2>
            <p className="hint">Storage usage requires read access.</p>
          </section>
        )}
      </div>
      <ActiveWork runs={runs} jobs={jobs} models={models} />
      <section className="failed-jobs">
        <h2>Failed jobs</h2>
        {runs
          .filter((r) => r.state === 'failed')
          .slice(0, 5)
          .map((r) => (
            <div className="overview-row" key={r.id}>
              <span>
                {jobs.find((j) => j.id === r.job_id)?.name ?? r.job_id}
                <small>{r.error ?? 'Run failed'}</small>
              </span>
              <StatePill state="failed" />
            </div>
          ))}
        {!runs.some((r) => r.state === 'failed') && (
          <p className="hint">
            {canNavigate('Jobs')
              ? 'No failed runs in the loaded history.'
              : 'Job history requires sync admin access.'}
          </p>
        )}
      </section>
      <Tray title="Latest runs" actions={<Pill>{runs.length} total</Pill>}>
        {canNavigate('Jobs') ? (
          children
        ) : (
          <p className="hint">Run history requires sync admin access.</p>
        )}
      </Tray>
    </>
  );
}
