import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { Api } from './api';
import { queryKeys } from './queryKeys.ts';
// Every client method is exactly one of: a cached read, a transient call, or a mutation that
// invalidates engine queries afterwards (tests/ui-shell.test.mjs enforces this). A read left
// unclassified would be treated as a mutation and invalidate the query awaiting it forever.
export const reads: Partial<Record<keyof Api, QueryKey>> = {
  pipelines: queryKeys.pipelines,
  pipeline: queryKeys.pipelines,
  pipelineRuns: queryKeys.pipelines,
  pipelineRun: queryKeys.pipelines,
  qualityChecks: queryKeys.quality,
  qualityCheck: queryKeys.quality,
  qualityCheckRuns: queryKeys.quality,
  qualityRuns: queryKeys.quality,
  qualitySummary: queryKeys.quality,
  charts: queryKeys.charts,
  chart: queryKeys.charts,
  chartData: queryKeys.charts,
  drillChart: queryKeys.charts,
  dashboards: queryKeys.dashboards,
  dashboard: queryKeys.dashboards,
  lineageImpact: queryKeys.impact,
  columnLineage: [...queryKeys.impact, 'columns'],
  activity: queryKeys.activity,
  notifications: queryKeys.notifications,
  notificationCount: queryKeys.notifications,
  explorerTree: ['engine', 'explorer', 'tree'],
  storage: ['engine', 'storage'],
  savedQueries: ['engine', 'saved-queries'],
  me: queryKeys.me,
  status: queryKeys.status,
  health: ['engine', 'health'],
  advisor: ['engine', 'optimizer', 'advisor'],
  datasetOptimization: ['engine', 'optimizer', 'datasets'],
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
  engineSettings: queryKeys.settings,
  keys: queryKeys.keys,
  roles: queryKeys.roles,
  users: queryKeys.access,
  grants: queryKeys.access,
  policies: queryKeys.access,
  tokens: queryKeys.access,
  tags: queryKeys.access,
};
export const transient = new Set<keyof Api>([
  'validatePipeline',
  'previewChart',
  'explorerRows',
  'explorerExport',
  'cancelSql',
  'verifyAudit',
  'sqlQuery',
  'sqlExplain',
  'explainModel',
  'validatePolicy',
  'validateModel',
  // Profiles depend on the current filters and must not invalidate the rows they describe.
  'explorerProfile',
]);
/** Calls that change engine state; every engine query is invalidated after them. */
export const mutations = new Set<keyof Api>([
  'createPipeline',
  'updatePipeline',
  'deletePipeline',
  'runPipeline',
  'cancelPipelineRun',
  'createQualityCheck',
  'updateQualityCheck',
  'deleteQualityCheck',
  'runQualityCheck',
  'createChart',
  'updateChart',
  'deleteChart',
  'createDashboard',
  'updateDashboard',
  'deleteDashboard',
  'readNotifications',
  'rotateKek',
  'rotateDatasetKey',
  'createModel',
  'updateModel',
  'deleteModel',
  'runModel',
  'createUser',
  'updateUser',
  'assignRoles',
  'issueToken',
  'revokeToken',
  'createRole',
  'deleteRole',
  'createGrant',
  'deleteGrant',
  'rowFilter',
  'mask',
  'tagColumn',
  'tagMask',
  'createSavedQuery',
  'updateSavedQuery',
  'deleteSavedQuery',
  'refreshAdvisor',
  'applyAdvice',
  'rollbackAdvice',
  'dismissAdvice',
  'relayoutDataset',
  'createSource',
  'updateSource',
  'deleteSource',
  'checkSource',
  'discoverSource',
  'createDataset',
  'createRelationship',
  'deleteRelationship',
  'createJob',
  'updateJob',
  'deleteJob',
  'runJob',
  'cancelRun',
  'backup',
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
