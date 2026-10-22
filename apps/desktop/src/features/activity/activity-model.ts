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
