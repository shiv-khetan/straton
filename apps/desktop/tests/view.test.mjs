import assert from 'node:assert/strict';
import { datasetLabel, relativeTime, backupTime, bucketRuns, isLoopback, matrixLayout, matrixCells, navigateBucket, bucketTooltip, timestampSeries, runSparkline, runKpi, axisLabelShown } from '../src/view-model.ts';
const now = Date.UTC(2026, 9, 20, 12);
assert.equal(relativeTime(null, now), 'Never');
assert.equal(relativeTime('bad', now), 'Unknown');
assert.equal(relativeTime(now + 1000, now), 'Just now');
assert.equal(relativeTime(now - 60_000, now), '1 min ago');
assert.equal(relativeTime(now - 7_200_000, now), '2 h ago');
assert.equal(relativeTime(now - 172_800_000, now), '2 d ago');
assert.equal(backupTime('C:\\data\\straton-20261020T100000123456789Z-id.db'), '2026-10-20T10:00:00Z');
assert.equal(backupTime('/data/straton-20261020T100000Z-id.db'), '2026-10-20T10:00:00Z');
assert.equal(backupTime('unknown.db'), null);
assert.equal(isLoopback('http://127.0.0.1:8787'), true);
assert.equal(isLoopback('https://[::1]'), true);
assert.equal(isLoopback('https://localhost.example.com'), false);
const date = new Date(now); date.setHours(0,0,0,0);
const start = date.getTime();
const make = (state, ms) => ({ state, available_at: ms/1000 });
const days = bucketRuns([make('succeeded',start),make('failed',now),make('cancelled',now-1000),make('running',now),make('succeeded',now+1),make('failed',start-8*86400000)],now);
assert.equal(days.length,7);
assert.deepEqual([days.at(-1).succeeded,days.at(-1).failed,days.at(-1).cancelled],[1,1,1]);
assert.equal(days.reduce((sum,d)=>sum+d.succeeded+d.failed+d.cancelled,0),3);
assert.equal(bucketRuns([],now).every(d=>d.succeeded+d.failed+d.cancelled===0),true);
assert.equal(days.at(-1).running,1);
const allStates = ['succeeded','running','queued','failed','interrupted','cancelled'];
const everyState = bucketRuns(allStates.map(state=>make(state,now)),now).at(-1);
for(const state of allStates) assert.equal(everyState[state],1);
console.log('Relative times, backup filenames, loopback detection and chart boundaries passed.');

