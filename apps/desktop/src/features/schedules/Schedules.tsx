import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Api, Job, Model } from '@/lib/api';
import type { Route } from '@/stores/route-history';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { StatePill } from '@/components/workbench/primitives';
import {
  Choice,
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
} from '@/components/workbench/FeatureState';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { nextCron } from './cron-model';
export default function Schedules({
  client,
  jobs,
  models,
  canSeeJobs,
  onNavigate,
}: {
  client: Api;
  jobs: Job[];
  models: Model[];
  canSeeJobs: boolean;
  onNavigate: (route: Route) => void;
}) {
  const pipelines = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', 'schedules'],
    queryFn: () => client.pipelines(),
  });
  const checks = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'schedules'],
    queryFn: () => client.qualityChecks(),
  });
  const [kind, setKind] = useState('all');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(
    () =>
      [
        ...jobs
          .filter((j) => j.cron && j.source_id !== 'straton-models')
          .map((j) => ({
            id: j.id,
            name: j.name,
            kind: 'Job',
            cron: j.cron!,
            enabled: j.enabled,
            route: 'Jobs' as Route,
          })),
        ...models
          .filter((m) => m.trigger === 'cron' && m.cron)
          .map((m) => ({
            id: m.id,
            name: m.name,
            kind: 'Model',
            cron: m.cron!,
            enabled: m.materialization === 'table',
            route: 'Models' as Route,
          })),
        ...(pipelines.data ?? [])
          .filter((p) => p.cron)
          .map((p) => ({
            id: p.id,
            name: p.name,
            kind: 'Pipeline',
            cron: p.cron!,
            enabled: p.enabled,
            route: 'Pipelines' as Route,
          })),
        ...(checks.data ?? [])
          .filter((c) => c.cron)
          .map((c) => ({
            id: c.id,
            name: c.name,
            kind: 'Check',
            cron: c.cron!,
            enabled: c.enabled,
            route: 'Data Quality' as Route,
          })),
      ]
        .map((r) => {
          try {
            return { ...r, next: r.enabled ? nextCron(r.cron, now) : null, error: '' };
          } catch (e) {
            return { ...r, next: null, error: String(e) };
          }
        })
        .sort(
          (a, b) =>
            (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity) ||
            a.name.localeCompare(b.name),
        ),
    [jobs, models, pipelines.data, checks.data, now],
  );
  const visible = rows.filter((r) => kind === 'all' || r.kind === kind);
  return (
    <section className="space-y-4">
      <div className="section-toolbar">
        <p className="max-w-prose text-ink-2">
          Upcoming runs computed from the engine’s UTC cron schedules. Next run is an estimate;
          execution depends on engine availability and active work.
        </p>
        <Choice
          label="Schedule type"
          value={kind}
          options={['all', 'Job', 'Model', 'Pipeline', 'Check'].map((k) => ({
            value: k,
            label: k === 'all' ? 'All types' : k,
          }))}
          onChange={setKind}
        />
      </div>
      {!canSeeJobs && (
        <p className="text-caption text-ink-2">
          Job schedules require sync admin access. Other schedules follow your visibility.
        </p>
      )}
      {(pipelines.isPending || checks.isPending) && <FeatureLoading label="Loading schedules" />}
      <FeatureError error={pipelines.error} retry={() => void pipelines.refetch()} />
      <FeatureError error={checks.error} retry={() => void checks.refetch()} />
      {!visible.length && !pipelines.isPending && !checks.isPending && (
        <FeatureEmpty
          title="No schedules in this view"
          action="Open pipelines"
          onAction={() => onNavigate('Pipelines')}
        >
          Add a cron schedule to a job, model, pipeline or quality check to see its next run here.
        </FeatureEmpty>
      )}
      {!!visible.length && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Cron (UTC)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next run (local time)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <TableRow key={r.kind + ':' + r.id}>
                <TableCell>
                  <Button variant="link" onClick={() => onNavigate(r.route)}>
                    {r.name}
                  </Button>
                </TableCell>
                <TableCell>{r.kind}</TableCell>
                <TableCell>
                  <code>{r.cron}</code>
                </TableCell>
                <TableCell>
                  <StatePill
                    state={r.error ? 'error' : r.enabled ? 'enabled' : 'disabled'}
                    label={r.error ? 'Invalid cron' : r.enabled ? 'Enabled' : 'Disabled'}
                  />
                </TableCell>
                <TableCell>
                  {r.error ? (
                    <span title={r.error}>Unable to compute</span>
                  ) : !r.enabled ? (
                    'Paused'
                  ) : r.next ? (
                    <time dateTime={r.next.toISOString()} title={r.next.toISOString()}>
                      {r.next.toLocaleString()}
                    </time>
                  ) : (
                    'No future match'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
