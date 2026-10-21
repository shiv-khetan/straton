import type { Dataset, Run } from '@/lib/api';
export function datasetLabel(dataset: Pick<Dataset, 'display_name' | 'name'> | undefined): string {
  return dataset?.display_name ?? dataset?.name ?? '';
}
export function relativeTime(value: string | number | null | undefined, now = Date.now()): string {
  if (value == null) return 'Never';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return 'Unknown';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
  return Math.floor(seconds / 86400) + ' d ago';
}
export function backupTime(path: string | null | undefined): string | null {
  const match = path?.match(/(?:^|[\\/])straton-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\d*Z-/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const time = y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':' + s + 'Z';
  return Number.isFinite(Date.parse(time)) ? time : null;
}
export const chartStates = [
  'succeeded',
  'running',
  'queued',
  'failed',
  'interrupted',
  'cancelled',
] as const;
/**
 * Which matrix columns get a date label. Each labelled column marks the start of a stride
 * (a whole day at 7d/4-per-day; every 5th day at 30d). The active column only gets its own
 * label at 30d, and only when it can't collide with a neighbouring stride label.
 */
export function axisLabelShown(i: number, active: number, range: 7 | 30) {
  const step = range === 7 ? 4 : 5;
  if (i % step === 0) return true;
  const offset = active % step;
  return range === 30 && i === active && offset >= 2 && offset <= step - 2;
}
export function bucketRuns(runs: Run[], now = Date.now(), range: 7 | 30 = 7, perDay: 1 | 4 = 1) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: range }, (_, i) => {
    const date = new Date(today);
    date.setDate(date.getDate() - range + 1 + i);
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    const span = (end.getTime() - date.getTime()) / perDay;
    return Array.from({ length: perDay }, (_, part) => {
      const start = date.getTime() + part * span;
      const axisLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return {
        start,
        end: start + span,
        axisLabel,
        label:
          axisLabel +
          (perDay === 1
            ? ''
            : ' · ' +
              new Date(start).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })),
        succeeded: 0,
        running: 0,
        queued: 0,
        interrupted: 0,
        failed: 0,
        cancelled: 0,
      };
    });
  }).flat();
  for (const run of runs) {
    const time = run.available_at * 1000;
    const day = days.find((d) => time >= d.start && time < d.end && time <= now);
    if (day && chartStates.some((state) => state === run.state))
      day[run.state as (typeof chartStates)[number]]++;
  }
  return days;
}
export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(h);
  } catch {
    return false;
  }
}

export type RunBucket = ReturnType<typeof bucketRuns>[number];
export function matrixLayout(buckets: RunBucket[]) {
  const unit = Math.max(
    1,
    Math.ceil(
      Math.max(0, ...buckets.map((b) => chartStates.reduce((n, state) => n + b[state], 0))) / 16,
    ),
  );
  const rows = Math.max(
    12,
    ...buckets.map((b) => chartStates.reduce((n, state) => n + Math.ceil(b[state] / unit), 0)),
  );
  return { unit, rows };
}
export function matrixCells(bucket: RunBucket, unit: number, rows: number) {
  const cells: ((typeof chartStates)[number] | null)[] = chartStates.flatMap((state) =>
    Array.from({ length: Math.ceil(bucket[state] / unit) }, () => state),
  );
  return [...cells, ...Array.from({ length: Math.max(0, rows - cells.length) }, () => null)];
}
export function navigateBucket(index: number, key: string, count: number): number {
  if (count <= 0) return -1;
  const current = Math.max(0, Math.min(count - 1, index));
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, current - 1);
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(count - 1, current + 1);
  return current;
}
export function bucketTooltip(bucket: RunBucket) {
  return {
    label: bucket.label,
    total: chartStates.reduce((n, state) => n + bucket[state], 0),
    rows: chartStates.map((state) => ({ state, value: bucket[state] })),
  };
}
export function timestampSeries(times: number[], now = Date.now(), step = 7200000) {
  const start = now - 12 * step;
  const series = Array<number>(12).fill(0);
  for (const time of times) {
    if (!Number.isFinite(time) || time <= start || time > now) continue;
    series[Math.min(11, Math.floor((time - start) / step))]++;
  }
  return series;
}
export function runSparkline(runs: Run[], now = Date.now(), state?: string) {
  return timestampSeries(
    runs.filter((run) => !state || run.state === state).map((run) => run.available_at * 1000),
    now,
  );
}
export function runKpi(runs: Run[], now = Date.now(), state?: string) {
  const eligible = runs.filter(
    (run) =>
      (!state || run.state === state) &&
      Number.isFinite(run.available_at) &&
      run.available_at * 1000 <= now,
  );
  const current = eligible.filter((run) => run.available_at * 1000 > now - 86400000).length;
  const previous = eligible.filter(
    (run) => run.available_at * 1000 > now - 172800000 && run.available_at * 1000 <= now - 86400000,
  ).length;
  return { current, previous, delta: current - previous };
}
