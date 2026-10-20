import assert from 'node:assert/strict';
import { buildEdges, layout, persist, loadPositions } from '../src/map-model.ts';
const map = {
  nodes: [
    { type: 'source', id: 's1', name: 'Connected', kind: 'sqlite', connected: true },
    { type: 'source', id: 's2', name: 'External', kind: 'external', connected: false },
    { type: 'source', id: 's3', name: 'Empty', kind: 'csv', connected: true },
    ...['a', 'b', 'c'].map((id, i) => ({
      type: 'dataset',
      id,
      source_id: i === 2 ? 's2' : 's1',
      name: id,
      stale: i === 2,
      columns: [{ name: 'id', type: 'Int64', nullable: false, pk: true }],
    })),
  ],
  edges: [
    {
      id: 'e',
      from_dataset: 'a',
      from_cols: ['id'],
      to_dataset: 'c',
      to_cols: ['id'],
      kind: 'manual',
      confidence: null,
    },
  ],
};
const nodes = await layout(map);
assert.equal(nodes.length, 6);
for (const node of nodes) {
  assert.ok(Number.isFinite(node.position.x));
  assert.ok(Number.isFinite(node.position.y));
  if (node.parentId) {
    const parent = nodes.find((n) => n.id === node.parentId);
    assert.ok(parent);
    assert.ok(node.position.x + 320 <= parent.style.width);
    assert.ok(node.position.y + 80 <= parent.style.height);
  }
}
assert.equal(nodes.find((n) => n.id === 's2').data.external, true);
assert.equal(nodes.find((n) => n.id === 'c').data.dataset.stale, true);
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, value),
};
persist('http://localhost:1', nodes);
assert.equal(Object.keys(loadPositions('http://localhost:1')).length, 6);
assert.deepEqual(loadPositions('http://localhost:2'), {});
store.set('straton:map:v1:http://localhost:1', 'corrupt');
assert.deepEqual(loadPositions('http://localhost:1'), {});
globalThis.localStorage = {
  getItem() {
    throw new Error('disabled');
  },
  setItem() {
    throw new Error('disabled');
  },
};
assert.doesNotThrow(() => persist('test', nodes));
assert.deepEqual(loadPositions('test'), {});
assert.deepEqual(await layout({ nodes: [], edges: [] }), []);
console.log(
  'Compound layout, empty/external/stale nodes, position isolation and storage failure checks passed.',
);

// App DB -> Local lake uses the source UUID in its stable destination key.
const sourceId = '3575d1c4-5ec6-4db1-865c-e23e3921b395';
const column = (name) => ({ name, type: 'Int64', nullable: false, pk: name === 'id' });
const dataset = (id, source_id, name, columns) => ({
  type: 'dataset',
  id,
  source_id,
  name,
  stale: false,
  columns: columns.map(column),
});
const relationship = (id, from_dataset, from_cols, to_dataset, to_cols, kind) => ({
  id,
  from_dataset,
  from_cols,
  to_dataset,
  to_cols,
  kind,
  confidence: null,
});
const liveMap = {
  nodes: [
    { type: 'source', id: sourceId, name: 'App DB', kind: 'sqlite', connected: true },
    { type: 'source', id: 'csv', name: 'CSV', kind: 'csv', connected: true },
    { type: 'source', id: 'external', name: 'CRM', kind: 'external', connected: false },
    {
      type: 'source',
      id: 'straton-local-lake',
      name: 'Local lake',
      kind: 'parquet',
      connected: true,
    },
    dataset('customers', sourceId, 'customers', ['id', 'email']),
    dataset('orders', sourceId, 'orders', ['id', 'customer_id']),
    dataset('items', sourceId, 'items', ['id', 'order_id']),
    dataset('purchases', 'csv', 'purchases', ['id', 'customer_id']),
    dataset('contacts', 'external', 'contacts', ['id']),
    dataset('lake-customers', 'straton-local-lake', sourceId + '/customers', ['id']),
    dataset('lake-orders', 'straton-local-lake', sourceId + '/orders', ['id']),
  ],
  edges: [
    relationship('lineage', 'customers', [], 'lake-customers', [], 'lineage'),
    relationship('orders-fk', 'orders', ['customer_id'], 'customers', ['id'], 'declared_fk'),
    relationship('items-fk', 'items', ['order_id'], 'orders', ['id'], 'declared_fk'),
    relationship('inferred', 'purchases', ['customer_id'], 'customers', ['id'], 'inferred'),
    relationship('manual', 'contacts', ['id'], 'customers', ['id'], 'manual'),
  ],
};
function assertHandles(map) {
  const edges = buildEdges(map);
  for (const edge of edges) {
    for (const [id, handle, direction] of [
      [edge.source, edge.sourceHandle, 'out'],
      [edge.target, edge.targetHandle, 'in'],
    ]) {
      const node = map.nodes.find((node) => node.type === 'dataset' && node.id === id);
      assert.ok(node, 'Edge endpoint must be a dataset');
      assert.ok(
        handle === 'dataset:' + direction ||
          node.columns.some((column) => handle === direction + ':' + column.name),
        'Handle must exist on ' + node.name + ': ' + handle,
      );
    }
  }
  return edges;
}
const built = assertHandles(liveMap);
assert.equal(built.length, 5);
assert.equal(built[0].sourceHandle, 'dataset:out');
assert.equal(built[0].targetHandle, 'dataset:in');
assert.equal(built[0].animated, true);
assert.equal(built[1].sourceHandle, 'out:customer_id');
assert.equal(built[1].targetHandle, 'in:id');
assert.equal(built[1].data.kind, 'declared_fk');
assert.equal(built[4].data.relationshipId, 'manual');
const mismatched = assertHandles({
  ...liveMap,
  edges: [
    relationship(
      'lineage',
      'customers',
      ['id', 'email', 'removed'],
      'lake-customers',
      ['id', 'email'],
      'lineage',
    ),
  ],
});
assert.deepEqual(
  mismatched.map((edge) => [edge.sourceHandle, edge.targetHandle]),
  [
    ['out:id', 'in:id'],
    ['out:email', 'dataset:in'],
    ['dataset:out', 'dataset:in'],
  ],
);
assert.deepEqual(
  buildEdges({
    ...liveMap,
    edges: [relationship('orphan', 'customers', ['id'], 'missing', ['id'], 'lineage')],
  }),
  [],
);
assert.deepEqual(buildEdges({ nodes: [], edges: [] }), []);
console.log('Real-shaped lineage, column fallback, composite and missing endpoint checks passed.');
