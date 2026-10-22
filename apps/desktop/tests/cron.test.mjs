import assert from 'node:assert/strict';
import { nextCron } from '../src/features/schedules/cron-model.ts';
const next = (expr, after) => nextCron(expr, new Date(after))?.toISOString() ?? null;
assert.equal(next('0 */15 * * * *', '2026-10-22T10:15:00Z'), '2026-10-22T10:30:00.000Z');
assert.equal(next('* * * * * *', '2026-10-22T10:15:00.001Z'), '2026-10-22T10:15:01.000Z');
assert.equal(next('5/20 * * * * *', '2026-10-22T10:15:25Z'), '2026-10-22T10:15:45.000Z');
assert.equal(next('0 0 0 * * 1', '2026-10-22T00:00:00Z'), '2026-10-25T00:00:00.000Z');
assert.equal(next('0 0 0 ? * Mon-Fri', '2026-10-23T01:00:00Z'), '2026-10-26T00:00:00.000Z');
assert.equal(next('0 0 0 29 February *', '2026-10-22T00:00:00Z'), '2028-02-29T00:00:00.000Z');
assert.equal(next('0 0 0 31 2 *', '2026-01-01T00:00:00Z'), null);
assert.equal(next('0 0 0 1 1 * 2025', '2026-10-22T00:00:00Z'), null);
assert.equal(next('0 0 0 1 January * 2030', '2026-10-22T00:00:00Z'), '2030-01-01T00:00:00.000Z');
assert.equal(next('0 0 0 13 * Friday', '2026-10-22T00:00:00Z'), '2026-11-13T00:00:00.000Z');
assert.equal(next('10,40 1-3 23 * * *', '2026-10-22T23:03:40Z'), '2026-10-23T23:01:10.000Z');
assert.equal(next('@hourly', '2026-10-22T23:59:59Z'), '2026-10-23T00:00:00.000Z');
assert.equal(next('@weekly', '2026-10-22T23:59:59Z'), '2026-10-25T00:00:00.000Z');
assert.equal(next('@yearly', '2026-10-22T23:59:59Z'), '2027-01-01T00:00:00.000Z');
assert.equal(next('@monthly', '2026-10-22T23:59:59Z'), '2026-11-01T00:00:00.000Z');
assert.equal(next('@daily', '2026-10-22T23:59:59Z'), '2026-10-23T00:00:00.000Z');
for (const expression of [
  '* * * * *',
  '*/0 * * * * *',
  '*/61 * * * * *',
  '0 0 25 * * *',
  '0 0 0 * * 0',
  '0 0 0 * * 8',
  '? 0 0 * * *',
  '0 0 0 * * BEAR',
  '0 0 0 * * * 2101',
  '0 0 0 * * * * extra',
  '0 0 0 5-2 * *',
  '0/ * * * * *',
])
  assert.throws(() => nextCron(expression), undefined, expression);
assert.throws(() => nextCron('* * * * * *', new Date('invalid')));
assert.equal(next('* * * * * *', '2100-12-31T23:59:59Z'), null);
console.log(
  'Cron: UTC seconds, steps, lists, names, day intersection, leap years, aliases and invalid inputs.',
);

assert.equal(next('0 0 0 ? * MON - FRI', '2026-10-23T01:00:00Z'), '2026-10-26T00:00:00.000Z');
assert.throws(() => nextCron('0 0 0 ? * MON/2'));
assert.throws(() => nextCron('0 0 0 ? * MON-5'));
