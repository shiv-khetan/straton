import type { Dataset, Job, Me, Model, Source } from '@/lib/api';
import { can, canPage } from '@/features/access/access-model';
import type { Command } from '@/features/console/workbench-model';
import { datasetLabel } from '@/lib/view-model';
import { routeLabels } from '@/stores/route-history';
import type { Route } from '@/stores/route-history';
import { navigation, routeAvailable } from './navigation';

// Everything the command palette can jump to or run, filtered to what this identity may use.
export function buildCommands(
  me: Me | null,
  datasets: Dataset[],
  models: Model[],
  jobs: Job[],
  sources: Source[],
): Command[] {
  return [
    ...[...navigation.flatMap((group) => group.items.map((item) => item.route)), 'Connect' as Route]
      .filter((route) => routeAvailable(me, route))
      .map((route) => ({
        id: 'route:' + route,
        label: routeLabels[route],
        kind: 'action' as const,
        detail: 'Go to page',
      })),
    ...(can(me, 'read')
      ? [{ id: 'sql', label: 'Open SQL', kind: 'action' as const, detail: 'SQL Studio' }]
      : []),
    ...(me
      ? [
          {
            id: 'new-model',
            label: 'New model',
            kind: 'action' as const,
            detail: 'SQL transformation',
          },
        ]
      : []),
    ...(can(me, 'sync_admin')
      ? [
          {
            id: 'new-job',
            label: 'New sync job',
            kind: 'action' as const,
            keywords: 'create pipeline',
          },
        ]
      : []),
    ...datasets.map((d) => ({
      id: 'dataset:' + d.id,
      label: datasetLabel(d),
      kind: 'dataset' as const,
      detail: d.sql_schema + '.' + d.sql_table,
    })),
    ...models.map((m) => ({
      id: 'model:' + m.id,
      label: m.name,
      kind: 'model' as const,
      detail: m.materialization + ' · ' + m.trigger,
    })),
    ...jobs.map((j) => ({
      id: 'job:' + j.id,
      label: 'Run job ' + j.name,
      kind: 'job' as const,
      detail: j.dataset,
    })),
    ...(canPage(me, 'Sources')
      ? sources.map((s) => ({
          id: 'source:' + s.id,
          label: s.name,
          kind: 'source' as const,
          detail: s.kind,
        }))
      : []),
  ];
}
