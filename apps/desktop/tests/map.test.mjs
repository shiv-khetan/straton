import assert from 'node:assert/strict';
import { layout, persist, loadPositions } from '../src/map-model.ts';
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
