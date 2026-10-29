import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dependencyError, selectionChange } from '../src/features/pipelines/pipeline-model.ts';
import { isDirty, saveSnapshot } from '../src/features/pipelines/draft-model.ts';
import { historyPage, historyPageSize } from '../src/features/pipelines/history-model.ts';

const node = (id) => ({ node_id: id, label: id, kind: 'sync', ref_id: 'job', x: 0, y: 0 });
const graph = {
  name: 'Daily', description: '', cron: null, enabled: true,
  nodes: ['a', 'b', 'c', 'd'].map(node),
  edges: [{ from_node: 'a', to_node: 'b' }, { from_node: 'b', to_node: 'c' }],
};

test('dependency creation rejects missing endpoints, self links, duplicates and transitive cycles', () => {
  const before = structuredClone(graph);
  for (const [from, to] of [['', 'a'], ['a', 'missing'], ['a', 'a'], ['a', 'b'], ['c', 'a']])
    assert.notEqual(dependencyError(graph, from, to), '', from + ' -> ' + to);
  assert.equal(dependencyError(graph, 'a', 'c'), '');
  assert.equal(dependencyError(graph, 'c', 'd'), '');
  assert.deepEqual(graph, before);
});

test('keyboard selection ignores movements, clears deselections, and survives deselection of another node', () => {
  assert.equal(selectionChange('a', [{ type: 'position', id: 'b' }]), 'a');
  assert.equal(selectionChange('a', [{ type: 'select', id: 'a', selected: false }]), '');
  assert.equal(selectionChange('a', [{ type: 'select', id: 'b', selected: true }, { type: 'select', id: 'a', selected: false }]), 'b');
  assert.equal(selectionChange('a', [{ type: 'select', id: 'a', selected: false }, { type: 'select', id: 'b', selected: true }]), 'b');
  assert.equal(selectionChange('', [{ type: 'select', id: '0', selected: true }]), '0');
});

test('dirty comparison detects nested definition edits and becomes clean when undone', () => {
  const draft = structuredClone(graph);
  assert.equal(isDirty(draft, graph), false);
  draft.nodes[0].x = 100;
  assert.equal(isDirty(draft, graph), true);
  draft.nodes[0].x = 0;
  assert.equal(isDirty(draft, graph), false);
  draft.edges.push({ from_node: 'a', to_node: 'd' });
  assert.equal(isDirty(draft, graph), true);
  assert.equal(isDirty(null, null), false);
});

test('save snapshots retain the submitted target and nested payload while the active editor changes', () => {
  let targetId = 'original';
  const draft = structuredClone(graph);
  const submitted = saveSnapshot(targetId, draft);
  targetId = 'another';
  draft.name = 'New name';
  draft.nodes[0].label = 'Changed during request';
  draft.edges.pop();
  assert.equal(submitted.id, 'original');
  assert.deepEqual(submitted.draft, graph);
  assert.equal(saveSnapshot(null, draft).id, null);
  const model = { name: 'users', sql: 'SELECT 1', optimize: true };
  const saved = saveSnapshot('model-a', model);
  model.sql = 'SELECT 2';
  assert.equal(saved.draft.sql, 'SELECT 1');
});

test('run paging preserves order, handles the sentinel and reports exact page bounds', () => {
  const rows = Array.from({ length: 101 }, (_, index) => 'run-' + index);
  const first = historyPage(rows, 0);
  assert.equal(first.rows.length, historyPageSize);
  assert.deepEqual([first.first, first.last], [1, 50]);
  const second = historyPage(rows, 1);
  assert.deepEqual(second.rows, rows.slice(50, 100));
  assert.deepEqual([second.first, second.last], [51, 100]);
  assert.deepEqual(historyPage(rows, 2), { rows: ['run-100'], first: 101, last: 101 });
  assert.deepEqual(historyPage([], 0), { rows: [], first: 0, last: 0 });
});

test('every essential edge state maintains at least 3:1 contrast in both themes', async () => {
  const css = await readFile(new URL('../src/styles/tailwind.css', import.meta.url), 'utf8');
  const edges = await readFile(new URL('../src/features/pipelines/styles.css', import.meta.url), 'utf8');
  const declarations = (block) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const light = declarations(css.match(/:root\s*\{([^}]+)\}/)[1]);
  const dark = { ...light, ...declarations(css.match(/\[data-theme=['"]dark['"]\]\s*\{([^}]+)\}/)[1]) };
  const rgb = (hex) => hex.slice(1).match(/../g).map((part) => parseInt(part, 16));
  const luminance = (color) => color.map((channel) => channel / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  const trackToken = edges.match(/--edge-track:\s*var\((--[\w-]+)\)/)[1];
  for (const [theme, palette] of [['light', light], ['dark', dark]]) {
    const resolve = (value) => {
      const variable = value.match(/^var\((--[\w-]+)\)$/);
      if (variable) return resolve(variable[1] === '--edge-track' ? palette[trackToken] : palette[variable[1]]);
      const mix = value.match(/^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\)$/);
      if (mix) {
        const a = resolve('var(' + mix[1] + ')'), b = resolve('var(' + mix[3] + ')');
        return a.map((channel, index) => channel * Number(mix[2]) / 100 + b[index] * (1 - Number(mix[2]) / 100));
      }
      return rgb(value);
    };
    for (const state of ['', '.flow-done', '.flow-flowing', '.flow-blocked', '.selected']) {
      const escaped = state.replaceAll('.', '\\.');
      const stroke = edges.match(new RegExp('\\.flow-edge' + escaped + ' \\.flow-track \\{\\s*stroke: ([^;]+);'))?.[1];
      assert.ok(stroke, 'Missing edge state ' + state);
      for (const background of ['--surface', '--bg', '--panel']) {
        const ratio = contrast(resolve(stroke), resolve(palette[background]));
        assert.ok(ratio >= 3, theme + ' ' + (state || 'idle') + ' on ' + background + ': ' + ratio);
      }
    }
  }
});
