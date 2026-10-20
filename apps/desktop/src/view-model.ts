import type { Dataset, Run } from './api';
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
export const chartStates = ['succeeded', 'failed', 'cancelled'] as const;
export function bucketRuns(runs: Run[], now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(today);
    date.setDate(date.getDate() - 6 + i);
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    return {
      start: date.getTime(),
      end: end.getTime(),
      label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
  });
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
