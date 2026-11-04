import assert from 'node:assert/strict';
import {
  ResponseShapeError,
  explorerRowsShape,
  meShape,
  sqlResultShape,
  statusShape,
  tableProfileShape,
  validated,
} from '../src/lib/validate.ts';

const me = {
  user: { id: 'u1', name: 'Ana', disabled: false, created_at: 1 },
  roles: [{ id: 'r1', name: 'Readers', is_admin: false }],
  privileges: {
    admin: false,
    read: true,
    sync_admin: false,
    grants: [
      { id: 'g1', role_id: 'r1', target_kind: 'dataset', target_id: 'd1', privilege: 'read' },
    ],
  },
  future_field: 'kept',
};
assert.deepEqual(validated('/v1/me', meShape, me), me, 'valid shape passes and keeps extra fields');

const grant = me.privileges.grants[0];
const broken = [
  [meShape, { ...me, privileges: { ...me.privileges, admin: 'yes' } }, 'response.privileges.admin'],
  [
    meShape,
    { ...me, privileges: { ...me.privileges, grants: [{ ...grant, privilege: 'root' }] } },
    'response.privileges.grants[0].privilege',
  ],
  [meShape, { ...me, roles: null }, 'response.roles'],
  [
    sqlResultShape,
    { columns: [], rows: [[{ nested: 1 }]], row_count: 1, truncated_preview: false, elapsed_ms: 1 },
    'response.rows[0][0]',
  ],
  [
    sqlResultShape,
    { columns: [], rows: [], row_count: 'x', truncated_preview: false, elapsed_ms: 1 },
    'response.row_count',
  ],
  [
    explorerRowsShape,
    { columns: [{ name: 'id' }], rows: [], offset: 0, limit: 50, total: 0, total_exact: true },
    'response.columns[0].type',
  ],
  [
    tableProfileShape,
    {
      schema: 's',
      table: 't',
      rows: 1,
      columns: [
        {
          name: 'a',
          type: 'Int64',
          non_null: 1,
          nulls: 0,
          null_ratio: Infinity,
          approx_distinct: 1,
          min: 1,
          max: 1,
        },
      ],
    },
    'response.columns[0].null_ratio',
  ],
  [statusShape, [], 'response'],
];
for (const [shape, value, where] of broken) {
  assert.throws(
    () => validated('/v1/test', shape, value),
    (e) =>
      e instanceof ResponseShapeError && e.message.includes(where) && e.message.includes('/v1/test'),
    where,
  );
}
assert.deepEqual(
  validated('/v1/sql', sqlResultShape, {
    columns: [{ name: 'n', type: 'Int64' }],
    rows: [[1], [null]],
    row_count: 2,
    truncated_preview: false,
    elapsed_ms: 3,
  }).rows,
  [[1], [null]],
);
console.log('Response validation: ' + (broken.length + 2) + ' engine response shapes checked.');
