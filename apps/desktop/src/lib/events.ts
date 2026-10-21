import type { EngineEvent } from './api';
import { queryKeys } from './queryKeys.ts';
import { eventLevel, formatEvent } from '../features/console/workbench-model.ts';
export function eventQueryKeys(event: EngineEvent): readonly (readonly string[])[] {
  if (event.type === 'resync_required') return [queryKeys.all];
  if (/^(catalog|source|dataset|relationship)\./.test(event.type))
    return [queryKeys.sources, queryKeys.catalog, queryKeys.datamap, queryKeys.models];
  if (/^(run|job)\./.test(event.type))
    return [
      queryKeys.runs,
      queryKeys.jobs,
      queryKeys.datamap,
      queryKeys.models,
      queryKeys.catalog,
      queryKeys.status,
    ];
  if (/^model\./.test(event.type)) return [queryKeys.models, queryKeys.datamap, queryKeys.catalog];
  return [];
}
export function notificationList(events: EngineEvent[], limit = 30) {
  return events
    .filter((event) => event.type !== 'resync_required')
    .slice(0, Math.max(0, limit))
    .map((event, index) => ({
      key: [event.received_at ?? 'unknown', event.type, event.id ?? 'engine', index].join(':'),
      title: formatEvent(event).message,
      entity: event.id ?? 'Engine',
      receivedAt: event.received_at,
      level: eventLevel(event),
    }));
}
