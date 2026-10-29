import assert from 'node:assert/strict';
import { applyReason, canRollback, rankRecommendations } from '../src/features/optimizer/optimizer-model.ts';
import { canPage } from '../src/features/access/access-model.ts';
import { routes } from '../src/stores/route-history.ts';
const row={id:'a',status:'open',applicable:true,estimated_benefit:2,applied_at:null};
const source={advisor_may_write:true};
assert.equal(applyReason(row,source,true,false),'');
assert.match(applyReason(row,source,false,false),/Admin/);
assert.match(applyReason(row,{advisor_may_write:false},true,false),/Connections/);
assert.match(applyReason(row,undefined,true,false),/off/);
assert.match(applyReason({...row,applicable:false},source,true,false),/Advice only/);
assert.match(applyReason({...row,status:'applied'},source,true,false),/open/);
assert.match(applyReason(row,source,true,true),/Reconnect/);
assert.equal(canRollback({...row,status:'applied'}),true);
assert.equal(canRollback({...row,status:'failed',applied_at:42}),true);
assert.equal(canRollback({...row,status:'failed'}),false);
assert.deepEqual(rankRecommendations([row,{...row,id:'b',estimated_benefit:9}]).map(r=>r.id),['b','a']);
assert.ok(routes.includes('Optimizer'));
assert.equal(canPage({privileges:{admin:false,grants:[]}},'Optimizer'),false);
assert.equal(canPage({privileges:{admin:true}},'Optimizer'),true);
console.log('Optimizer approval, rollback, ranking and permission checks passed.');

{
  const { indexColumns, evidenceSummary } = await import('../src/features/optimizer/optimizer-model.ts');
  const cols = indexColumns('CREATE INDEX [ix_a] ON [sales].[orders] ([customer_id], [status] DESC);');
  if (JSON.stringify(cols) !== JSON.stringify(['customer_id', 'status'])) throw new Error('indexColumns: ' + cols);
  if (indexColumns('-- Review compatibility_level').length) throw new Error('indexColumns on advice');
  const lines = evidenceSummary({ observations: 12, op: 'equality', role: 'filter', rows_scanned: 18000, source_table: { schema: 'sales', table: 'orders', rows: 1500, modifications: 0 }, metadata_warnings: [] });
  if (!lines[0].includes('12 equality filters') || !lines[0].includes('18,000 rows')) throw new Error('evidence: ' + lines[0]);
  if (!lines[1].includes('sales.orders holds 1,500 rows')) throw new Error('evidence: ' + lines[1]);
  console.log('Optimizer: index columns and readable evidence.');
}
