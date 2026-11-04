import assert from 'node:assert/strict';
import { can, canPage, setMask } from '../src/features/access/access-model.ts';
const user={user:{id:'u',name:'User'},roles:[],privileges:{admin:false,read:true,sync_admin:false,grants:[{target_kind:'source',target_id:'s1',privilege:'read'}]}};
assert.equal(can(null,'read'),false);
assert.equal(canPage(null,'Connect'),true);
assert.equal(canPage(user,'SQL'),true);
assert.equal(canPage(user,'Access'),false);
assert.equal(canPage(user,'Sources'),false);
assert.equal(canPage(user,'Jobs'),false);
assert.equal(can(user,'read','s1','d1'),true);
assert.equal(can(user,'read','s2','d2'),false);
const operator={...user,privileges:{...user.privileges,read:false,sync_admin:true,grants:[{target_kind:'dataset',target_id:'d1',privilege:'sync_admin'}]}};
assert.equal(canPage(operator,'Jobs'),true);
assert.equal(canPage(operator,'SQL'),false);
assert.equal(can(operator,'sync_admin','s1','d1'),true);
assert.equal(can(operator,'sync_admin','s1','d2'),false);
const scopedAdmin={...user,privileges:{...user.privileges,grants:[{target_kind:'source',target_id:'s1',privilege:'admin'}]}};
assert.equal(can(scopedAdmin,'sync_admin','s1','d1'),true);
assert.equal(can(scopedAdmin,'read','s1','d1'),true);
assert.equal(can(scopedAdmin,'admin','s1'),true);
assert.equal(canPage(scopedAdmin,'Sources'),true);
assert.equal(canPage(scopedAdmin,'Access'),false);
const admin={...user,privileges:{...user.privileges,admin:true}};
for(const page of ['Dashboard','Sources','Jobs','SQL','Data Map','Access','Backups'])assert.equal(canPage(admin,page),true);
const initial=[{role_id:'r1',column:'id',kind:'null'},{role_id:'r2',column:'name',kind:'hash'}];
const replaced=setMask(initial,'r1','id','redact');
assert.deepEqual(initial[0],{role_id:'r1',column:'id',kind:'null'});
assert.equal(replaced.length,2);
assert.equal(replaced.find(m=>m.role_id==='r1').kind,'redact');
assert.deepEqual(setMask(replaced,'r1','id',null),[initial[1]]);
assert.equal(setMask(replaced,'r1','name','last4').length,3);
assert.equal(setMask(replaced,'r1','id','hash').length,2);
console.log('Privilege gating, target inheritance, and immutable mask matrix state passed.');
// Tag-based masks: the strictest tag mask applies, matching the engine.
import { normalizeTag, setTag, tagMaskFor, tagProblem } from '../src/features/access/access-model.ts';
const tagged = {
  row_filters: [],
  masks: [],
  tags: [{ column: 'email', tag: 'pii' }, { column: 'email', tag: 'secret' }, { column: 'id', tag: 'key' }],
  tag_masks: [
    { tag: 'pii', role_id: 'r', kind: 'hash' },
    { tag: 'secret', role_id: 'r', kind: 'null' },
    { tag: 'pii', role_id: 'other', kind: 'last4' },
  ],
};
assert.equal(tagMaskFor(tagged, 'r', 'email'), 'null');
assert.equal(tagMaskFor(tagged, 'other', 'email'), 'last4');
assert.equal(tagMaskFor(tagged, 'r', 'id'), null);
assert.equal(tagMaskFor({ row_filters: [], masks: [] }, 'r', 'email'), null);
assert.equal(normalizeTag('  PII '), 'pii');
assert.equal(normalizeTag('finance.salary:eu'), 'finance.salary:eu');
for (const bad of ['', 'has space', 'x'.repeat(65), 'émoji']) assert.equal(normalizeTag(bad), null, bad);
assert.deepEqual(setTag(tagged.tags, 'id', 'key', false), tagged.tags.slice(0, 2));
assert.deepEqual(setTag([], 'id', 'pii', true), [{ column: 'id', tag: 'pii' }]);
assert.equal(tagProblem('', false), '');
assert.match(tagProblem('has space', false), /no spaces/);
assert.equal(tagProblem('pii', true), 'Already tagged.');
assert.equal(tagProblem('pii', false), '');
console.log('Tag masks: strictest tag, per-role, normalisation, edits and field help passed.');
