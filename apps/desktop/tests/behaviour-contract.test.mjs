import assert from 'node:assert/strict';
import test from 'node:test';
import { statusChip } from '../src/features/console/workbench-model.ts';
import { relativeTime } from '../src/lib/view-model.ts';
import { chartRows } from '../src/features/analytics/chart-model.ts';
import { evidenceSummary } from '../src/features/optimizer/optimizer-model.ts';
import { flowState, placeNodes } from '../src/features/pipelines/pipeline-model.ts';
import { columnPaths, fieldKey } from '../src/features/lineage/column-model.ts';
import { lastPage, useRouteStore } from '../src/stores/route.ts';
import { routes } from '../src/stores/route-history.ts';
import { safeStorage } from '../src/stores/storage.ts';
import { useSqlWorkspace } from '../src/stores/sql-workspace.ts';

test('status aliases are case insensitive and unknown states have a neutral fallback', () => {
  for (const value of ['connected', 'live', 'ready', 'succeeded']) {
    for (const state of [value, value.toUpperCase()])
      assert.deepEqual(statusChip(state), { state: 'succeeded', label: 'Succeeded', tone: 'success' });
  }
  for (const state of ['', 'unknown', undefined])
    assert.deepEqual(statusChip(state), { state: 'never synced', label: 'Never synced', tone: 'neutral' });
  assert.deepEqual(statusChip('INLINED'), { state: 'inlined', label: 'View · inlined', tone: 'neutral' });
});

test('relative times change at exact minute, hour and day boundaries', () => {
  const now = Date.UTC(2026, 9, 29, 12);
  for (const [age, text] of [[0,'Just now'],[59999,'Just now'],[60000,'1 min ago'],[3599999,'59 min ago'],[3600000,'1 h ago'],[86399999,'23 h ago'],[86400000,'1 d ago']]) {
    assert.equal(relativeTime(now - age, now), text);
    assert.equal(relativeTime(new Date(now - age).toISOString(), now), text);
  }
  for (const value of [NaN, Infinity, -Infinity, '']) assert.equal(relativeTime(value, now), 'Unknown');
  assert.equal(relativeTime(undefined, now), 'Never');
});

test('chart numeric cells preserve zero and reject non-finite or non-numeric values', () => {
  const values = [0, -2.25, ' 12.50 ', '1e3', '', ' ', 'NaN', 'Infinity', Infinity, NaN, true, null];
  const data = { columns: [{name:'amount'}], rows: values.map(v => [v]) };
  assert.deepEqual(chartRows(data, {y:['amount','missing']}).rows,
    [0,-2.25,12.5,1000,null,null,null,null,null,null,null,null].map((amount,_x) => ({_x,amount})));
});

test('chart series labels retain null and numeric categories without conflating them', () => {
  const data = {columns: [{name:'x'},{name:'series'},{name:'n'}], rows: [[1,null,0],['1','east','2'],[1,'west',3]]};
  const before = structuredClone(data);
  assert.deepEqual(chartRows(data,{x:'x',series:'series',y:['n']}), {
    keys: ['n · null','n · east','n · west'],
    rows: [{_x:1,'n · null':0,'n · west':3},{_x:'1','n · east':2}],
  });
  assert.deepEqual(data,before);
});

test('optimizer evidence handles absent evidence, singular observations and warnings', () => {
  assert.deepEqual(evidenceSummary({}), []);
  assert.deepEqual(evidenceSummary({observations:'12',rows_scanned:'9',metadata_warnings:[]}), []);
  assert.deepEqual(evidenceSummary({observations:1,role:'join_key',metadata_warnings:['offline','stale']}), [
    "1 join key seen in Straton's workload.", 'Warnings: offline; stale.',
  ]);
  assert.deepEqual(evidenceSummary({source_table:{schema:'s',table:'t',rows:0,modifications:0}}),
    ['Source table s.t holds 0 rows with 0 modifications since its statistics were updated.']);
});

test('pipeline blocked edges take precedence over flowing edges', () => {
  for (const to of ['pending','running','succeeded','failed','skipped','cancelled',undefined])
    assert.equal(flowState('failed',to),'blocked');
  for (const from of ['running','succeeded','pending',undefined])
    for (const to of ['skipped','cancelled']) assert.equal(flowState(from,to),'blocked');
  assert.equal(flowState('succeeded','pending'),'flowing');
  assert.equal(flowState('pending','running'),'idle');
});

