import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { Api } from './api';
import { queryKeys } from './queryKeys.ts';
const reads: Partial<Record<keyof Api, QueryKey>> = {
  me: queryKeys.me,
  status: queryKeys.status,
  health: ['engine', 'health'],
  sources: queryKeys.sources,
  source: queryKeys.sources,
  jobs: queryKeys.jobs,
  job: queryKeys.jobs,
  runs: queryKeys.runs,
  datamap: queryKeys.datamap,
  sqlTables: queryKeys.catalog,
  models: queryKeys.models,
  modelLineage: queryKeys.models,
  backups: queryKeys.backups,
  keys: queryKeys.keys,
  roles: queryKeys.roles,
  users: queryKeys.access,
  grants: queryKeys.access,
  policies: queryKeys.access,
  tokens: queryKeys.access,
};
const transient = new Set<keyof Api>([
  'verifyAudit',
  'sqlQuery',
  'sqlExplain',
  'explainModel',
  'validatePolicy',
  'validateModel',
]);
export function queryApi(client: Api, cache: QueryClient): Api {
  return new Proxy(client, {
    get(target, property: keyof Api) {
      const method = target[property] as (...args: unknown[]) => Promise<unknown>;
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        const key = reads[property];
        if (key)
          return cache.fetchQuery({
            queryKey: [...key, property, ...args],
            queryFn: () => method(...args),
          });
        const value = await method(...args);
        if (!transient.has(property)) await cache.invalidateQueries({ queryKey: queryKeys.all });
        return value;
      };
    },
  });
}
