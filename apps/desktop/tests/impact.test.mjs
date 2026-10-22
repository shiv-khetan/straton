import assert from 'node:assert/strict';
import { impactPaths } from '../src/features/lineage/impact-model.ts';
const graph = {
  root: 'b',
  nodes: ['a', 'b', 'c', 'd', 'sibling'].map((id) => ({
    id,
    kind: 'dataset',
    name: id,
    status: 'ready',
  })),
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'a', to: 'sibling' },
    { from: 'd', to: 'c' },
  ],
  summary: {},
};
assert.deepEqual([...impactPaths(graph, 'b', 'upstream').nodes], ['b', 'a']);
assert.deepEqual([...impactPaths(graph, 'b', 'downstream').nodes], ['b', 'c', 'd']);
const both = impactPaths(graph, 'b', 'both');
assert.deepEqual(new Set(both.nodes), new Set(['a', 'b', 'c', 'd']));
assert.ok(!both.edges.has(3));
assert.deepEqual([...impactPaths(graph, 'b', 'downstream', 1).nodes], ['b', 'c']);
assert.deepEqual([...impactPaths(graph, 'b', 'both', 0).nodes], ['b']);
assert.equal(impactPaths(graph, 'missing', 'both').nodes.size, 0);
assert.equal(
  impactPaths({ ...graph, edges: [...graph.edges, { from: 'c', to: 'b' }] }, 'b', 'both').nodes
    .size,
  4,
);
assert.deepEqual([...impactPaths(graph, 'sibling', 'downstream').edges], []);
console.log('Impact: upstream/downstream paths, cycle safety, depth and sibling exclusion.');
