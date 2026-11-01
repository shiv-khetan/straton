import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cn, fontSizeTokens } from '../src/lib/utils.ts';
import { sourceHealth, lastSourceRun } from '../src/features/connections/source-health.ts';

// tailwind-merge must know the theme's font-size tokens, or it treats them as colours and
// silently drops the text colour they are combined with.
assert.equal(cn('text-ink-2', 'text-caption'), 'text-ink-2 text-caption');
assert.equal(cn('text-sm text-ink-2', 'text-body'), 'text-ink-2 text-body');
assert.equal(cn('text-caption', 'text-page'), 'text-page');
const tokens = readFileSync(new URL('../src/styles/tailwind.css', import.meta.url), 'utf8');
for (const size of [...tokens.matchAll(/^\s*--text-([a-z0-9-]+):/gm)].map((m) => m[1]))
  if (!['xs', 'sm', 'base', 'lg', 'xl'].includes(size))
    assert.ok(fontSizeTokens.includes(size), 'register --text-' + size + ' with tailwind-merge');

// One health rule shared by Overview and Connections.
const jobs = [
  { id: 'j1', source_id: 's1' },
  { id: 'j2', source_id: 's2' },
];
const run = (job_id, state, available_at) => ({
  id: job_id + available_at,
  job_id,
  state,
  available_at,
});
const runs = [
  run('j1', 'failed', 1),
  run('j1', 'succeeded', 2),
  run('j2', 'failed', 3),
  run('j1', 'running', 9),
];
assert.equal(lastSourceRun('s1', jobs, runs).available_at, 2, 'running runs are not finished');
assert.equal(sourceHealth('s1', jobs, runs, []), 'Healthy');
assert.equal(sourceHealth('s2', jobs, runs, []), 'Failing');
assert.equal(sourceHealth('s3', jobs, runs, []), 'Never synced');
assert.equal(sourceHealth('s3', jobs, runs, [{ source_id: 's3', last_synced_at: 'x' }]), 'Healthy');
assert.equal(sourceHealth('s1', jobs, runs, [], { ok: false }), 'Failing');
assert.equal(sourceHealth('s3', jobs, runs, [], { ok: true }), 'Healthy');

// The header row above the title is always rendered, so titles never jump between pages.
const header = readFileSync(new URL('../src/app/PageHeader.tsx', import.meta.url), 'utf8');
assert.match(header, /page-header-meta/);
const shell = readFileSync(new URL('../src/app/styles.css', import.meta.url), 'utf8');
assert.match(shell, /\.page-tabs \{[^}]*bg-surface/, 'tab bar shares the header surface');
// Monaco themes must resolve light-dark() tokens through the DOM, not a raw canvas fillStyle.
const monaco = readFileSync(new URL('../src/features/sql/monaco.ts', import.meta.url), 'utf8');
assert.match(monaco, /getComputedStyle\(probe\)\.color/);
import { canPage } from '../src/features/access/access-model.ts';
// Settings opens for any signed-in user (desktop preferences); engine settings stay admin-only.
assert.equal(canPage(null, 'Settings'), false);
const reader = {
  user: { id: 'u', name: 'u' },
  roles: [],
  privileges: { admin: false, read: false, sync_admin: false, grants: [] },
};
assert.equal(canPage(reader, 'Settings'), true);
const settings = readFileSync(
  new URL('../src/features/settings/Settings.tsx', import.meta.url),
  'utf8',
);
assert.match(
  settings,
  /enabled: !!client && admin/,
  'engine settings are only requested by admins',
);
console.log(
  'UI shell: class merging keeps colours, shared source health, stable header row, editor theme tokens.',
);

// Every API client method is classified exactly once for the query cache.
const { api } = await import('../src/lib/api.ts');
const { reads, transient, mutations } = await import('../src/lib/queryApi.ts');
const methods = Object.keys(api({ url: 'http://127.0.0.1:1', token: 't' }));
for (const method of methods) {
  const kinds = [method in reads, transient.has(method), mutations.has(method)].filter(Boolean);
  assert.equal(kinds.length, 1, method + ' must be exactly one of reads, transient, mutations');
}
for (const listed of [...Object.keys(reads), ...transient, ...mutations])
  assert.ok(methods.includes(listed), listed + ' is not an API client method');
assert.ok('engineSettings' in reads && transient.has('explorerProfile'));
console.log('Query cache: every client method is a read, transient call or mutation.');

const { describeCron, nextCron } = await import('../src/features/schedules/cron-model.ts');
for (const [cron, text] of [
  ['0 */15 * * * *', 'Every 15 minutes'],
  ['0 0 * * * *', 'Hourly'],
  ['@hourly', 'Hourly'],
  ['0 30 * * * *', 'Hourly at :30'],
  ['0 0 */6 * * *', 'Every 6 hours'],
  ['0 0 2 * * *', 'Daily at 02:00 UTC'],
  ['0 30 9 * * MON-FRI', 'Weekdays at 09:30 UTC'],
  ['0 30 9 * * 2-6', 'Weekdays at 09:30 UTC'],
  // The engine numbers Sunday as 1: "1-5" is Sunday to Thursday, not weekdays.
  ['0 30 9 * * 1-5', 'Sun, Mon, Tue, Wed, Thu at 09:30 UTC'],
  ['0 0 0 * * 1', 'Weekly on Sunday at 00:00 UTC'],
  ['0 0 0 1 * *', 'Monthly on day 1 at 00:00 UTC'],
  ['*/30 * * * * *', 'Every 30 seconds'],
  ['0 * * * * *', 'Every minute'],
  ['0 0 9 * 1 *', null],
  ['0 0 9 13 * 6', null],
  ['not cron', null],
]) {
  assert.equal(describeCron(cron), text, cron);
  if (text) assert.ok(nextCron(cron, new Date(Date.UTC(2026, 0, 1))), cron + ' is valid');
}
console.log('Cron: schedules are described in words using the engine dialect, or left as code.');

const { failingJobs } = await import('../src/features/overview/attention-model.ts');
const r = (job_id, state, available_at) => ({
  id: job_id + available_at,
  job_id,
  state,
  available_at,
});
const attention = failingJobs([
  r('a', 'failed', 3),
  r('a', 'failed', 2),
  r('a', 'succeeded', 1), // failing twice in a row
  r('b', 'failed', 1),
  r('b', 'succeeded', 5), // recovered: not listed
  r('c', 'failed', 4),
  r('c', 'running', 9), // running run is not finished
]);
assert.deepEqual(
  attention.map((x) => [x.run.job_id, x.streak]),
  [
    ['c', 1],
    ['a', 2],
  ],
);
console.log('Needs attention: one entry per still-failing job, with its failure streak.');
