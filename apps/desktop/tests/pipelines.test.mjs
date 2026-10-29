import assert from 'node:assert/strict';
import { graphValidation, validationDisplay } from '../src/features/pipelines/pipeline-model.ts';
const node = (id) => ({ node_id: id, kind: 'sync', ref_id: 'job', label: id, x: 0, y: 0 });
const graph = {
  name: 'Daily',
  description: '',
  cron: null,
  enabled: true,
  nodes: [node('a'), node('b'), node('c')],
  edges: [
    { from_node: 'a', to_node: 'c' },
    { from_node: 'b', to_node: 'c' },
  ],
};
assert.equal(graphValidation(graph).valid, true);
assert.equal(graphValidation({ ...graph, nodes: [] }).valid, false);
assert.equal(graphValidation({ ...graph, name: ' ' }).valid, false);
for (const edges of [
  [{ from_node: 'a', to_node: 'a' }],
  [...graph.edges, graph.edges[0]],
  [{ from_node: 'missing', to_node: 'a' }],
  [
    { from_node: 'a', to_node: 'b' },
    { from_node: 'b', to_node: 'a' },
  ],
])
  assert.equal(graphValidation({ ...graph, edges }).valid, false);
assert.equal(graphValidation({ ...graph, nodes: [node('a'), node('a')] }).valid, false);
assert.equal(graphValidation({ ...graph, nodes: [{ ...node('a'), ref_id: '' }] }).valid, false);
const validation = {
  valid: false,
  errors: [
    { message: 'Invalid cron' },
    { node_id: 'b', message: 'Reference no longer exists' },
    { node_id: 'b', message: 'Not allowed' },
  ],
};
assert.deepEqual(validationDisplay(graph, validation), {
  global: ['Invalid cron'],
  nodes: { a: [], b: ['Reference no longer exists', 'Not allowed'], c: [] },
});
assert.deepEqual(validationDisplay(graph, { valid: true, errors: [] }).nodes.b, []);
console.log(
  'Pipelines: graph validation and server errors map to the correct nodes and global panel.',
);

const cycle = {
  ...graph,
  edges: [
    { from_node: 'a', to_node: 'b' },
    { from_node: 'b', to_node: 'a' },
    { from_node: 'b', to_node: 'c' },
  ],
};
const cycleDisplay = validationDisplay(cycle, graphValidation(cycle));
assert.ok(cycleDisplay.nodes.a.length);
assert.ok(cycleDisplay.nodes.b.length);
assert.ok(cycleDisplay.nodes.c.length);

{
  const { placeNodes } = await import('../src/features/pipelines/pipeline-model.ts');
  const n = (id) => ({ node_id: id, kind: 'sync', ref_id: 'r', label: id, x: 0, y: 0 });
  const g = placeNodes({
    nodes: [n('c'), n('a'), n('b')],
    edges: [{ from_node: 'a', to_node: 'b' }, { from_node: 'b', to_node: 'c' }],
  });
  const at = Object.fromEntries(g.nodes.map((x) => [x.node_id, x.x]));
  if (!(at.a < at.b && at.b < at.c)) throw new Error('placeNodes must order layers left to right');
  const placed = { nodes: [{ ...n('a'), x: 5 }, n('b')], edges: [] };
  if (placeNodes(placed) !== placed) throw new Error('placeNodes must keep distinct positions');
  console.log('Pipelines: unplaced graphs get a layered layout.');
}

{
  const { flowState } = await import('../src/features/pipelines/pipeline-model.ts');
  const cases = [
    ['running', 'pending', 'flowing'],
    ['succeeded', 'running', 'flowing'],
    ['succeeded', 'succeeded', 'done'],
    ['failed', 'pending', 'blocked'],
    ['succeeded', 'skipped', 'blocked'],
    ['pending', 'pending', 'idle'],
    [undefined, undefined, 'idle'],
  ];
  for (const [from, to, want] of cases)
    if (flowState(from, to) !== want) throw new Error(`flowState(${from}, ${to}) should be ${want}`);
  console.log('Pipelines: edge flow states follow node states.');
}
