import type { Dataset, Job, Run } from '@/lib/api';

export type SourceHealth = 'Failing' | 'Healthy' | 'Never synced';

/** Latest finished run for any job of this source, newest first by schedule time. */
export function lastSourceRun(sourceId: string, jobs: Job[], runs: Run[]): Run | undefined {
  const ids = new Set(jobs.filter((j) => j.source_id === sourceId).map((j) => j.id));
  return runs
    .filter((r) => ids.has(r.job_id) && ['succeeded', 'failed', 'interrupted'].includes(r.state))
    .sort((a, b) => b.available_at - a.available_at)[0];
}

/**
 * One health rule for Overview and Connections: a failed connection check or a failed latest
 * run is Failing; any successful run, synced dataset or passing check is Healthy.
 */
export function sourceHealth(
  sourceId: string,
  jobs: Job[],
  runs: Run[],
  datasets: Dataset[],
  check?: { ok: boolean },
): SourceHealth {
  const last = lastSourceRun(sourceId, jobs, runs);
  if (check?.ok === false || (last && last.state !== 'succeeded')) return 'Failing';
  if (last || check?.ok || datasets.some((d) => d.source_id === sourceId && d.last_synced_at))
    return 'Healthy';
  return 'Never synced';
}
