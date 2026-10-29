import assert from 'node:assert/strict';
import test from 'node:test';
import { chartRows } from '../src/features/analytics/chart-model.ts';
import {
  clearDraft,
  draftKey,
  readDraft,
  writeDraft,
  snapshotSave,
  installExitGuard,
} from '../src/features/analytics/draft-store.ts';
import { dirtyPredicates, savePredicate } from '../src/features/access/predicate-model.ts';
import { checkPage } from '../src/features/quality/pagination.ts';
import { manualSelection, relationshipInput } from '../src/features/lineage/relationship-form.ts';
import { addDashboardChart } from '../src/features/dashboards/layout-model.ts';

test('duplicate X and series coordinates reject pivoting without dropping values', () => {
  const columns = [{ name: 'x' }, { name: 'series' }, { name: 'value' }];
  const config = { x: 'x', series: 'series', y: ['value'] };
  const result = chartRows(
    {
      columns,
      rows: [
        ['Mon', 'A', 2],
        ['Mon', 'A', 3],
      ],
    },
    config,
  );
  assert.equal(
    result.error,
    'Multiple rows share an X and series value. Aggregate them in SQL or choose a unique X column.',
  );
  assert.deepEqual(result.rows, []);
  assert.equal(
    chartRows(
      {
        columns,
        rows: [
          [null, 'A', 2],
          [null, 'A', 3],
        ],
      },
      config,
    ).error,
    result.error,
  );
  const unique = chartRows(
    {
      columns,
      rows: [
        ['Mon', 'A', 2],
        ['Mon', 'B', 3],
        ['Tue', 'A', 4],
      ],
    },
    config,
  );
  assert.equal(unique.error, undefined);
  assert.deepEqual(unique.rows, [
    { _x: 'Mon', 'value · A': 2, 'value · B': 3 },
    { _x: 'Tue', 'value · A': 4 },
  ]);
  assert.equal(
    chartRows(
      {
        columns,
        rows: [
          ['Mon', 'A', 2],
          ['Mon', 'A', 3],
        ],
      },
      { x: 'x', y: ['value'] },
    ).rows.length,
    2,
  );
  assert.equal(
    chartRows(
      {
        columns,
        rows: [
          ['Mon', 'A', 2],
          ['Mon', 'A', 3],
        ],
      },
      { series: 'series', y: ['value'] },
    ).error,
    undefined,
  );
});

test('saving and removing one predicate retain unrelated dirty drafts and masks', () => {
  const policies = {
    row_filters: [
      { role_id: 'a', predicate: 'old a' },
      { role_id: 'b', predicate: 'old b' },
    ],
    masks: [{ role_id: 'b', column: 'secret', kind: 'hash' }],
  };
  const drafts = { a: 'new a', b: 'new b' };
  assert.equal(dirtyPredicates(policies, drafts), true);
  const saved = savePredicate(policies, 'a', drafts.a);
  assert.equal(dirtyPredicates(saved, drafts), true);
  assert.deepEqual(saved.row_filters, [
    { role_id: 'b', predicate: 'old b' },
    { role_id: 'a', predicate: 'new a' },
  ]);
  assert.deepEqual(saved.masks, policies.masks);
  assert.equal(policies.row_filters[0].predicate, 'old a');
  assert.deepEqual(savePredicate(saved, 'a', null).row_filters, [
    { role_id: 'b', predicate: 'old b' },
  ]);
  assert.equal(dirtyPredicates(savePredicate(saved, 'b', 'new b'), drafts), false);
  assert.equal(dirtyPredicates({ row_filters: [], masks: [] }, { a: '' }), false);
});

test('drafts are isolated by engine, user, feature and entity, with immutable save snapshots', () => {
  const key = draftKey('engine-a|user-a', 'chart', 'new');
  const value = { name: 'Working chart', config: { y: ['value'] } };
  writeDraft(key, value);
  value.config.y.push('other');
  assert.deepEqual(readDraft(key).config.y, ['value']);
  const restored = readDraft(key);
  restored.name = 'mutated copy';
  assert.equal(readDraft(key).name, 'Working chart');
  for (const other of [
    draftKey('engine-b|user-a', 'chart', 'new'),
    draftKey('engine-a|user-b', 'chart', 'new'),
    draftKey('engine-a|user-a', 'dashboard', 'new'),
    draftKey('engine-a|user-a', 'chart', 'existing'),
  ])
    assert.equal(readDraft(other), undefined);
  const snapshot = snapshotSave('original-id', value);
  value.name = 'later edit';
  value.config.y.push('later');
  assert.equal(snapshot.target, 'original-id');
  assert.equal(snapshot.value.name, 'Working chart');
  assert.deepEqual(snapshot.value.config.y, ['value', 'other']);
  clearDraft(key);
  assert.equal(readDraft(key), undefined);
});

