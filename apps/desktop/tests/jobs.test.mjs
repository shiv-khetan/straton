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

assert.deepEqual(eligibleWatermarkColumns([{name:'version', type:'FixedSizeBinary(8)'}, {name:'bytes', type:'Binary'}]).map(c=>c.name), ['version']);
assert.equal(hasIncrementalSettings('sqlserver','version',['id']),true);

const { databaseSslMode, mongoTlsDefault } = await import('../src/features/connections/source-model.ts');
assert.equal(databaseSslMode('postgres', {host:'ep-test-pooler.us-east-2.aws.neon.tech'}), 'require');
assert.equal(databaseSslMode('postgres', {host:'::1'}), 'prefer');
assert.equal(databaseSslMode('mysql', {host:'db.example.net'}), 'required');
assert.equal(databaseSslMode('mysql', {host:'127.0.0.2'}), 'preferred');
assert.equal(databaseSslMode('mysql', {host:'127.999.1.1'}), 'required');
assert.equal(databaseSslMode('postgres', {host:'localhost',sslmode:'verify-full'}), 'verify-full');
assert.equal(mongoTlsDefault({hosts:['localhost:27017','[::1]:27018']}), false);
assert.equal(mongoTlsDefault({hosts:['localhost:27017','remote:27017']}), true);
assert.equal(mongoTlsDefault({host:'mongodb+srv://cluster.example.net'}), true);
assert.deepEqual(eligibleWatermarkColumns([{name:'_id',type:'Utf8'},{name:'other',type:'Utf8'},{name:'n',type:'Int64'},{name:'updatedAt',type:'Timestamp(Millisecond, Some("+00:00"))'}], 'mongodb').map(c=>c.name), ['_id','updatedAt']);
console.log('Database TLS defaults and MongoDB watermark eligibility passed.');
