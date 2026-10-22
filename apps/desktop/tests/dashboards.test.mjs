import assert from 'node:assert/strict';
import { packLayout, reorderLayout } from '../src/features/dashboards/layout-model.ts';
import { chartRows } from '../src/features/analytics/chart-model.ts';
const tiles = [
  { chart_id: 'a', x: 0, y: 0, w: 6, h: 4 },
  { chart_id: 'b', x: 6, y: 0, w: 6, h: 3 },
  { chart_id: 'c', x: 0, y: 4, w: 12, h: 4 },
];
assert.deepEqual(packLayout(tiles), tiles);
const moved = reorderLayout(tiles, 'c', -1);
assert.deepEqual(
  moved.map((t) => t.chart_id),
  ['a', 'c', 'b'],
);
assert.deepEqual(
  moved.map(({ x, y }) => ({ x, y })),
  [
    { x: 0, y: 0 },
    { x: 0, y: 4 },
    { x: 0, y: 8 },
  ],
);
assert.deepEqual(
  tiles.map((t) => t.chart_id),
  ['a', 'b', 'c'],
);
assert.equal(reorderLayout(tiles, 'a', -1), tiles);
assert.equal(reorderLayout(tiles, 'c', 1), tiles);
assert.equal(reorderLayout(tiles, 'unknown', 1), tiles);
const thirds = packLayout(tiles.map((t) => ({ ...t, w: 4 })));
assert.deepEqual(
  thirds.map((t) => t.x),
  [0, 4, 8],
);
assert.equal(thirds[2].y, 0);
assert.equal(packLayout([{ ...tiles[0], w: 99, h: 0 }])[0].w, 12);
assert.equal(packLayout([{ ...tiles[0], w: 0, h: 0 }])[0].h, 1);
assert.deepEqual(packLayout([]), []);
const data = {
  columns: [
    { name: 'day', type: 'Utf8' },
    { name: 'region', type: 'Utf8' },
    { name: 'value', type: 'Int64' },
  ],
  rows: [
    ['Mon', 'East', 3],
    ['Mon', 'West', 4],
    ['Tue', 'East', 5],
  ],
};
assert.deepEqual(chartRows(data, { x: 'day', y: ['value'], series: 'region' }), {
  keys: ['value · East', 'value · West'],
  rows: [
    { _x: 'Mon', 'value · East': 3, 'value · West': 4 },
    { _x: 'Tue', 'value · East': 5 },
  ],
});
assert.deepEqual(
  chartRows({ columns: data.columns, rows: [[null, 'East', null]] }, { x: 'day', y: ['value'] }),
  { keys: ['value'], rows: [{ _x: null, value: null }] },
);
console.log('Dashboards: immutable reorder, row packing, widths, heights, and series mappings.');

const repeated = chartRows(
  {
    columns: [
      { name: 'x', type: 'Utf8' },
      { name: 'amount', type: 'Decimal128' },
    ],
    rows: [
      ['same', '12.50'],
      ['same', 14],
    ],
  },
  { x: 'x', y: ['amount'] },
);
assert.deepEqual(repeated.rows, [
  { _x: 'same', amount: 12.5 },
  { _x: 'same', amount: 14 },
]);
