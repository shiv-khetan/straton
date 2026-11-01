import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { queryApi } from '../src/lib/queryApi.ts';
import { queryKeys } from '../src/lib/queryKeys.ts';
import { eventQueryKeys } from '../src/lib/events.ts';
import { laterRoutes } from '../src/stores/route-history.ts';
const reads = {
  pipelines: 'pipelines',
  pipeline: 'pipelines',
  pipelineRuns: 'pipelines',
  pipelineRun: 'pipelines',
  qualityChecks: 'quality',
  qualityCheck: 'quality',
  qualityCheckRuns: 'quality',
  qualityRuns: 'quality',
  qualitySummary: 'quality',
  charts: 'charts',
  chart: 'charts',
  chartData: 'charts',
  drillChart: 'charts',
  dashboards: 'dashboards',
  dashboard: 'dashboards',
  lineageImpact: 'impact',
  activity: 'activity',
  notifications: 'notifications',
  notificationCount: 'notifications',
};
const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
const counts = {};
const raw = Object.fromEntries(
  Object.keys(reads).map((method) => [
    method,
    async (...args) => {
      counts[method] = (counts[method] ?? 0) + 1;
      return { method, args };
    },
  ]),
);
let validates = 0,
  previews = 0;
raw.validatePipeline = async () => {
  validates++;
  return { valid: true, errors: [] };
};
raw.previewChart = async () => {
  previews++;
  return { columns: [], rows: [] };
};
raw.readNotifications = async () => {};
const client = queryApi(raw, cache);
try {
  for (const [method, domain] of Object.entries(reads)) {
    const args =
      method === 'lineageImpact'
        ? [{ node: 'dataset:orders', direction: 'both' }]
        : method === 'activity'
          ? [{ before_id: 42, actor: 'owner' }]
          : method === 'notifications'
            ? [{ unread: true }]
            : [
                  'pipeline',
                  'pipelineRuns',
                  'pipelineRun',
                  'qualityCheck',
                  'qualityCheckRuns',
                  'chart',
                  'chartData',
                  'drillChart',
                  'dashboard',
                ].includes(method)
              ? ['entity']
              : [];
    const timeout = AbortSignal.timeout(1000);
    const result = await Promise.race([
      cache.fetchQuery({
        queryKey: [...queryKeys[domain], 'view', method, ...args],
        queryFn: () => client[method](...args),
      }),
      new Promise((_, reject) =>
        timeout.addEventListener('abort', () => reject(Error('Cache deadlock: ' + method)), {
          once: true,
        }),
      ),
    ]);
    assert.equal(result.method, method);
    await client[method](...args);
    assert.equal(counts[method], 1);
  }
  await client.validatePipeline({});
  await client.validatePipeline({});
  assert.equal(validates, 2);
  await client.previewChart({ sql: 'SELECT 1', config: {} });
  await client.previewChart({ sql: 'SELECT 1', config: {} });
  assert.equal(previews, 2);
  assert.ok(
    cache
      .getQueryCache()
      .getAll()
      .every((q) => !q.state.isInvalidated),
  );
  await client.readNotifications({ all: true });
  assert.ok(
    cache
      .getQueryCache()
      .getAll()
      .every((q) => q.state.isInvalidated),
  );
} finally {
  cache.clear();
}
for (const type of ['pipeline_run', 'pipeline_node']) {
  const keys = eventQueryKeys({ type });
  assert.ok(keys.includes(queryKeys.pipelines));
  assert.ok(keys.includes(queryKeys.quality));
  assert.ok(keys.includes(queryKeys.activity));
}
assert.ok(eventQueryKeys({ type: 'notification' }).includes(queryKeys.notifications));
// Settings is a real page now; only Config as Code remains a placeholder.
assert.deepEqual(laterRoutes, ['Config as Code']);
console.log(
  'Phase 3: every cached read settles without recursion; previews stay transient; mutations/events invalidate; routes are live.',
);

// Exercise real client serialization and error handling through Tauri's mock IPC.
const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks');
globalThis.window = globalThis;
const { api, ApiError } = await import('../src/lib/api.ts');
let last,
  status = 200,
  payload = { ok: true },
  sent = false;
