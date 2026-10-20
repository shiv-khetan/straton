import type { Dataset, Job, Run, Status } from './api';
import { Card, EmptyState, Icon, Pill, stateTone } from './ui';
import { backupTime, bucketRuns, chartStates, relativeTime } from './view-model';
export default function Dashboard({
  datasets,
  runs,
  jobs,
  status,
  children,
  navigate,
  events,
  canNavigate,
}: {
  datasets: Dataset[];
  runs: Run[];
  jobs: Job[];
  status: Status | null;
  children: React.ReactNode;
  navigate: (page: 'Jobs' | 'Data Map' | 'Backups', filter?: string) => void;
  events: import('./api').EngineEvent[];
  canNavigate: (page: 'Jobs' | 'Data Map' | 'Backups') => boolean;
}) {
  const now = Date.now();
  const cutoff = now - 86400000;
  const recent = runs.filter(
    (r) => r.available_at * 1000 >= cutoff && r.available_at * 1000 <= now,
  );
  const failed = recent.filter((r) => r.state === 'failed').length;
  const synced = datasets.filter((d) => d.source_id !== 'straton-local-lake' && d.last_synced_at);
  const backup = backupTime(status?.last_backup);
  const days = bucketRuns(runs, now);
  const max =
    Math.ceil(
      Math.max(3, ...days.map((d) => chartStates.reduce((sum, state) => sum + d[state], 0))) / 3,
    ) * 3;
  const colors = [
    'var(--success)',
    'var(--running)',
    'var(--warning)',
    'var(--danger)',
    'var(--danger)',
    'var(--ink-2)',
  ];
  return (
    <>
      <div className="telemetry-strip" aria-label="Engine overview">
        <button disabled={!canNavigate('Data Map')} onClick={() => navigate('Data Map')}>
          <code>{canNavigate('Data Map') ? synced.length : '—'}</code> datasets synced
        </button>
        <button disabled={!canNavigate('Jobs')} onClick={() => navigate('Jobs')}>
          <code>{canNavigate('Jobs') ? recent.length : '—'}</code> runs in 24h
        </button>
        <button disabled={!canNavigate('Jobs')} onClick={() => navigate('Jobs', 'failed')}>
          <code>{canNavigate('Jobs') ? failed : '—'}</code> failed in 24h
        </button>
        <button disabled={!canNavigate('Backups')} onClick={() => navigate('Backups')}>
          Last backup <code>{relativeTime(backup)}</code>
        </button>
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
          {canNavigate('Jobs') ? (
            <>
              <svg
                className="activity-chart"
                viewBox="0 0 560 240"
                role="img"
                aria-labelledby="activity-title activity-desc"
              >
                <title id="activity-title">Sync runs over the last seven days</title>
                <desc id="activity-desc">
                  Stacked bars show succeeded, running, queued, failed, interrupted and cancelled
                  runs. Exact values follow in a data table.
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
            </>
          ) : (
            <p className="hint">Run history requires sync admin access.</p>
          )}
        </Card>
        <Card>
          <h2>Events and failures</h2>
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
                    <strong>{jobs.find((j) => j.id === run.job_id)?.name ?? 'Sync run'}</strong>
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
        </Card>
      </div>
      <Card>
        <div className="section-heading">
          <h2>Latest runs</h2>
          <Pill>{runs.length} total</Pill>
        </div>
        {canNavigate('Jobs') ? (
          children
        ) : (
          <p className="hint">Run history requires sync admin access.</p>
        )}
      </Card>
    </>
  );
}
