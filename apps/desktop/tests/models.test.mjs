import assert from 'node:assert/strict';
import { modelStatus, ruleDiffRows, normalizeModelLineage, modelGraph } from '../src/model-model.ts';
import { tableSize } from '../src/map-model.ts';
import ELK from 'elkjs/lib/elk.bundled.js';
assert.deepEqual(modelStatus('broken','succeeded'),{label:'broken',tone:'danger'});
assert.deepEqual(modelStatus('ready','failed'),{label:'failed',tone:'danger'});
assert.deepEqual(modelStatus('ready','queued'),{label:'queued',tone:'warning'});
assert.deepEqual(modelStatus('ready','running'),{label:'running',tone:'info'});
assert.deepEqual(modelStatus('ready',null),{label:'ready',tone:'success'});
assert.deepEqual(ruleDiffRows([]),[]);
assert.deepEqual(ruleDiffRows([{rule:'cancel_compensating_arithmetic',before:'(x + 1) - 1',after:'x'}]).map(r => [r.sign,r.expression,r.kind]),[['−','(x + 1) - 1','before'],['+','x','after']]);
console.log('Model status mapping and explain diff rows passed.');

// Match json_model/lineage in models_api.rs: lineage entries have no columns or runtime fields.
const models = [
  {
    id: 'back', name: 'cust_back', sql: 'SELECT * FROM models.cust_shift',
    materialization: 'table', trigger: 'manual', cron: null, owner_id: 'admin', optimize: true,
    created_at: 1792454400, updated_at: 1792454400, status: 'ready', error: null,
    last_run: null, last_run_status: null, row_count: null,
  },
  {
    id: 'shift', name: 'cust_shift', sql: 'SELECT * FROM app_db.customers',
    materialization: 'view', trigger: 'manual', cron: null, owner_id: 'admin', optimize: true,
    created_at: 1792454400, updated_at: 1792454400, status: 'ready', error: null,
    last_run: null, last_run_status: null, row_count: null,
  },
];
const customers = { id: 'customers', name: 'customers', sql_schema: 'app_db', sql_table: 'customers', source_id: 'app-db' };
const shift = { id: 'dataset-shift', name: 'cust_shift', sql_schema: 'models', sql_table: 'cust_shift', source_id: 'straton-models' };
const back = { id: 'dataset-back', name: 'cust_back', sql_schema: 'models', sql_table: 'cust_back', source_id: 'straton-models' };
const lineages = {
  back: { upstream: [shift], downstream: [] },
  shift: { upstream: [customers], downstream: [back] },
};
const graph = modelGraph(models, lineages);
assert.deepEqual(graph.nodes.map(node => node.id), ['model:back', 'model:shift', 'dataset:customers']);
assert.deepEqual(graph.edges.map(edge => [edge.source, edge.target]), [
  ['model:shift', 'model:back'],
  ['dataset:customers', 'model:shift'],
]);
assert.deepEqual(graph.nodes.find(node => node.dataset)?.dataset.columns, []);
assert.equal(customers.columns, undefined, 'Do not mutate API responses');
const layout = await new ELK().layout({
  id: 'root',
  layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' },
  children: graph.nodes.map(node => ({
    id: node.id,
    ...(node.dataset ? tableSize(node.dataset) : { width: 256, height: 168 }),
  })),
  edges: graph.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
});
assert.equal(layout.children.length, 3);
assert.equal(layout.edges.length, 2);
for (const node of layout.children) {
  assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
  for (const other of layout.children.filter(other => other.id !== node.id)) {
    assert.ok(
      node.x + node.width <= other.x || other.x + other.width <= node.x ||
      node.y + node.height <= other.y || other.y + other.height <= node.y,
      'Real API lineage must lay out without overlapping nodes',
    );
  }
}
const placed = id => layout.children.find(node => node.id === id);
assert.ok(placed('dataset:customers').x < placed('model:shift').x);
assert.ok(placed('model:shift').x < placed('model:back').x);
const catalogDataset = {
  ...customers, type: 'dataset', stale: true, row_count: 42, last_synced_at: '2026-10-20T00:00:00Z',
  columns: [{ name: 'id', type: 'Int64', nullable: false, pk: true }],
};
const enriched = normalizeModelLineage(lineages.shift, [catalogDataset]);
assert.deepEqual(enriched.upstream[0], catalogDataset);
assert.equal(enriched.downstream[0].id, 'dataset-back');
assert.deepEqual(enriched.downstream[0].columns, []);
for (const input of [undefined, null, {}, {upstream: [], downstream: []}, {upstream: null, downstream: null}]) {
  assert.deepEqual(normalizeModelLineage(input), {upstream: [], downstream: []});
}
for (const columns of [undefined, null, []]) {
  assert.deepEqual(normalizeModelLineage({upstream: [{...customers, columns}]}).upstream[0].columns, []);
}
assert.deepEqual(modelGraph(), {nodes: [], edges: []});
assert.deepEqual(modelGraph(null, null), {nodes: [], edges: []});
for (const input of [{}, {back: {}}, {back: null}, {back: {upstream: null}}]) {
  assert.equal(modelGraph(models, input).nodes.length, 2);
  assert.equal(modelGraph(models, input).edges.length, 0);
}
assert.equal(modelGraph(models, {shift: {upstream: [customers, customers]}}).edges.length, 1);
console.log('Real API lineage, catalog enrichment, missing arrays, and non-overlapping model layout passed.');
