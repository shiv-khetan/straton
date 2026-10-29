import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

assert.match(read('vite.config.ts'), /sourcemap:\s*false/, 'production builds must not ship public source maps');
const html = read('index.html');
assert.match(html, /^<!doctype html>/i);
assert.match(html, /<html lang="[a-z-]+"/);
assert.match(html, /<head><meta charset="UTF-8"\/>/, 'charset must be the first element in head');
assert.match(html, /name="viewport"/);
const csp = JSON.parse(read('src-tauri/tauri.conf.json')).app.security.csp;
for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'none'", "frame-src 'none'"])
  assert.ok(csp.includes(directive), 'CSP missing ' + directive);
assert.ok(!/unsafe-eval/.test(csp), 'CSP must not allow unsafe-eval');

const { describeError } = await import('../src/app/global-errors.ts');
assert.equal(describeError(new Error('boom\n    at stack')), 'boom');
assert.equal(describeError(''), 'An unexpected error occurred.');
assert.equal(describeError('x'.repeat(300)).length, 158);
console.log('Best practices: hidden source maps, document head basics, CSP directives, friendly error text.');
