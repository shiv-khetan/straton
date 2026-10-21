import {
  Table as DataTable,
  TableCaption,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useId, useState } from 'react';
import type { Dataset, Job, Run, Status } from '@/lib/api';
import {
  EmptyState,
  Icon,
  KpiTile,
  Pill,
  SegmentedControl,
  Tray,
  stateTone,
} from '@/components/workbench/primitives';
import {
  backupTime,
  bucketRuns,
  bucketTooltip,
  axisLabelShown,
  chartStates,
  matrixCells,
  matrixLayout,
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
  const days = bucketRuns(runs, Date.now(), range, range === 7 ? 4 : 1);
  const { unit, rows } = matrixLayout(days);
  const tooltip = active === null ? null : bucketTooltip(days[active]);
  const width = Math.max(560, days.length * 16 + 64);
  const height = rows * 12 + 64;
  const x = (i: number) => 48 + i * ((width - 80) / (days.length - 1));
  return (
    <>
      <div className="chart-toolbar">
        <p>
          <code>
            {days.reduce((sum, day) => sum + bucketTooltip(day).total, 0).toLocaleString()}
          </code>{' '}
          runs <span className="hint">by scheduled time</span>
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
      <div className="matrix-container">
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
          <title>Sync activity by scheduled run time</title>
          <desc>
            Square cells show run counts. Patterns distinguish states. Exact values are available in
            the data table below.
          </desc>
          <defs>
            {chartStates
              .filter((state) => state !== 'succeeded')
              .map((state) => (
                <pattern
                  key={state}
                  id={id + '-' + state}
                  width="8"
                  height="8"
                  patternUnits="userSpaceOnUse"
                >
                  <rect width="8" height="8" fill="var(--panel-2)" />
                  <path
                    d={
                      {
                        running: 'M0 4H8',
                        queued: 'M3 4h2',
                        failed: 'M1 1l6 6M1 7l6-6',
                        interrupted: 'M4 0v3M4 5v3',
                        cancelled: 'M0 8L8 0',
                      }[state]
                    }
                    stroke="var(--ink-2)"
                    strokeWidth={state === 'queued' ? 2 : 1}
                  />
                </pattern>
              ))}
          </defs>
          {[0, Math.floor(rows / 2), rows].map((row) => (
            <g key={row}>
              <text x="4" y={height - 38 - row * 12} className="matrix-axis">
                {row * unit}
              </text>
            </g>
          ))}
          {days.map((day, i) => (
            <g key={day.start} onPointerEnter={() => setActive(i)} onClick={() => setActive(i)}>
              <rect
                x={x(i) - (width - 80) / days.length / 2}
                y="8"
                width={(width - 80) / days.length}
                height={rows * 12 + 28}
                fill="transparent"
              />
              {matrixCells(day, unit, rows).map((state, j) => (
                <rect
                  key={j}
                  x={x(i) - 5}
                  y={height - 50 - j * 12}
                  width="10"
                  height="10"
                  fill={
                    state === 'succeeded'
                      ? 'var(--mark)'
                      : state
                        ? 'url(#' + id + '-' + state + ')'
                        : 'var(--cell-empty)'
                  }
                />
              ))}
              {axisLabelShown(i, active ?? days.length - 1, range) && (
                <text
                  x={x(i)}
                  y={height - 15}
                  textAnchor="middle"
                  className={
                    'matrix-axis' +
                    (day.axisLabel === days[active ?? days.length - 1].axisLabel ? ' current' : '')
                  }
                >
                  {day.axisLabel.toUpperCase()}
                </text>
              )}
            </g>
          ))}
          {active !== null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1="8"
              y2={height - 38}
              stroke="var(--mark)"
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
              <code>{tooltip.total} runs</code>
            </div>
            {tooltip.rows.map(({ state, value }) => (
              <div className="tooltip-row" key={state}>
                <svg className="matrix-key" width="10" height="10" aria-hidden="true">
                  <rect
                    width="10"
                    height="10"
                    fill={state === 'succeeded' ? 'var(--mark)' : 'url(#' + id + '-' + state + ')'}
                  />
                </svg>
                <span>{state}</span>
                <code>{value}</code>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chart-legend">
        {chartStates.map((state) => (
          <span key={state}>
            <svg className="matrix-key" width="10" height="10" aria-hidden="true">
              <rect
                width="10"
                height="10"
                fill={state === 'succeeded' ? 'var(--mark)' : 'url(#' + id + '-' + state + ')'}
              />
            </svg>
            {state}
          </span>
        ))}
      </div>
      <p id={id + '-help'} className="hint chart-help">
        {range === 7 ? 'Four buckets per day. ' : 'Daily buckets. '}Each cell represents{' '}
        {unit === 1 ? '1 run' : 'up to ' + unit + ' runs'}. Focus the chart and use arrow keys;
        Home/End jump to the first/last bucket. Escape dismisses the tooltip.
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
            <TableCaption>Sync activity by bucket, last {range} days</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Date</TableHead>
                {chartStates.map((state) => (
                  <TableHead key={state} scope="col">
                    {state}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((day) => (
                <TableRow key={day.start}>
                  <TableHead scope="row">{day.label}</TableHead>
                  {chartStates.map((state) => (
                    <TableCell key={state}>{day[state]}</TableCell>
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
}: {
  datasets: Dataset[];
  runs: Run[];
  jobs: Job[];
  status: Status | null;
  backups: string[];
  children: React.ReactNode;
  navigate: (page: 'Jobs' | 'Data Map' | 'Backups', filter?: string) => void;
  events: import('@/lib/api').EngineEvent[];
  canNavigate: (page: 'Jobs' | 'Data Map' | 'Backups') => boolean;
}) {
  const now = Date.now();
  const total = runKpi(runs, now);
  const failed = runKpi(runs, now, 'failed');
  const synced = datasets.filter(
    (dataset) => dataset.source_id !== 'straton-local-lake' && dataset.last_synced_at,
  );
  const backup = backupTime(status?.last_backup);
  const backupAge = backup
    ? relativeTime(backup, now)
        .replace('Just now', '<1m')
        .replace(' min ago', 'm')
        .replace(' h ago', 'h')
        .replace(' d ago', 'd')
    : status?.last_backup
      ? 'Unknown'
      : 'Never';
  const deltaLabel = (delta: number) => (delta > 0 ? '+' : '') + delta + ' vs prior 24h';
  return (
    <>
      <div className="kpi-grid" aria-label="Engine overview">
        <KpiTile
          caption="Datasets synced"
          value={canNavigate('Data Map') ? synced.length.toLocaleString() : '—'}
          unit="datasets"
          series={timestampSeries(
            synced.map((dataset) => Date.parse(dataset.last_synced_at!)),
            now,
          )}
          seriesLabel="Latest dataset sync timestamps, twelve 2-hour buckets"
          footer="Latest syncs · last 24h"
          disabled={!canNavigate('Data Map')}
          onClick={() => navigate('Data Map')}
        />
        <KpiTile
          caption="Runs · 24h"
          value={canNavigate('Jobs') ? total.current.toLocaleString() : '—'}
          unit="runs"
          series={runSparkline(runs, now)}
          seriesLabel="Runs, twelve 2-hour buckets"
          footer={canNavigate('Jobs') ? deltaLabel(total.delta) : 'Requires sync admin'}
          tone={total.delta > 0 ? 'success' : total.delta < 0 ? 'danger' : 'neutral'}
          disabled={!canNavigate('Jobs')}
          onClick={() => navigate('Jobs')}
        />
        <KpiTile
          caption="Failed · 24h"
          value={canNavigate('Jobs') ? failed.current.toLocaleString() : '—'}
          unit="runs"
          series={runSparkline(runs, now, 'failed')}
          seriesLabel="Failed runs, twelve 2-hour buckets"
          footer={canNavigate('Jobs') ? deltaLabel(failed.delta) : 'Requires sync admin'}
          tone={failed.delta > 0 ? 'danger' : failed.delta < 0 ? 'success' : 'neutral'}
          disabled={!canNavigate('Jobs')}
          onClick={() => navigate('Jobs', 'failed')}
        />
        <KpiTile
          caption="Last backup"
          value={canNavigate('Backups') ? backupAge : '—'}
          unit={backup ? 'ago' : undefined}
          series={timestampSeries(
            backups.map((path) => Date.parse(backupTime(path) ?? '')),
            now,
            86400000,
          )}
          seriesLabel="Backups, twelve 24-hour buckets"
          footer={canNavigate('Backups') ? 'Backup activity · last 12 days' : 'Requires admin'}
          disabled={!canNavigate('Backups')}
          onClick={() => navigate('Backups')}
        />
      </div>
      <div className="dashboard-grid">
        <Tray title="Sync activity">
          {canNavigate('Jobs') ? (
            <SyncActivity runs={runs} />
          ) : (
            <p className="hint">Run history requires sync admin access.</p>
          )}
        </Tray>
        <Tray title="Events and failures">
          <p className="hint">The latest from your workspace</p>
          <div className="activity-list">
            {[...runs]
              .sort(
                (a, b) =>
                  Number(b.state === 'failed') - Number(a.state === 'failed') ||
                  b.available_at - a.available_at,
              )
              .slice(0, 5)
              .map((run) => (
                <div className="activity-item" key={run.id}>
                  <span className={'icon-tile tone-' + stateTone(run.state)}>
                    <Icon name={run.state === 'failed' ? 'warning' : 'jobs'} />
                  </span>
                  <div>
                    <strong>{jobs.find((job) => job.id === run.job_id)?.name ?? 'Sync run'}</strong>
                    <small title={new Date(run.available_at * 1000).toLocaleString()}>
                      {relativeTime(run.available_at * 1000)}
                    </small>
                  </div>
                  <Pill tone={stateTone(run.state)}>{run.state}</Pill>
                </div>
              ))}
            {events.slice(0, 4).map((event, i) => (
              <div className="activity-item" key={'event-' + i}>
                <Icon name="console" />
                <div>
                  <code>{event.type}</code>
                  <small>{event.message ?? event.id ?? 'engine'}</small>
                </div>
                {event.state && <Pill tone={stateTone(event.state)}>{event.state}</Pill>}
              </div>
            ))}
            {!runs.length && !events.length && (
              <EmptyState icon="clock">
                {canNavigate('Jobs')
                  ? 'Your sync activity will appear after the first run.'
                  : 'Live engine events will appear here.'}
              </EmptyState>
            )}
          </div>
        </Tray>
      </div>
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