test('dirty navigation restores the complete history and replays only an approved exit', () => {
  let state = { page: 'Analytics', entries: ['Dashboard', 'Analytics'], index: 1 };
  const listeners = new Set();
  const store = {
    getState: () => state,
    setState: (next) => {
      const previous = state;
      state = next;
      for (const listener of listeners) listener(next, previous);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let dirty = true;
  let leave;
  const guard = installExitGuard(
    store,
    () => dirty,
    (next) => {
      leave = next;
    },
  );
  const original = state;
  const destination = { page: 'Dashboards', entries: [...state.entries, 'Dashboards'], index: 2 };
  store.setState(destination);
  assert.equal(state, original);
  // Keep editing makes no navigation change.
  assert.equal(state.page, 'Analytics');
  leave();
  assert.equal(state, destination);
  guard.allow(() => store.setState(original));
  assert.equal(state, original);
  dirty = false;
  store.setState(destination);
  assert.equal(state, destination);
  dirty = true;
  store.setState({ page: 'Connect', entries: ['Connect'], index: 0 });
  assert.equal(state.page, 'Connect');
  guard.unsubscribe();
  assert.equal(listeners.size, 0);
});

test('dashboard continuation restores the draft and adds the created chart exactly once', () => {
  const key = draftKey('engine|user', 'dashboard', 'new');
  const continuationKey = draftKey('engine|user', 'dashboard-continuation');
  const draft = { name: 'Unsaved dashboard', description: 'Keep this', layout: [], shared: false };
  writeDraft(key, draft);
  writeDraft(continuationKey, { dashboardId: 'new' });
  writeDraft(continuationKey, { ...readDraft(continuationKey), chartId: 'created' });
  const result = addDashboardChart(readDraft(key), readDraft(continuationKey).chartId);
  assert.equal(result.name, draft.name);
  assert.equal(result.description, draft.description);
  assert.deepEqual(result.layout, [{ chart_id: 'created', x: 0, y: 0, w: 6, h: 4 }]);
  assert.equal(addDashboardChart(result, 'created'), result);
  assert.deepEqual(draft.layout, []);
  clearDraft(key);
  clearDraft(continuationKey);
});

test('quality pagination bounds history mounts and clamps after deletion', () => {
  const checks = Array.from({ length: 61 }, (_, id) => ({ id }));
  assert.equal(checkPage(checks, 0).rows.length, 25);
  assert.deepEqual(
    checkPage(checks, 1).rows.map((c) => c.id),
    Array.from({ length: 25 }, (_, i) => i + 25),
  );
  assert.deepEqual(checkPage(checks, 99), { page: 2, pages: 3, rows: checks.slice(50) });
  assert.equal(checkPage(checks.slice(0, 10), 2).page, 0);
  assert.deepEqual(checkPage([], 5), { page: 0, pages: 1, rows: [] });
});

test('keyboard relationships validate columns and deletion includes only selected manual edges', () => {
  const datasets = [
    { id: 'a', columns: [{ name: 'id' }] },
    { id: 'b', columns: [{ name: 'a_id' }] },
  ];
  const relationship = relationshipInput(datasets, 'a', 'id', 'b', 'a_id');
  assert.deepEqual(relationship, {
    from_dataset: 'a',
    from_cols: ['id'],
    to_dataset: 'b',
    to_cols: ['a_id'],
    kind: 'manual',
    confidence: null,
  });
  assert.throws(() => relationshipInput(datasets, 'a', 'missing', 'b', 'a_id'), /available/);
  assert.throws(() => relationshipInput(datasets, 'missing', 'id', 'b', 'a_id'), /available/);
  assert.throws(() => relationshipInput(datasets, 'a', 'id', 'a', 'id'), /different/);
  const edges = [
    { ...relationship, id: 'manual' },
    { ...relationship, id: 'other' },
    { ...relationship, id: 'inferred', kind: 'inferred' },
  ];
  assert.deepEqual(manualSelection(edges, ['manual', 'manual', 'inferred']), [edges[0]]);
  assert.deepEqual(manualSelection(edges, []), []);
});
