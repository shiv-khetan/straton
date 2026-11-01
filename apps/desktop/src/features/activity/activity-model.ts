import type { ActivityEntry } from '../../lib/api.ts';
export function groupActivity(entries: ActivityEntry[]) {
  const days = new Map<string, ActivityEntry[]>();
  const seen = new Set<number>();
  for (const entry of [...entries].sort((a, b) => b.id - a.id)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const key = new Date(entry.at * 1000).toISOString().slice(0, 10);
    const group = days.get(key) ?? [];
    group.push(entry);
    days.set(key, group);
  }
  return [...days].map(([day, items]) => ({ day, items }));
}

const phrases: Record<string, string> = {
  'run.queued': 'Run queued',
  'run.running': 'Run started',
  'run.succeeded': 'Run succeeded',
  'run.failed': 'Run failed',
  'run.cancelled': 'Run cancelled',
  'run.interrupted': 'Run interrupted',
  'source.created': 'Connection added',
  'source.updated': 'Connection updated',
  'source.deleted': 'Connection deleted',
  'job.created': 'Sync job created',
  'job.updated': 'Sync job updated',
  'job.deleted': 'Sync job deleted',
  'explorer.read': 'Table browsed',
  'explorer.export': 'Table exported',
  'explorer.profile': 'Table profiled',
};
/** A readable sentence for an audit action; falls back to the engine's own summary. */
export function activityText(action: string, summary: string): string {
  const text = phrases[action] ?? summary;
  return text ? text[0].toUpperCase() + text.slice(1) : action;
}
/** Names for entity ids that appear in the audit log (runs resolve to their job's name). */
export function entityNames(input: {
  runs: { id: string; job_id: string }[];
  jobs: { id: string; name: string }[];
  sources: { id: string; name: string }[];
  datasets: { id: string; name: string; display_name?: string | null }[];
  models: { id: string; name: string }[];
}): Record<string, string> {
  const names: Record<string, string> = {};
  for (const j of input.jobs) names[j.id] = j.name;
  for (const s of input.sources) names[s.id] = s.name;
  for (const d of input.datasets) names[d.id] = d.display_name ?? d.name;
  for (const m of input.models) names[m.id] = m.name;
  for (const r of input.runs) if (names[r.job_id]) names[r.id] = names[r.job_id];
  return names;
}
