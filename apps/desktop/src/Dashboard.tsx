import type { Dataset, Job, Run, Status } from './api';
import { Card, EmptyState, Icon, KpiCard, Pill, stateTone } from './ui';
import { backupTime, bucketRuns, chartStates, relativeTime } from './view-model';
export default function Dashboard({
  datasets,
  runs,
  jobs,
  status,
  children,
}: {
  datasets: Dataset[];
  runs: Run[];
  jobs: Job[];
  status: Status | null;
  children: React.ReactNode;
}) {
  const now = Date.now();
  const cutoff = now - 86400000;
  const recent = runs.filter(
    (r) => r.available_at * 1000 >= cutoff && r.available_at * 1000 <= now,
  );
  const previous = runs.filter(
    (r) => r.available_at * 1000 >= cutoff - 86400000 && r.available_at * 1000 < cutoff,
  );
  const failed = recent.filter((r) => r.state === 'failed').length;
  const synced = datasets.filter((d) => d.source_id !== 'straton-local-lake' && d.last_synced_at);
  const backup = backupTime(status?.last_backup);
  const days = bucketRuns(runs, now);
  const max =
    Math.ceil(
      Math.max(3, ...days.map((d) => chartStates.reduce((sum, state) => sum + d[state], 0))) / 3,
    ) * 3;
  const colors = ['var(--success)', 'var(--danger)', 'var(--ink-2)'];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Dashboard</h1>
          <p className="hint">A clear view of your data operations.</p>
        </div>
        <Pill tone="success">Engine {status?.version ?? '…'}</Pill>
      </div>
      <div className="kpi-grid">
        <KpiCard
          icon="table"
          label="Datasets synced"
          value={synced.length.toLocaleString()}
          delta={
            synced.filter((d) => Date.parse(d.last_synced_at!) >= cutoff).length + ' synced today'
          }
        />
        <KpiCard
          icon="jobs"
          label="Runs (24h)"
          value={recent.length.toLocaleString()}
          delta={
            (recent.length - previous.length >= 0 ? '+' : '') +
            (recent.length - previous.length) +
            ' vs prior 24h'
          }
          tone="success"
        />
        <KpiCard
          icon="warning"
          label="Failed (24h)"
          value={failed}
          delta={failed ? 'Needs attention' : 'All clear'}
          tone={failed ? 'danger' : 'success'}
        />
        <KpiCard
          icon="backup"
          label="Last backup"
          value={relativeTime(backup)}
          title={
            status?.last_backup
              ? status.last_backup + (backup ? '\n' + new Date(backup).toLocaleString() : '')
              : 'No backup yet'
          }
          delta={backup ? 'Snapshot saved' : 'No backup yet'}
          tone="neutral"
        />
      </div>
      <div className="dashboard-grid">
        <Card>
          <div className="section-heading">
            <div>
              <h2>Sync activity</h2>
              <p className="hint">Last 7 days · by scheduled run time</p>
            </div>
            <Pill>7 days</Pill>
          </div>
          <svg
            className="activity-chart"
            viewBox="0 0 560 240"
            role="img"
            aria-labelledby="activity-title activity-desc"
          >
            <title id="activity-title">Sync runs over the last seven days</title>
            <desc id="activity-desc">
              Stacked bars show succeeded, failed and cancelled runs. Exact values follow in a data
              table.
            </desc>
            {[0, 1, 2, 3].map((i) => (
              <g key={i}>
                <line
                  x1="32"
                  x2="548"
                  y1={196 - i * 55}
                  y2={196 - i * 55}
                  stroke="var(--line)"
                  strokeDasharray="3 4"
                />
                <text x="4" y={200 - i * 55} fill="var(--muted)" fontSize="10">
                  {Math.round((max * i) / 3)}
                </text>
              </g>
            ))}
            {days.map((day, i) => {
              let y = 196;
              return (
                <g key={day.start}>
                  {chartStates.map((state, j) => {
                    const height = (day[state] / max) * 165;
                    y -= height;
                    return (
                      <rect
                        key={state}
                        x={52 + i * 71}
                        y={y}
                        width="30"
                        height={height}
                        rx="2"
                        fill={colors[j]}
                      >
                        <title>{day.label + ': ' + day[state] + ' ' + state}</title>
                      </rect>
                    );
                  })}
                  <text
                    x={67 + i * 71}
                    y="223"
                    textAnchor="middle"
                    fill="var(--muted)"
                    fontSize="11"
                  >
                    {day.label}
                  </text>
                </g>
              );
            })}
          </svg>
          <table className="visually-hidden">
            <caption>Sync activity by day</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {chartStates.map((s) => (
                  <th scope="col" key={s}>
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.start}>
                  <th scope="row">{d.label}</th>
                  {chartStates.map((s) => (
                    <td key={s}>{d[s]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="chart-legend">
            {chartStates.map((s, i) => (
              <span key={s}>
                <i style={{ background: colors[i] }} />
                {s}
              </span>
            ))}
          </div>
        </Card>
        <Card>
          <h2>Recent activity</h2>
          <p className="hint">The latest from your workspace</p>
          <div className="activity-list">
            {runs.slice(0, 5).map((run) => (
              <div className="activity-item" key={run.id}>
                <span className={'icon-tile tone-' + stateTone(run.state)}>
                  <Icon name={run.state === 'failed' ? 'warning' : 'jobs'} />
                </span>
                <div>
                  <strong>{jobs.find((j) => j.id === run.job_id)?.name ?? 'Sync run'}</strong>
                  <small title={new Date(run.available_at * 1000).toLocaleString()}>
                    {relativeTime(run.available_at * 1000)}
                  </small>
                </div>
                <Pill tone={stateTone(run.state)}>{run.state}</Pill>
              </div>
            ))}
            {!runs.length && (
              <EmptyState icon="clock">
                Your sync activity will appear after the first run.
              </EmptyState>
            )}
          </div>
        </Card>
      </div>
      <Card>
        <div className="section-heading">
          <h2>Latest runs</h2>
          <Pill>{runs.length} total</Pill>
        </div>
        {children}
      </Card>
    </>
  );
}
