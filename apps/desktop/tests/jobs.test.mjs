import assert from 'node:assert/strict';
import { eligibleWatermarkColumns, runStats } from '../src/features/jobs/job-model.ts';
const columns = ['Int64', 'UInt32', 'Date32', 'Date64', 'Timestamp(Microsecond, None)', 'Utf8', 'Float64', 'Interval(YearMonth)', 'Int128'].map((type, i) => ({name:String(i), type}));
assert.deepEqual(eligibleWatermarkColumns(columns).map(c => c.type), columns.slice(0,5).map(c => c.type));
assert.deepEqual(eligibleWatermarkColumns([]), []);
assert.equal(runStats({rows_inserted:2, rows_updated:1, rows_deleted:0, rows_read:3}), '+2 / ~1 / −0 / 3 rows read');
assert.equal(runStats({rows_inserted:0, rows_updated:0, rows_deleted:2, rows_read:0}), '+0 / ~0 / −2 / 0 rows read');
console.log('Incremental watermark eligibility and run stats passed.');

const { hasIncrementalSettings } = await import('../src/features/jobs/job-model.ts');
assert.equal(hasIncrementalSettings('stripe','',[]),true);
assert.equal(hasIncrementalSettings('salesforce','',[]),true);
assert.equal(hasIncrementalSettings('postgres','updated_at',['id']),true);
assert.equal(hasIncrementalSettings('postgres','', ['id']),false);
assert.equal(hasIncrementalSettings('postgres','updated_at',[]),false);
assert.equal(hasIncrementalSettings(undefined,'',[]),false);
console.log('Event-feed incremental validation and required watermark/key checks passed.');
