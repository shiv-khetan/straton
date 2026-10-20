import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/api.ts';
for (const value of [
  'http://127.0.0.1:8787/',
  'http://localhost:8787/',
  'https://engine.example/',
]) {
  assert.equal(normalizeUrl('  ' + value + '  '), value.slice(0, -1));
}
for (const value of [
  'http://engine.example',
  'https://user:secret@engine.example',
  'https://engine.example/path',
  'https://engine.example/?token=secret',
  'https://engine.example/#fragment',
  'file:///engine',
  'not a url',
]) {
  assert.throws(() => normalizeUrl(value), undefined, value);
}
console.log('Connection URL boundary checks passed (10 cases).');
