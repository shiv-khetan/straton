import type { Run } from '@/lib/api';

export type FailingJob = { run: Run; streak: number };

const finished = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);

/**
 * Jobs that still need attention: one entry per job whose latest finished run failed, with
 * how many finished runs in a row have failed. A job that succeeded since is resolved.
 */
export function failingJobs(runs: Run[], limit = 3): FailingJob[] {
  const byJob = new Map<string, Run[]>();
  for (const run of runs) {
    if (!finished.has(run.state)) continue;
    byJob.set(run.job_id, [...(byJob.get(run.job_id) ?? []), run]);
  }
  const failing: FailingJob[] = [];
  for (const list of byJob.values()) {
    list.sort((a, b) => b.available_at - a.available_at);
    if (list[0].state !== 'failed') continue;
    const streak = list.findIndex((r) => r.state !== 'failed');
    failing.push({ run: list[0], streak: streak === -1 ? list.length : streak });
  }
  return failing.sort((a, b) => b.run.available_at - a.run.available_at).slice(0, limit);
}
