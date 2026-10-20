import assert from 'node:assert/strict';
import { relativeTime, backupTime, bucketRuns, isLoopback } from '../src/view-model.ts';
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
console.log('Relative times, backup filenames, loopback detection and chart boundaries passed.');

// Test the shipped CSS pairs, including the active navigation tint in dark mode.
const { readFile } = await import('node:fs/promises');
const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(m => [m[1],m[2]]));
const light = tokens(css.slice(0,css.indexOf(":root[data-theme='dark']")));
const dark = {...light,...tokens(css.slice(css.indexOf(":root[data-theme='dark']"),css.indexOf('@media')))};
function luminance(hex) {
  const [r,g,b] = hex.slice(1).match(/../g).map(c=>parseInt(c,16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
  return 0.2126*r+0.7152*g+0.0722*b;
}
function contrast(a,b) { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }
for(const [theme,palette] of [['light',light],['dark',dark]]) {
  for(const [text,bg] of [['ink','surface'],['ink','bg'],['muted','surface'],['muted','bg'],['primary','primary-50'],['success-ink','success-50'],['warning-ink','warning-50'],['danger-ink','danger-50'],['info-ink','info-50']]) {
    assert.ok(contrast(palette[text],palette[bg])>=4.5,theme+': '+text+' on '+bg);
  }
}
assert.equal(light.primary.toUpperCase(),'#1D50A2');
assert.equal(light.success.toUpperCase(),'#1ABC9C');
assert.equal(light.warning.toUpperCase(),'#F39C12');
assert.equal(light.danger.toUpperCase(),'#E74C3C');
assert.equal(light.info.toUpperCase(),'#F1C40F');
console.log('Mandatory palette and light/dark text contrast checks passed (18 pairs).');
