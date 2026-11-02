import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the shared page anatomy (src/components/workbench/page-layout.tsx): pages build their
// top of page from PageTabs, SectionHeader, PageIntro and PageToolbar instead of local markup.
const root = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const sources = files(join(root, 'features')).map((path) => ({
  path: relative(root, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));
const tsx = sources.filter((s) => s.path.endsWith('.tsx'));
const css = sources.filter((s) => s.path.endsWith('.css'));

// The shell header owns the page title; pages never render their own h1 block.
assert.deepEqual(
  tsx.filter((s) => s.text.includes('page-heading') || /<h1[\s>]/.test(s.text)).map((s) => s.path),
  [],
);
// Page-level views use PageTabs. The plain Tabs primitive is only for views nested inside a
// section, sheet or the console drawer.
const nestedTabs = [
  'features/console/ConsoleDrawer.tsx',
  'features/pipelines/Pipelines.tsx',
  'features/transformations/ModelSheet.tsx',
];
assert.deepEqual(
  tsx.filter((s) => /<Tabs\s+id=/.test(s.text)).map((s) => s.path),
  nestedTabs,
);
// Intro text is a PageIntro, not a paragraph squeezed into a heading row.
assert.deepEqual(
  tsx.filter((s) => /className="section-toolbar">\s*<p/.test(s.text)).map((s) => s.path),
  [],
);
// Layout classes are defined once, in the shell and workbench styles, not per feature.
for (const shared of [
  '.section-toolbar',
  '.section-header',
  '.page-tabs',
  '.page-intro',
  '.toolbar ',
])
  assert.deepEqual(
    css
      .filter((s) => s.text.includes(shared + ' {') || s.text.includes(shared + '{'))
      .map((s) => s.path),
    [],
    shared + ' must only be defined in shared styles',
  );
const shell = readFileSync(join(root, 'app/styles.css'), 'utf8');
for (const shared of ['.page-tabs', '.section-header', '.page-intro', '.section-toolbar'])
  assert.ok(shell.includes(shared + ' {'), shared + ' is defined in app/styles.css');
console.log(
  'Layout consistency: shell-owned titles, PageTabs, intros and shared layout classes passed.',
);
