import assert from 'node:assert/strict';
import {explorerRequest,parseFilter,parseWidths,widthKey} from '../src/features/explorer/explorer-model.ts';
import {updateTab,closeTab,addHistory,shortcutAction,shortcuts} from '../src/features/sql/workspace-model.ts';
import {formatBytes} from '../src/features/overview/storage-model.ts';
const state={pageIndex:2,pageSize:100,sorting:[{id:'a.b',desc:true}],filters:[{column:'name',op:'eq',value:"x'; DROP TABLE t;--"}],search:'ALICE'};
assert.deepEqual(explorerRequest('app','table',state),{schema:'app',table:'table',sort:[{column:'a.b',dir:'desc'}],filters:state.filters,search:'ALICE',limit:100,offset:200});
assert.equal(explorerRequest('s','t',{...state,pageSize:900}).limit,500);
assert.deepEqual(parseFilter('name','eq','null'),{column:'name',op:'eq',value:'null'});
assert.deepEqual(parseFilter('id','in','[1,"2",null,true]'),{column:'id',op:'in',value:[1,'2',null,true]});
assert.deepEqual(parseFilter('id','is_null','ignored'),{column:'id',op:'is_null'});
assert.throws(()=>parseFilter('x','in','[[1]]'));
assert.throws(()=>parseFilter('x','in','1,2'));
assert.throws(()=>parseFilter('x','drop','1'));
assert.deepEqual(parseWidths({a:120,b:0,c:Infinity,d:'100',e:1300}),{a:120});
assert.deepEqual(parseWidths(null),{});assert.deepEqual(parseWidths([]),{});
assert.notEqual(widthKey('a','bc'),widthKey('ab','c'));
const tabs=[{id:'1',name:'One',sql:'SELECT 1',dirty:false},{id:'2',name:'Two',sql:'SELECT 2',dirty:false}];
const changed=updateTab(tabs,'2',{sql:'SELECT 3',dirty:true});assert.equal(changed[1].dirty,true);assert.equal(tabs[1].sql,'SELECT 2');assert.equal(changed[0],tabs[0]);
assert.deepEqual(closeTab(tabs,'2','2'),{tabs:[tabs[0]],active:'1'});assert.equal(closeTab(tabs,'2','1').active,'2');assert.equal(closeTab([tabs[0]],'1','1').active,'');
const entry={id:'a',scope:'engine|reader',sql:'SELECT 1',at:1,elapsed_ms:2,row_count:1,status:'succeeded'};
let history=[];for(let i=0;i<510;i++) history=addHistory(history,{...entry,id:String(i)});
assert.equal(history.length,500);assert.equal(history.at(-1).id,'10');assert.equal(addHistory(history,{...entry,id:'509'}).length,500);
assert.equal(addHistory([entry],{...entry,sql:'SELECT 2'})[0].sql,'SELECT 2');
for (const [key,action] of shortcuts) {const parts=key.split('+');assert.equal(shortcutAction({key:parts.at(-1)==='Esc'?'Escape':parts.at(-1),ctrlKey:parts.includes('Ctrl'),shiftKey:parts.includes('Shift')}),action);}
assert.equal(shortcutAction({key:'Enter',ctrlKey:false,shiftKey:false}),null);assert.equal(shortcutAction({key:'s',ctrlKey:true,shiftKey:true}),null);
assert.equal(formatBytes(0),'0 B');assert.equal(formatBytes(1024),'1 KiB');assert.equal(formatBytes(1048576),'1 MiB');assert.equal(formatBytes(-1),'—');
console.log('Core: Explorer mapping/filters/widths, tab reducers, history cap/dedupe, shortcuts and storage passed.');
// Profile histograms: bin labels and the spoken summary (the chart's text fallback).
import { binLabel, histogramSummary } from '../src/features/explorer/explorer-model.ts';
const bins = [
  { lo: 0, hi: 50, count: 1 },
  { lo: 50, hi: 100, count: 3 },
  { lo: 100, hi: 150, count: 0 },
];
assert.equal(binLabel(bins[1]), '50 – 100');
assert.equal(binLabel({ lo: 0.125, hi: 0.25, count: 1 }), '0.13 – 0.25');
assert.equal(
  histogramSummary('amount', bins),
  'Distribution of amount: 4 values from 0 to 150; most fall in 50 – 100 (75%).',
);
assert.equal(histogramSummary('amount', []), 'No values to chart for amount.');
console.log('Profile histograms: bin labels and summaries passed.');
// Time travel: the request carries the snapshot, and Open in SQL names it.
import { snapshotReference } from '../src/features/explorer/explorer-model.ts';
const base = { pageIndex: 0, pageSize: 100, sorting: [], filters: [], search: '' };
assert.equal('snapshot' in explorerRequest('s', 't', base), false);
assert.equal(explorerRequest('s', 't', { ...base, snapshot: 'abc' }).snapshot, 'abc');
assert.equal(snapshotReference('app_db', 'users'), '"app_db"."users"');
assert.equal(snapshotReference('app_db', 'users', 'r1'), '"app_db"."users@r1"');
assert.equal(snapshotReference('a"b', 'c', null), '"a""b"."c"');
console.log('Time travel: snapshot requests and SQL references passed.');