// Check the light default, dark toggle, status chips, and UI marks.
const { readFile } = await import('node:fs/promises');
const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
const declarations = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const light = declarations(css.match(/:root\s*\{([^}]+)\}/)[1]);
const dark = { ...light, ...declarations(css.match(/\[data-theme=['"]dark['"]\]\s*\{([^}]+)\}/)[1]) };
const blend = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1-alpha));
function resolve(palette, name) {
  const value = palette[name];
  assert.ok(value, 'Missing token ' + name);
  if (/^#[\da-f]{6}$/i.test(value)) return value.slice(1).match(/../g).map(c => parseInt(c,16));
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias) return resolve(palette, alias[1]);
  const mix = value.match(/^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\)$/);
  if (mix) return blend(resolve(palette,mix[1]),resolve(palette,mix[3]),Number(mix[2])/100);
  throw new Error('Unsupported color: ' + value);
}
function luminance(rgb) { const [r,g,b] = rgb.map(c => c/255).map(c => c<=.04045 ? c/12.92 : ((c+.055)/1.055)**2.4); return .2126*r+.7152*g+.0722*b; }
function contrast(a,b) { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
let pairs = 0;
const surfaces = ['bg','bg-deep','panel','surface','surface-2','surface-3'];
for (const [theme,palette] of [['dark',dark],['light',light]]) {
  const check = (text, background, minimum = 4.5, label = background) => {
    const ratio = contrast(resolve(palette,'--'+text),Array.isArray(background) ? background : resolve(palette,'--'+background));
    assert.ok(ratio>=minimum, theme+': '+text+' on '+label+' = '+ratio.toFixed(3)+' (needs '+minimum+')'); pairs++;
  };
  for (const bg of surfaces) {
    check('ink', bg); check('ink-2', bg);
    // Pressed dark controls use ink/ink-2; tertiary captions remain on unpressed surfaces.
    if (theme === 'light' || bg !== 'surface-3') check('ink-3', bg);
    check('mark', bg, 3);
    check('primary',bg); check('running',bg,3); check('success',bg,3); check('warning',bg,3); check('danger',bg,3);
  }
  check('on-primary','primary');check('on-primary-hover','primary-hover');
  for(const [text,bg] of [['primary','primary-50'],['primary','surface-2'],['success-ink','success-50'],['warning-ink','warning-50'],['danger-ink','danger-50'],['info-ink','info-50']]) check(text,bg);
  if (theme === 'light') check('primary', 'primary-tint');
  for(const color of ['running','success','warning','danger']) {
    const tint = palette['--'+color+'-tint'].match(/^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/);
    assert.ok(tint, 'Expected an alpha tint for '+color);
    const fg = tint.slice(1,4).map(Number), alpha = Number(tint[4])/100;
    for(const bg of ['bg','bg-deep','panel','surface','surface-2']) {
      const band = blend(fg,resolve(palette,'--'+bg),alpha);
      const text = color === 'running' ? 'info-ink' : color === 'primary' ? 'primary' : color+'-ink';
      check(text,band,4.5,color+'-tint on '+bg);
      check('ink',band,4.5,color+' header on '+bg);
      check('ink-2',band,4.5,color+' secondary on '+bg);
    }
  }
  for(const text of ['info-ink','success-ink','warning-ink','danger-ink']) for(const bg of surfaces) check(text,bg);
}
assert.equal(dark['--ink-3'], '#908fa0');
assert.equal(dark['--bg'],'#0b1326');assert.equal(dark['--primary'],'#c0c1ff');
assert.equal(light['--primary'],'#1d50a2');assert.equal(light['--running'],'#1d50a2');
assert.equal(light['--success'],'#0f8a63');assert.equal(light['--danger'],'#c0392b');
assert.equal(light['--bg'], '#ffffff'); assert.equal(light['--panel'], '#eef3fb');
assert.equal(light['--ink'], '#0b0f17'); assert.equal(light['--mark'], '#111827');
assert.equal(light['--ink-2'], '#4a5568'); assert.equal(light['--ink-3'], '#5f6b7e');
console.log('Soft Workbench v3 contrast passed: '+pairs+' text/background and UI pairs across both themes.');

// Local lake keeps its source-qualified storage key but presents a friendly name.
const lakeDataset = {
  type: 'dataset',
  id: 'lake-customers',
  source_id: 'straton-local-lake',
  name: '3562a8e7-f19a-436b-831b-341543010d09/customers',
  display_name: 'customers',
  stale: false,
  row_count: 12,
  last_synced_at: null,
  sql_schema: 'lake',
  sql_table: 'customers',
  columns: [{ name: 'id', type: 'Int64', nullable: false, pk: true }],
};
assert.equal(datasetLabel(lakeDataset), 'customers');
assert.equal(datasetLabel({ ...lakeDataset, display_name: undefined }), lakeDataset.name);
assert.equal(datasetLabel({ ...lakeDataset, display_name: null }), lakeDataset.name);
assert.equal(datasetLabel({ ...lakeDataset, display_name: '' }), '');
assert.equal(datasetLabel(undefined), '');
console.log('Lake dataset labels prefer display_name and preserve the nullish name fallback.');

// Local calendar buckets exclude future and out-of-range runs for both ranges.
const monthly = bucketRuns([make('failed', now), make('queued', now - 20 * 86400000), make('succeeded', now + 1), make('failed', now - 31 * 86400000)], now, 30);
assert.equal(monthly.length, 30);
assert.equal(monthly.reduce((n, bucket) => n + bucket.failed + bucket.queued + bucket.succeeded, 0), 2);
assert.equal(monthly.at(-1).end, bucketRuns([], now).at(-1).end);
const matrixBucket = { ...everyState, succeeded: 19, failed: 5 };
const layout = matrixLayout([matrixBucket]);
assert.equal(layout.unit, 2);
const cells = matrixCells(matrixBucket, layout.unit, layout.rows);
assert.equal(cells.filter(state => state === 'succeeded').length, 10);
assert.equal(cells.filter(state => state === 'failed').length, 3);
assert.equal(cells.length, layout.rows);
assert.ok(cells.includes('cancelled'));
const emptyLayout = matrixLayout(bucketRuns([], now));
assert.deepEqual(emptyLayout, { unit: 1, rows: 12 });
assert.deepEqual(matrixCells(bucketRuns([], now)[0], 1, 12), Array(12).fill(null));
const denseBucket = { ...everyState, succeeded: 10_000 };
const denseLayout = matrixLayout([denseBucket]);
assert.ok(denseLayout.rows <= 21);
assert.equal(matrixCells(denseBucket, denseLayout.unit, denseLayout.rows).length, denseLayout.rows);
assert.deepEqual(bucketTooltip(everyState), { label: everyState.label, total: 6, rows: allStates.map(state => ({state, value: 1})) });
assert.equal(navigateBucket(0, 'ArrowLeft', 7), 0);
assert.equal(navigateBucket(6, 'ArrowRight', 7), 6);
assert.equal(navigateBucket(2, 'ArrowRight', 7), 3);
assert.equal(navigateBucket(2, 'ArrowUp', 7), 3);
assert.equal(navigateBucket(2, 'ArrowDown', 7), 1);
assert.equal(navigateBucket(3, 'Home', 30), 0);
assert.equal(navigateBucket(3, 'End', 30), 29);
assert.equal(navigateBucket(3, 'Escape', 7), 3);
assert.equal(navigateBucket(3, 'End', 0), -1);
const activityRuns = [make('succeeded', now), make('failed', now - 1), make('succeeded', now - 86400000), make('failed', now - 86400001), make('failed', now - 172800000), make('queued', now + 1), make('failed', NaN)];
assert.deepEqual(runKpi(activityRuns, now), {current: 2, previous: 2, delta: 0});
assert.deepEqual(runKpi(activityRuns, now, 'succeeded'), {current: 1, previous: 1, delta: 0});
assert.deepEqual(runKpi(activityRuns, now, 'failed'), {current: 1, previous: 1, delta: 0});
assert.deepEqual(runKpi([make('failed', now)], now), {current: 1, previous: 0, delta: 1});
assert.deepEqual(runKpi([make('failed', now - 86400000)], now), {current: 0, previous: 1, delta: -1});
assert.deepEqual(runKpi([], now), {current: 0, previous: 0, delta: 0});
assert.deepEqual(runSparkline(activityRuns, now), [...Array(11).fill(0), 2]);
assert.deepEqual(runSparkline(activityRuns, now, 'failed'), [...Array(11).fill(0), 1]);
assert.equal(timestampSeries([now - 7200001], now)[10], 1);
assert.equal(runSparkline([], now).length, 12);
assert.equal(runSparkline(activityRuns, now).reduce((n, value) => n + value, 0), runKpi(activityRuns, now).current);
console.log('Matrix ranges, cell scaling, tooltip values, keyboard navigation, run sparklines and KPI deltas passed.');

const fineNow = start + 12 * 3600000 + 1;
const fineBuckets = bucketRuns([make('succeeded', start), make('failed', start + 6 * 3600000), make('running', fineNow), make('queued', fineNow + 1)], fineNow, 7, 4);
assert.equal(fineBuckets.length, 28);
assert.equal(fineBuckets.reduce((n, bucket) => n + bucketTooltip(bucket).total, 0), 3);
assert.equal(fineBuckets.at(-4).succeeded, 1);
assert.equal(fineBuckets.at(-3).failed, 1);
assert.equal(fineBuckets.at(-2).running, 1);
for(let i = 1; i < fineBuckets.length; i++) assert.equal(fineBuckets[i - 1].end, fineBuckets[i].start);
assert.equal(fineBuckets[0].start, bucketRuns([], fineNow)[0].start);
assert.equal(fineBuckets.at(-1).end, bucketRuns([], fineNow).at(-1).end);
console.log('Dense weekly matrix buckets preserve calendar coverage and exact boundary counts.');
// Axis labels: 7d marks each day once (the active bucket never adds a duplicate);
// 30d adds the active day only when it sits clear of the stride labels.
{
  const shown7 = Array.from({ length: 28 }, (_, i) => i).filter((i) => axisLabelShown(i, 27, 7));
  assert.deepEqual(shown7, [0, 4, 8, 12, 16, 20, 24]);
  assert.equal(axisLabelShown(27, 27, 30), true); // 27 % 5 = 2 → clear of 25 and 30
  assert.equal(axisLabelShown(26, 26, 30), false); // 26 % 5 = 1 → would collide with 25
  console.log('Axis label placement checks passed.');
}