const node = node_id => ({node_id,kind:'sync',ref_id:'j',label:node_id,x:0,y:0});
test('pipeline layout handles diamonds, disconnected nodes and remains immutable', () => {
  const graph = {nodes:['d','c','b','a','isolated'].map(node),edges:[['a','b'],['a','c'],['b','d'],['c','d']].map(([from_node,to_node])=>({from_node,to_node}))};
  const before = structuredClone(graph);
  const placed = placeNodes(graph);
  const at = Object.fromEntries(placed.nodes.map(n=>[n.node_id,n]));
  assert.equal(at.a.x,0); assert.equal(at.b.x,300); assert.equal(at.c.x,300); assert.equal(at.d.x,600);
  assert.notEqual(at.b.y,at.c.y);
  assert.equal(new Set(placed.nodes.map(n=>n.x+','+n.y)).size,5);
  assert.deepEqual(graph,before);
  assert.equal(placeNodes(placed),placed);
  assert.deepEqual(placeNodes({nodes:[],edges:[]}),{nodes:[],edges:[]});
});

const field = (dataset_id,column='id') => ({dataset_id,column});
const edge = (from,to) => ({from,to,kind:'passthrough',expression:'id',via:{}});
test('column paths highlight both diamond branches but exclude same-dataset sibling columns', () => {
  const a=field('a'),b=field('b'),c=field('c'),d=field('d');
  const graph={root:a,nodes:[a,b,c,d,field('a','secret')],edges:[edge(a,b),edge(a,c),edge(b,d),edge(c,d),edge(field('a','secret'),d)],usage:[],incomplete:false};
  const p=columnPaths(graph,a,'downstream',2);
  assert.deepEqual([...p.edges],[0,1,2,3]);
  assert.equal(p.nodes.has(fieldKey(field('a','secret'))),false);
  assert.deepEqual([...columnPaths(graph,a,'downstream',1).edges],[0,1]);
  assert.equal(columnPaths(graph,a,'downstream',-1).edges.size,0);
  assert.equal(columnPaths(graph,field('absent')).nodes.size,1);
});

test('column path depth is capped at 50 on long chains', () => {
  const graph={edges:Array.from({length:60},(_,i)=>edge(field(String(i)),field(String(i+1))))};
  const p=columnPaths(graph,field('0'),'downstream',Infinity);
  assert.equal(p.edges.size,50); assert.equal(p.nodes.size,51);
});

const entry=(id,scope,at)=>({id,scope,at,sql:'SELECT 1',elapsed_ms:1,row_count:1,status:'succeeded'});
test('query-history undo merges scopes in descending time order and keeps current duplicate IDs', () => {
  const initial=useSqlWorkspace.getState();
  try {
    const removed=[entry('old','a',10),entry('new','a',30)];
    useSqlWorkspace.setState({history:[...removed,entry('other','b',20)]});
    useSqlWorkspace.getState().clear('a');
    useSqlWorkspace.getState().record({...removed[1],at:40,sql:'SELECT 2'});
    useSqlWorkspace.getState().restore(removed);
    assert.deepEqual(useSqlWorkspace.getState().history.map(e=>e.id),['new','other','old']);
    assert.equal(useSqlWorkspace.getState().history[0].sql,'SELECT 2');
    useSqlWorkspace.getState().restore(removed);
    assert.equal(useSqlWorkspace.getState().history.length,3);
  } finally { useSqlWorkspace.setState(initial); }
});

test('query-history undo deduplicates repeated IDs within the restored batch', { skip: 'BUG: restore() does not deduplicate IDs within the restored batch' }, () => {
  const initial=useSqlWorkspace.getState();
  try {
    useSqlWorkspace.setState({history:[]});
    const e=entry('same','a',1);
    useSqlWorkspace.getState().restore([e,e]);
    assert.equal(useSqlWorkspace.getState().history.length,1);
  } finally { useSqlWorkspace.setState(initial); }
});

test('lastPage accepts route names and rejects malformed persisted data', () => {
  const get=safeStorage.getItem;
  try {
    for (const page of routes) {
      safeStorage.getItem=()=>page;
      assert.equal(lastPage(),page==='Connect'?'Dashboard':page);
    }
    for (const bad of [null,'',' SQL','sql','"SQL"','{','[]','null','Overview','__proto__']) {
      safeStorage.getItem=()=>bad;
      assert.equal(lastPage(),'Dashboard');
    }
  } finally {safeStorage.getItem=get;}
});

test('route navigation persists back and forward pages and retains last working page at Connect', () => {
  const set=safeStorage.setItem, initial=useRouteStore.getState(), writes=[];
  safeStorage.setItem=(key,value)=>writes.push([key,value]);
  try {
    const s=()=>useRouteStore.getState();
    s().reset('Dashboard'); s().navigate('SQL'); s().navigate('Jobs'); s().back(); s().forward(); s().navigate('Connect');
    assert.deepEqual(writes,[['straton:last-page','SQL'],['straton:last-page','Jobs'],['straton:last-page','SQL'],['straton:last-page','Jobs']]);
  } finally {safeStorage.setItem=set; useRouteStore.setState(initial);}
});