mockIPC(async (cmd, args) => {
  if (cmd === 'plugin:http|fetch') {
    last = args.clientConfig;
    sent = false;
    return 1;
  }
  if (cmd === 'plugin:http|fetch_send')
    return {
      status,
      statusText: 'Test',
      url: last.url,
      headers: [['content-type', 'application/json']],
      rid: 2,
    };
  if (cmd === 'plugin:http|fetch_read_body') {
    if (sent) return [1];
    sent = true;
    return [...new TextEncoder().encode(JSON.stringify(payload)), 0];
  }
  if (cmd === 'plugin:http|fetch_cancel_body') return;
  throw Error('Unexpected IPC ' + cmd);
});
const apiClient = api({ url: 'http://localhost:8787', token: 'test-token' });
const call = async (method, args, path, verb = 'GET', body) => {
  status = verb === 'DELETE' ? 204 : 200;
  payload = { ok: true };
  await apiClient[method](...args);
  assert.equal(last.url, 'http://localhost:8787' + path);
  assert.equal(last.method, verb);
  assert.equal(new Headers(last.headers).get('Authorization'), 'Bearer test-token');
  if (body !== undefined)
    assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(last.data))), body);
};
try {
  await call('pipelines', [], '/v1/pipelines');
  await call('pipeline', ['a/b'], '/v1/pipelines/a%2Fb');
  const graph = { name: 'Daily', description: '', cron: null, enabled: true, nodes: [], edges: [] };
  await call('createPipeline', [graph], '/v1/pipelines', 'POST', graph);
  await call('updatePipeline', ['p', graph], '/v1/pipelines/p', 'PUT', graph);
  await call('deletePipeline', ['p'], '/v1/pipelines/p', 'DELETE');
  await call('validatePipeline', [graph], '/v1/pipelines/validate', 'POST', graph);
  await call('runPipeline', ['p'], '/v1/pipelines/p/run', 'POST');
  await call('pipelineRuns', ['p', 3], '/v1/pipelines/p/runs?limit=3');
  await call('pipelineRun', ['r'], '/v1/pipeline-runs/r');
  status = 202;
  await apiClient.cancelPipelineRun('r');
  assert.equal(last.url, 'http://localhost:8787/v1/pipeline-runs/r/cancel');
  const check = {
    name: 'IDs',
    dataset_id: 'd',
    model_id: null,
    kind: 'unique',
    column_name: 'id',
    config: {},
    severity: 'error',
    cron: null,
    enabled: true,
  };
  await call('qualityChecks', [], '/v1/quality/checks');
  await call('qualityCheck', ['q'], '/v1/quality/checks/q');
  await call('createQualityCheck', [check], '/v1/quality/checks', 'POST', check);
  await call('updateQualityCheck', ['q', check], '/v1/quality/checks/q', 'PUT', check);
  await call('deleteQualityCheck', ['q'], '/v1/quality/checks/q', 'DELETE');
  await call('runQualityCheck', ['q'], '/v1/quality/checks/q/run', 'POST');
  await call('qualityCheckRuns', ['q', 2], '/v1/quality/checks/q/runs?limit=2');
  await call('qualityRuns', [4], '/v1/quality/runs?limit=4');
  await call('qualitySummary', [], '/v1/quality/summary');
  const chart = {
    name: 'Counts',
    sql: 'SELECT 1',
    kind: 'stat',
    config: { y: ['value'] },
    shared: false,
  };
  await call('charts', [], '/v1/charts');
  await call('chart', ['c'], '/v1/charts/c');
  await call('createChart', [chart], '/v1/charts', 'POST', chart);
  await call('updateChart', ['c', chart], '/v1/charts/c', 'PUT', chart);
  await call('deleteChart', ['c'], '/v1/charts/c', 'DELETE');
  await call('chartData', ['c', { from: 0, to: 9 }], '/v1/charts/c/data', 'POST', {
    from: 0,
    to: 9,
  });
  await call('previewChart', [{ sql: 'SELECT 1', config: {} }], '/v1/charts/preview', 'POST', {
    sql: 'SELECT 1',
    config: {},
  });
  await call(
    'drillChart',
    ['c', { x_value: null, from: '2026-10-01' }],
    '/v1/charts/c/drill',
    'POST',
    { x_value: null, from: '2026-10-01' },
  );
  const dashboard = { name: 'Ops', description: '', layout: [], shared: false };
  await call('dashboards', [], '/v1/dashboards');
  await call('dashboard', ['d'], '/v1/dashboards/d');
  await call('createDashboard', [dashboard], '/v1/dashboards', 'POST', dashboard);
  await call('updateDashboard', ['d', dashboard], '/v1/dashboards/d', 'PUT', dashboard);
  await call('deleteDashboard', ['d'], '/v1/dashboards/d', 'DELETE');
  await call(
    'columnLineage',
    [{ dataset_id: 'a/b', column: 'gross margin', direction: 'upstream', depth: 2 }],
    '/v1/lineage/columns?dataset=a%2Fb&column=gross+margin&direction=upstream&depth=2',
  );
  await call(
    'lineageImpact',
    [{ node: 'dataset:a/b', direction: 'both', depth: 2 }],
    '/v1/lineage/impact?node=dataset%3Aa%2Fb&direction=both&depth=2',
  );
  await call(
    'activity',
    [{ before_id: 0, limit: 50, action_prefix: 'pipeline.', actor: 'a', entity: 'p' }],
    '/v1/activity?before_id=0&limit=50&action_prefix=pipeline.&actor=a&entity=p',
  );
  await call(
    'notifications',
    [{ unread: false, limit: 20 }],
    '/v1/notifications?unread=false&limit=20',
  );
  await call('readNotifications', [{ all: true }], '/v1/notifications/read', 'POST', { all: true });
  await call('notificationCount', [], '/v1/notifications/unread-count');
  status = 422;
  payload = { valid: false, errors: [{ node_id: 'a', message: 'Missing reference' }] };
  await assert.rejects(
    apiClient.createPipeline(graph),
    (e) =>
      e instanceof ApiError &&
      e.status === 422 &&
      e.validation.errors[0].node_id === 'a' &&
      e.message === 'Missing reference',
  );
  status = 409;
  payload = { error: 'pipeline already has an active run' };
  await assert.rejects(apiClient.runPipeline('p'), /already has an active run/);
} finally {
  clearMocks();
  delete globalThis.window;
}
console.log(
  'Phase 3 client: endpoint paths, encoded IDs, request bodies, auth, cancellation and validation/conflict responses.',
);
