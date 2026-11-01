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

const { cronFeedback, cronPresets } = await import('../src/features/schedules/cron-model.ts');
const t0 = new Date(Date.UTC(2026, 10, 1, 10, 7, 30));
assert.deepEqual(cronFeedback('0 */15 * * * *', t0), {
  ok: true,
  text: 'Every 15 minutes · next run 2026-11-01 10:15 UTC',
});
assert.equal(cronFeedback('', t0), null);
assert.equal(cronFeedback('* * *', t0).ok, false);
assert.equal(cronFeedback('0 0 0 1 1 * 2020', t0).text, 'This schedule never runs again.');
for (const p of cronPresets.filter((x) => x.cron))
  assert.equal(cronFeedback(p.cron, t0).ok, true, p.label);
console.log('Cron field: presets are valid; feedback gives words and next run, or the reason.');

// The window never scrolls: html/body are locked and the page scroller is a positioning
// context, so absolutely positioned helpers (sr-only status text) cannot grow the document.
const globalCss = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
assert.match(globalCss, /html,\s*body\s*\{[^}]*overflow:\s*hidden/);
assert.match(shell, /\.page-content \{[^}]*relative/);
console.log('Frame: window is locked; only page content scrolls.');

const { lastJobRun } = await import('../src/features/overview/attention-model.ts');
const rr = (state, at) => ({ id: state + at, job_id: 'j', state, available_at: at });
assert.equal(lastJobRun('j', []), null);
assert.deepEqual(lastJobRun('j', [rr('failed', 3), rr('failed', 2), rr('succeeded', 1)]).streak, 2);
assert.equal(lastJobRun('j', [rr('succeeded', 3), rr('failed', 2)]).streak, 0);
assert.equal(lastJobRun('j', [rr('running', 9), rr('succeeded', 3)]).run.state, 'succeeded');
console.log('Jobs: last run and failure streak per job.');

const { normalizeCron } = await import('../src/features/schedules/cron-model.ts');
assert.equal(normalizeCron('*/5 * * * *'), '0 */5 * * * *');
assert.equal(normalizeCron('30 9 * * 1-5'), '0 30 9 * * 2-6', 'Mon-Fri in Unix cron is 2-6 here');
assert.equal(normalizeCron('0 0 * * 0'), '0 0 0 * * 1', 'Sunday 0 becomes 1');
assert.equal(normalizeCron('0 0 * * 7'), '0 0 0 * * 1', 'Sunday 7 becomes 1');
assert.equal(normalizeCron('0 0 * * MON-FRI'), '0 0 0 * * MON-FRI');
assert.equal(normalizeCron('0 0 * * 5-7'), null, 'ranges wrapping past Sunday are not guessed');
assert.equal(normalizeCron('0 */5 * * * *'), null, 'six fields are left alone');
assert.equal(normalizeCron('61 * * * *'), null);
assert.equal(cronPresets[0].cron, '');
console.log('Cron: 5-field input converts to the engine dialect; Manual preset clears.');

const { explainSqlError } = await import('../src/features/sql/sql-error.ts');
const cat = [
  { schema: 'shop_db', name: 'orders', columns: [{ name: 'amount' }, { name: 'status' }] },
  { schema: 'shop_db', name: 'customers', columns: [] },
];
let v = explainSqlError("Error during planning: table 'datafusion.shop_db.orderz' not found", cat);
assert.equal(v.title, "Table shop_db.orderz doesn't exist");
assert.equal(v.hint, 'Did you mean shop_db.orders?');
assert.ok(!v.detail.includes('datafusion.'));
v = explainSqlError('Schema error: No field named amout. Valid fields are orders.amount', cat);
assert.equal(v.title, "Column amout doesn't exist");
assert.equal(v.hint, 'Did you mean amount?');
assert.equal(
  explainSqlError("table 'x.zzzzzz' not found", cat).hint,
  'Check the Catalog panel for available tables.',
);
assert.equal(explainSqlError('something odd').title, 'The query failed');
console.log('SQL errors: headline, closest-name suggestion, engine prefix removed.');

// Feature code uses the themed Checkbox, never a browser-default one.
{
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) =>
      statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)],
    );
  const root = new URL('../src/features', import.meta.url).pathname;
  const offenders = walk(root).filter(
    (f) => f.endsWith('.tsx') && readFileSync(f, 'utf8').includes('type="checkbox"'),
  );
  assert.deepEqual(offenders, [], 'use components/ui/checkbox');
  console.log('Controls: no native checkboxes in features.');
}

const { activityText, entityNames } = await import('../src/features/activity/activity-model.ts');
assert.equal(activityText('run.running', 'run running'), 'Run started');
assert.equal(activityText('quality.run', 'quality run: failed'), 'Quality run: failed');
const names = entityNames({
  runs: [{ id: 'r1', job_id: 'j1' }],
  jobs: [{ id: 'j1', name: 'Sync orders' }],
  sources: [],
  datasets: [{ id: 'd', name: 'x/orders', display_name: 'Shop DB.orders' }],
  models: [],
});
assert.equal(names.r1, 'Sync orders');
assert.equal(names.d, 'Shop DB.orders');
console.log('Activity: readable actions and entity names instead of ids.');
