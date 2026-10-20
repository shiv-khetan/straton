import assert from 'node:assert/strict';
import {
  buildEdges,
  buildLayoutGraph,
  collectRoutes,
  layout,
  persist,
  loadPositions,
  restorePositions,
  routeEdges,
  routedEdgePath,
  tableSize,
  TABLE_HEADER_HEIGHT,
  TABLE_ROW_HEIGHT,
} from '../src/map-model.ts';
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
const { nodes, edges: laidOutEdges } = await layout(map);
assert.equal(nodes.length, 6);
for (const node of nodes) {
  assert.ok(Number.isFinite(node.position.x));
  assert.ok(Number.isFinite(node.position.y));
  if (node.parentId) {
    const parent = nodes.find((n) => n.id === node.parentId);
    assert.ok(parent);
    assert.ok(node.position.x + node.style.width <= parent.style.width);
    assert.ok(node.position.y + node.style.height <= parent.style.height);
  }
}
const groups = nodes.filter((n) => n.type === 'source');
for (const group of groups) {
  assert.ok(group.style.width >= 380 && group.style.height >= 160);
  for (const other of groups.filter((n) => n.id !== group.id)) {
    assert.ok(
      group.position.x + group.style.width <= other.position.x ||
        other.position.x + other.style.width <= group.position.x ||
        group.position.y + group.style.height <= other.position.y ||
        other.position.y + other.style.height <= group.position.y,
      'Rendered group boxes must not overlap, including empty sources',
    );
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
assert.deepEqual(await layout({ nodes: [], edges: [] }), { nodes: [], edges: [] });
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
    dataset('items', sourceId, 'order_items', ['id', 'order_id', 'product_id']),
    dataset('products', sourceId, 'products', ['id', 'name', 'price']),
    dataset('payments', sourceId, 'payments', ['id', 'order_id', 'customer_id', 'amount']),
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
    relationship('items-product-fk', 'items', ['product_id'], 'products', ['id'], 'declared_fk'),
    relationship('payments-order-fk', 'payments', ['order_id'], 'orders', ['id'], 'declared_fk'),
    {
      ...relationship(
        'payments-customer',
        'payments',
        ['customer_id'],
        'customers',
        ['id'],
        'inferred',
      ),
      confidence: 0.93,
    },
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
assert.equal(built.length, 8);
assert.match(built.at(-1).data.description, /93% confidence/);
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

// Every visible column has one port per side, ordered from header to final row.
const elkGraph = buildLayoutGraph(liveMap);
assert.equal(elkGraph.layoutOptions['elk.edgeRouting'], 'ORTHOGONAL');
assert.equal(elkGraph.layoutOptions['elk.hierarchyHandling'], 'INCLUDE_CHILDREN');
const portIds = new Set();
for (const group of elkGraph.children) {
  assert.ok(Number(group.layoutOptions['elk.spacing.nodeNode']) >= 100);
  assert.ok(Number(group.layoutOptions['elk.layered.spacing.nodeNodeBetweenLayers']) >= 160);
  for (const table of group.children) {
    const data = liveMap.nodes.find((n) => n.id === table.id);
    assert.deepEqual({ width: table.width, height: table.height }, tableSize(data));
    assert.equal(table.layoutOptions['elk.portConstraints'], 'FIXED_ORDER');
    assert.equal(table.ports.length, 2 * (data.columns.length + 1));
    for (const [side, direction] of [
      ['WEST', 'in'],
      ['EAST', 'out'],
    ]) {
      const ports = table.ports.filter((p) => p.layoutOptions['elk.port.side'] === side);
      assert.deepEqual(
        ports.map((p) => JSON.parse(p.id)[1]),
        ['dataset:' + direction, ...data.columns.map((c) => direction + ':' + c.name)],
      );
      assert.deepEqual(
        ports.map((p) => p.y + p.height / 2),
        [
          TABLE_HEADER_HEIGHT / 2,
          ...data.columns.map((_, i) => TABLE_HEADER_HEIGHT + (i + 0.5) * TABLE_ROW_HEIGHT),
        ],
      );
      assert.deepEqual(
        ports.map((p) => Number(p.layoutOptions['elk.port.index'])),
        ports.map((_, i) => (side === 'EAST' ? i : table.ports.length - 1 - i)),
      );
      ports.forEach((p) => portIds.add(p.id));
    }
  }
}
assert.deepEqual(
  elkGraph.edges.map((e) => e.id),
  built.map((e) => e.id),
);
for (const edge of elkGraph.edges) {
  assert.ok(portIds.has(edge.sources[0]));
  assert.ok(portIds.has(edge.targets[0]));
}
const longDataset = {
  ...liveMap.nodes.find((n) => n.id === 'orders'),
  display_name: 'Orders with a very long descriptive dataset title',
  columns: [
    {
      ...column('an_extremely_long_customer_reference_column_name'),
      type: 'Decimal(38, 18) with a detailed type name',
    },
  ],
};
assert.ok(tableSize(longDataset).width > 600);
assert.equal(tableSize(longDataset).height, TABLE_HEADER_HEIGHT + TABLE_ROW_HEIGHT);

// ELK can store an edge at root while its coordinates belong to a nested container.
const nested = {
  id: 'root',
  x: 999,
  y: 999,
  children: [
    {
      id: 'outer',
      x: 100,
      y: 200,
      children: [
        {
          id: 'inner',
          x: 30,
          y: 30,
          children: [
            {
              id: 'a',
              x: 50,
              y: 70,
              width: 320,
              height: 80,
              ports: [{ id: 'a:out', x: 320, y: 48, width: 0, height: 32 }],
            },
            {
              id: 'b',
              x: 400,
              y: 170,
              width: 320,
              height: 80,
              ports: [{ id: 'b:in', x: 0, y: 48, width: 0, height: 32 }],
            },
          ],
          edges: [
            {
              id: 'owned',
              sources: ['a:out'],
              targets: ['b:in'],
              sections: [
                {
                  startPoint: { x: 370, y: 134 },
                  bendPoints: [
                    { x: 386, y: 134 },
                    { x: 386, y: 234 },
                  ],
                  endPoint: { x: 400, y: 234 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  edges: [
    {
      id: 'nested',
      container: 'inner',
      sources: ['a:out'],
      targets: ['b:in'],
      sections: [
        {
          startPoint: { x: 370, y: 134 },
          bendPoints: [
            { x: 386, y: 134 },
            { x: 386, y: 234 },
          ],
          endPoint: { x: 400, y: 234 },
        },
      ],
    },
    {
      id: 'root-edge',
      container: 'root',
      sources: ['a:out'],
      targets: ['b:in'],
      sections: [{ startPoint: { x: 500, y: 364 }, endPoint: { x: 530, y: 464 } }],
    },
  ],
};
const nestedRoutes = collectRoutes(nested);
assert.deepEqual(nestedRoutes.nested, [
  [
    { x: 500, y: 364 },
    { x: 516, y: 364 },
    { x: 516, y: 464 },
    { x: 530, y: 464 },
  ],
]);
assert.deepEqual(nestedRoutes.owned, nestedRoutes.nested);
assert.deepEqual(nestedRoutes['root-edge'], [
  [
    { x: 500, y: 364 },
    { x: 530, y: 464 },
  ],
]);
const rounded = routedEdgePath(nestedRoutes.nested);
assert.equal(
  rounded.path,
  'M 500 364 L 510 364 Q 516 364 516 370 L 516 458 Q 516 464 522 464 L 530 464',
);
assert.deepEqual(rounded.label, { x: 516, y: 414 });
assert.equal(
  routedEdgePath([
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ],
  ]).path,
  'M 0 0 L 1 0 Q 2 0 2 1 L 2 2',
);
assert.equal(routedEdgePath([]).path, '');

const arranged = await layout(liveMap);
assert.equal(arranged.edges.length, built.length);
assert.ok(arranged.edges.every((e) => e.type === 'elk' && e.data.route.length));
function absolutePosition(node, nodes) {
  if (!node.parentId) return node.position;
  const parent = absolutePosition(
    nodes.find((n) => n.id === node.parentId),
    nodes,
  );
  return { x: parent.x + node.position.x, y: parent.y + node.position.y };
}
function expectedPort(id, handle) {
  const node = arranged.nodes.find((n) => n.id === id);
  const origin = absolutePosition(node, arranged.nodes);
  const column = node.data.dataset.columns.findIndex(
    (c) => handle === 'in:' + c.name || handle === 'out:' + c.name,
  );
  return {
    x: origin.x + (handle.endsWith(':out') || handle.startsWith('out:') ? node.style.width : 0),
    y:
      origin.y +
      (column < 0
        ? TABLE_HEADER_HEIGHT / 2
        : TABLE_HEADER_HEIGHT + (column + 0.5) * TABLE_ROW_HEIGHT),
  };
}
for (const edge of arranged.edges) {
  const sections = edge.data.route;
  assert.deepEqual(
    sections[0][0],
    expectedPort(edge.source, edge.sourceHandle),
    edge.id + ' source port',
  );
  assert.deepEqual(
    sections.at(-1).at(-1),
    expectedPort(edge.target, edge.targetHandle),
    edge.id + ' target port',
  );
  for (const points of sections) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      assert.ok(a.x === b.x || a.y === b.y, edge.id + ' must be orthogonal');
      for (const node of arranged.nodes.filter((n) => n.type === 'table')) {
        const p = absolutePosition(node, arranged.nodes);
        const crosses =
          a.x === b.x
            ? a.x > p.x &&
              a.x < p.x + node.style.width &&
              Math.max(a.y, b.y) > p.y &&
              Math.min(a.y, b.y) < p.y + node.style.height
            : a.y > p.y &&
              a.y < p.y + node.style.height &&
              Math.max(a.x, b.x) > p.x &&
              Math.min(a.x, b.x) < p.x + node.style.width;
        assert.equal(crosses, false, edge.id + ' must avoid table ' + node.id);
      }
    }
  }
}

const moved = arranged.nodes.map((n) =>
  n.id === 'orders' ? { ...n, position: { ...n.position, y: n.position.y + 30 } } : n,
);
for (const edge of routeEdges(arranged.edges, moved)) {
  assert.equal(
    edge.type,
    edge.source === 'orders' || edge.target === 'orders' ? 'smoothstep' : 'elk',
  );
}
const movedGroup = arranged.nodes.map((n) =>
  n.id === sourceId ? { ...n, position: { ...n.position, x: n.position.x + 40 } } : n,
);
assert.ok(routeEdges(arranged.edges, movedGroup).every((e) => e.type === 'smoothstep'));
const restored = restorePositions(arranged.nodes, {
  orders: arranged.nodes.find((n) => n.id === 'orders').position,
});
assert.equal(
  routeEdges(arranged.edges, restored).find((e) => e.data.relationshipId === 'orders-fk').type,
  'smoothstep',
  'Even a matching restored position must invalidate its old routes',
);
const savedGroup = restorePositions(arranged.nodes, {
  [sourceId]: arranged.nodes.find((n) => n.id === sourceId).position,
});
assert.ok(routeEdges(arranged.edges, savedGroup).every((e) => e.type === 'smoothstep'));
assert.ok(routeEdges(buildEdges(liveMap), arranged.nodes).every((e) => e.type === 'smoothstep'));
assert.ok(
  routeEdges(arranged.edges, arranged.nodes).every((e) => e.type === 'elk'),
  'Fresh layout restores all routes',
);
assert.equal(laidOutEdges[0].type, 'elk');
console.log(
  'Column ports, content sizing, nested absolute routes, obstacle clearance, and moved/restored route fallback checks passed.',
);
