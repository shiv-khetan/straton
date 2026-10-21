import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Api, Job, MapSource, Me, Model, Run } from '@/lib/api';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import { Button } from '@/components/ui/button';
import { can } from '@/features/access/access-model';
import { StatusChip, Skeleton } from '@/features/console/ConsoleDrawer';
import { formatBytes } from './storage-model';
export function SourceHealth({
  sources,
  jobs,
  runs,
  client,
  me,
  readOnly,
}: {
  sources: MapSource[];
  jobs: Job[];
  runs: Run[];
  client: Api;
  me: Me;
  readOnly: boolean;
}) {
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const checkable = sources.filter(
    (s) =>
      s.connected && !['models', 'parquet', 'external'].includes(s.kind) && can(me, 'admin', s.id),
  );
  async function check() {
    setBusy(true);
    await Promise.allSettled(
      checkable.map(async (source) => {
        try {
          const result = await client.checkSource(source.id);
          setChecks((s) => ({
            ...s,
            [source.id]: result.ok ? 'Connection healthy' : 'Check failed',
          }));
        } catch (e) {
          setChecks((s) => ({ ...s, [source.id]: String(e) }));
        }
      }),
    );
    setBusy(false);
  }
  return (
    <section>
      <div className="section-toolbar">
        <h2>Source health</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={readOnly || busy || !checkable.length}
          onClick={() => void check()}
        >
          {busy ? 'Checking…' : 'Check all'}
        </Button>
      </div>
      <div className="overview-rows">
        {sources
          .filter((s) => !['models', 'parquet'].includes(s.kind))
          .map((source) => {
            const ids = new Set(jobs.filter((j) => j.source_id === source.id).map((j) => j.id));
            const last = runs
              .filter((r) => ids.has(r.job_id))
              .sort((a, b) => b.available_at - a.available_at)[0];
            return (
              <div className="overview-row" key={source.id}>
                <span>
                  {source.name}
                  <small>{source.kind}</small>
                </span>
                <span>
                  {checks[source.id] ??
                    (last ? (
                      <StatusChip state={last.state} />
                    ) : source.connected ? (
                      'No runs yet'
                    ) : (
                      'External catalog'
                    ))}
                </span>
              </div>
            );
          })}
        {!sources.length && <p className="hint">Connect a source to monitor its sync health.</p>}
      </div>
    </section>
  );
}
export function ActiveWork({ runs, jobs, models }: { runs: Run[]; jobs: Job[]; models: Model[] }) {
  const active = runs.filter((r) => ['running', 'queued'].includes(r.state));
  const activeModelIds = new Set(active.map((r) => jobs.find((j) => j.id === r.job_id)?.name));
  const modelWork = models.filter(
    (m) => ['running', 'queued'].includes(m.last_run_status ?? '') && !activeModelIds.has(m.name),
  );
  return (
    <section>
      <h2>Active work</h2>
      {active.map((r) => (
        <div className="overview-row" key={r.id}>
          <span>
            {jobs.find((j) => j.id === r.job_id)?.name ?? r.job_id}
            <small>
              <code>{r.committed_batches}</code> committed batches
            </small>
          </span>
          <StatusChip state={r.state} />
        </div>
      ))}
      {modelWork.map((m) => (
        <div className="overview-row" key={m.id}>
          <span>
            {m.name}
            <small>Transformation</small>
          </span>
          <StatusChip state={m.last_run_status ?? 'queued'} />
        </div>
      ))}
      {!active.length && !modelWork.length && <p className="hint">No running or queued work.</p>}
    </section>
  );
}
export function RecentQueries({
  scope,
  onQuery,
}: {
  scope: string;
  onQuery: (sql: string) => void;
}) {
  const history = useSqlWorkspace((s) => s.history)
    .filter((e) => e.scope === scope)
    .slice(0, 5);
  return (
    <section>
      <h2>Recent queries</h2>
      {history.map((e) => (
        <div className="overview-row" key={e.id}>
          <Button variant="ghost" onClick={() => onQuery(e.sql)} className="recent-query">
            <code>{e.sql}</code>
          </Button>
          <code>{e.elapsed_ms.toLocaleString()} ms</code>
          <span>{e.status}</span>
        </div>
      ))}
      {!history.length && (
        <p className="hint">Your recent SQL executions will appear here on this device.</p>
      )}
    </section>
  );
}
export function Storage({ client, readOnly }: { client: Api; readOnly: boolean }) {
  const query = useQuery({
    queryKey: ['engine', 'storage', 'overview'],
    queryFn: () => client.storage(),
    enabled: !readOnly,
  });
  const data = query.data;
  const rows = data
    ? ([
        ['Local lake', data.lake_bytes],
        ['Models', data.models_bytes],
        ['State database', data.state_db_bytes],
        ['Backups', data.backups_bytes],
      ] as const)
    : [];
  return (
    <section>
      <div className="section-toolbar">
        <h2>Storage usage</h2>
        {data && <code>{formatBytes(data.total_bytes)}</code>}
      </div>
      <p className="hint">
        Current snapshots and engine files. Source details follow your access grants.
      </p>
      {query.isPending && <Skeleton label="Measuring storage…" />}
      {query.isError && (
        <div role="alert">
          {String(query.error)}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {rows.map(([name, bytes]) => (
        <div className="storage-row" key={name}>
          <span>{name}</span>
          <meter
            min={0}
            max={Math.max(1, data?.total_bytes ?? 1)}
            value={bytes}
            aria-label={name}
          />
          <code>{formatBytes(bytes)}</code>
        </div>
      ))}
      {data && (
        <details>
          <summary>By source and dataset</summary>
          {data.sources.map((s) => (
            <details key={s.source_id}>
              <summary>
                {s.name} · <code>{formatBytes(s.bytes)}</code>
              </summary>
              {s.datasets.map((d) => (
                <div className="overview-row" key={d.dataset_id}>
                  <code>{d.name}</code>
                  <code>{formatBytes(d.bytes)}</code>
                </div>
              ))}
            </details>
          ))}
        </details>
      )}
    </section>
  );
}
