import type { Dataset, EngineEvent, Job, Model, ModelLineage, Run } from '@/lib/api';
export type Command = {
  id: string;
  label: string;
  kind: 'action' | 'dataset' | 'model' | 'job' | 'source';
  detail?: string;
  keywords?: string;
};
export function rankCommands(commands: Command[], query: string): Command[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands
    .map((command, order) => {
      const label = command.label.toLocaleLowerCase();
      const haystack = [label, command.kind, command.detail, command.keywords]
        .join(' ')
        .toLocaleLowerCase();
      const score = words.every((word) => haystack.includes(word))
        ? words.reduce(
            (sum, word) =>
              sum +
              (label === word ? 100 : label.startsWith(word) ? 50 : label.includes(word) ? 20 : 1),
            0,
          )
        : -1;
      return { command, order, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((item) => item.command);
}
// `inlined`: view models are never materialized, so they have no run state to report.
export type ChipState =
  'succeeded' | 'running' | 'queued' | 'stale' | 'failed' | 'never synced' | 'inlined';
export function statusChip(state: string | null | undefined): {
  state: ChipState;
  label: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
} {
  const value = state?.toLowerCase();
  const normalized: ChipState =
    value === 'inlined'
      ? 'inlined'
      : value === 'running'
        ? 'running'
        : value === 'queued'
          ? 'queued'
          : value === 'stale' || value === 'cancelled'
            ? 'stale'
            : ['failed', 'interrupted', 'broken'].includes(value ?? '')
              ? 'failed'
              : ['succeeded', 'ready', 'connected', 'live'].includes(value ?? '')
                ? 'succeeded'
                : 'never synced';
  return {
    state: normalized,
    label:
      normalized === 'inlined'
        ? 'View · inlined'
        : normalized[0].toUpperCase() + normalized.slice(1),
    tone:
      normalized === 'running'
        ? 'info'
        : normalized === 'succeeded'
          ? 'success'
          : normalized === 'failed'
            ? 'danger'
            : ['queued', 'stale'].includes(normalized)
              ? 'warning'
              : 'neutral',
  };
}
export function datasetJobs(dataset: Dataset, jobs: Job[]): Job[] {
  return jobs.filter(
    (job) =>
      (job.source_id === dataset.source_id && job.dataset === dataset.name) ||
      (dataset.source_id === 'straton-local-lake' &&
        job.source_id !== null &&
        dataset.name === job.source_id + '/' + job.dataset),
  );
}
export function datasetRun(dataset: Dataset, jobs: Job[], runs: Run[]): Run | undefined {
  const ids = new Set(datasetJobs(dataset, jobs).map((job) => job.id));
  return runs
    .filter((run) => ids.has(run.job_id))
    .sort((a, b) => b.available_at - a.available_at)[0];
}
export function datasetState(dataset: Dataset, jobs: Job[], runs: Run[]): ChipState {
  const run = datasetRun(dataset, jobs, runs);
  if (run?.state === 'cancelled' && !dataset.last_synced_at && !dataset.stale)
    return 'never synced';
  return dataset.stale
    ? 'stale'
    : run
      ? statusChip(run.state).state
      : dataset.last_synced_at
        ? 'succeeded'
        : 'never synced';
}
export function drawerBounds(available: number) {
  const max = Math.max(
    36,
    Math.floor((Number.isFinite(available) ? Math.max(0, available) : 600) * 0.7),
  );
  return { min: Math.min(120, max), max };
}
export function clampDrawerHeight(height: number, available: number): number {
  const { min, max } = drawerBounds(available);
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(height) ? height : 256)));
}
export type LogLevel = 'INFO' | 'RUN' | 'WARN' | 'ERROR';
export function eventLevel(event: EngineEvent): LogLevel {
  if (['failed', 'interrupted'].includes(event.state ?? '') || /error|fail/i.test(event.type))
    return 'ERROR';
  if (['queued', 'cancelled'].includes(event.state ?? '') || /warn|resync/i.test(event.type))
    return 'WARN';
  return event.type.startsWith('run.') || event.state === 'running' ? 'RUN' : 'INFO';
}
export function formatEvent(event: EngineEvent) {
  const date = new Date(event.received_at ?? NaN);
  const time = Number.isFinite(date.getTime())
    ? [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':') +
      '.' +
      String(date.getMilliseconds()).padStart(3, '0')
    : '—';
  const level = eventLevel(event);
  const entity = event.id ?? 'engine';
  const message = event.message || event.type + (event.state ? ' → ' + event.state : '');
  return { time, level, entity, message, text: [time, level, entity, message].join('  ') };
}
export function modelGraph(models: Model[], lineages: Record<string, ModelLineage>) {
  const nodes: { id: string; model?: Model; dataset?: Dataset }[] = models.map((model) => ({
    id: 'model:' + model.id,
    model,
  }));
  const edges: { id: string; source: string; target: string }[] = [];
  const ids = new Set(nodes.map((node) => node.id));
  for (const model of models) {
    for (const dataset of lineages[model.id]?.upstream ?? []) {
      const upstream =
        dataset.sql_schema === 'models'
          ? models.find((m) => m.name === dataset.sql_table)
          : undefined;
      const source = upstream ? 'model:' + upstream.id : 'dataset:' + dataset.id;
      if (!ids.has(source)) {
        nodes.push({ id: source, dataset });
        ids.add(source);
      }
      const target = 'model:' + model.id;
      const id = JSON.stringify([source, target]);
      if (source !== target && !edges.some((edge) => edge.id === id))
        edges.push({ id, source, target });
    }
  }
  return { nodes, edges };
}
