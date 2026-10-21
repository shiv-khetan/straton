import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { queryApi } from '../src/lib/queryApi.ts';
import { queryKeys } from '../src/lib/queryKeys.ts';
const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
let reads = 0, mutations = 0, queries = 0;
const client = queryApi({
  models: async () => { reads++; return [{ id:'one' }]; },
  runModel: async () => { mutations++; return { id:'run' }; },
  sqlQuery: async () => { queries++; return { rows: [[1]] }; },
}, cache);
try {
  const [a,b] = await Promise.all([client.models(), client.models()]);
  assert.deepEqual(a,b); assert.equal(reads,1);
  await client.models(); assert.equal(reads,1);
  assert.deepEqual(cache.getQueryData([...queryKeys.models,'models']),[{id:'one'}]);
  await client.runModel('one'); assert.equal(mutations,1);
  assert.equal(cache.getQueryState([...queryKeys.models,'models']).isInvalidated,true);
  await client.models(); assert.equal(reads,2);
  await client.sqlQuery('sensitive SQL');
  await client.sqlQuery('sensitive SQL');
  assert.equal(queries,2);
  assert.ok(!JSON.stringify(cache.getQueryCache().getAll().map(q=>q.queryKey)).includes('sensitive'));
  cache.clear();
  await client.models(); assert.equal(reads,3);
} finally { cache.clear(); }
console.log('Query reads deduplicate/cache, mutations invalidate, SQL remains uncached, and connection cache clearing reloads data.');
// Regression: a view's own query key must differ from the proxy's cache key, otherwise
// fetchQuery inside the view's queryFn awaits itself and never settles (SQL catalog panel).
{
  const deadlockCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const proxied = queryApi({ sqlTables: async () => ({ tables: [{ schema: 's', name: 't', columns: [] }] }) }, deadlockCache);
  const settled = await Promise.race([
    deadlockCache.fetchQuery({
      queryKey: ['engine', 'catalog', 'sql-workspace-tables'],
      queryFn: () => proxied.sqlTables(),
    }),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
  ]);
  assert.notEqual(settled, 'timeout');
  assert.equal(settled.tables.length, 1);
  console.log('SQL catalog query key does not deadlock with the client cache.');
}
