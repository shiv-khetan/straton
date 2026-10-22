import assert from 'node:assert/strict';
import { groupActivity } from '../src/features/activity/activity-model.ts';
const at = Date.parse('2026-10-22T00:00:00Z') / 1000;
const entry = (id, time) => ({
  id,
  at: time,
  action: 'pipeline.created',
  entity_id: 'p',
  actor_id: null,
  actor_name: null,
  summary: 'pipeline created',
});
const entries = [entry(2, at), entry(1, at - 1), entry(3, at + 1), entry(2, at)];
const grouped = groupActivity(entries);
assert.deepEqual(
  grouped.map((g) => g.day),
  ['2026-10-22', '2026-10-21'],
);
assert.deepEqual(
  grouped[0].items.map((e) => e.id),
  [3, 2],
);
assert.deepEqual(
  grouped[1].items.map((e) => e.id),
  [1],
);
assert.deepEqual(
  entries.map((e) => e.id),
  [2, 1, 3, 2],
);
assert.deepEqual(groupActivity([]), []);
console.log('Activity: stable newest-first UTC grouping and duplicate paging boundaries.');
