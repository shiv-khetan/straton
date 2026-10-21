import { useQuery } from '@tanstack/react-query';
import type { Api, DataMap, Source } from '@/lib/api';
import { can, canPage } from '@/features/access/access-model';
import { queryKeys } from '@/lib/queryKeys';
const emptyMap: DataMap = { nodes: [], edges: [] };
const queryOptions = { retry: false } as const;
export function useEngineData(client: Api | null, asRole: string) {
  const identity = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.me, 'me'],
    queryFn: () => client!.me(),
    enabled: !!client,
  });
  const me = client ? (identity.data ?? null) : null;
  const status = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.status, 'status'],
    queryFn: () => client!.status(),
    enabled: !!client && !!me,
  });
  const sources = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.sources, 'sources'],
    queryFn: () => client!.sources(),
    enabled: !!client && canPage(me, 'Sources'),
  });
  const jobs = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.jobs, 'jobs'],
    queryFn: () => client!.jobs(),
    enabled: !!client && can(me, 'sync_admin'),
  });
  const runs = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.runs, 'runs'],
    queryFn: () => client!.runs(),
    enabled: !!client && can(me, 'sync_admin'),
  });
  const role = me?.privileges.admin ? asRole : '';
  const map = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.datamap, 'datamap', role],
    queryFn: () => client!.datamap(role),
    enabled: !!client && can(me, 'read'),
  });
  const backups = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.backups, 'backups'],
    queryFn: () => client!.backups(),
    enabled: !!client && can(me, 'admin'),
  });
  const roles = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.roles, 'roles'],
    queryFn: () => client!.roles(),
    enabled: !!client && can(me, 'admin'),
  });
  const models = useQuery({
    ...queryOptions,
    queryKey: [...queryKeys.models, 'models'],
    queryFn: () => client!.models(),
    enabled: !!client && canPage(me, 'Models'),
  });
  const errors = [identity, status, sources, jobs, runs, map, backups, roles, models]
    .filter((query) => query.isError)
    .map((query) => String(query.error));
  const scopedSources: Source[] =
    me?.privileges.grants
      .filter(
        (grant) =>
          grant.target_kind === 'source' && ['sync_admin', 'admin'].includes(grant.privilege),
      )
      .map((grant) => ({
        id: grant.target_id,
        name: grant.target_id,
        kind: 'noop',
        config: {},
        credential_id: null,
      })) ?? [];
  return {
    me,
    status: status.data ?? null,
    sources: canPage(me, 'Sources') ? (sources.data ?? []) : scopedSources,
    jobs: can(me, 'sync_admin') ? (jobs.data ?? []) : [],
    runs: can(me, 'sync_admin') ? (runs.data ?? []) : [],
    map: can(me, 'read') ? (map.data ?? emptyMap) : emptyMap,
    backups: can(me, 'admin') ? (backups.data ?? []) : [],
    roles: can(me, 'admin') ? (roles.data ?? []) : [],
    models: canPage(me, 'Models') ? (models.data ?? []) : [],
    loading:
      !!client &&
      (identity.isPending ||
        (!!me &&
          [status, sources, jobs, runs, map, models, backups, roles].some(
            (query) => query.isFetching && !query.data,
          ))),
    error: errors[0] ?? '',
  };
}
