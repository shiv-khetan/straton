import assert from 'node:assert/strict';
import {
  defaultImportant,
  orderSections,
  visibleItems,
  togglePin,
  parseImportant,
} from '../src/app/sidebar-model.ts';
import { navigation, routeAvailable } from '../src/app/navigation.ts';
import { parseSidebar, defaultSidebar } from '../src/stores/sidebar-state.ts';

// The user's exact A/B example: Overview at rest, A opens, then B opens.
const sections = [
  { label: 'Overview', items: [{ route: 'Overview' }] },
  { label: 'A', items: ['1', '2', '3'].map((route) => ({ route })) },
  { label: 'B', items: ['4', '5', '6'].map((route) => ({ route })) },
];
const important = defaultImportant(sections);
const snapshot = (active, pins = important, expanded = []) =>
  orderSections(active, sections).map((section) => [
    section.label,
    visibleItems(section, pins, expanded.includes(section.label), active).map((item) => item.route),
  ]);
assert.deepEqual(snapshot('Overview'), [
  ['Overview', ['Overview']],
  ['A', ['1', '2']],
  ['B', ['4', '5']],
]);
assert.deepEqual(snapshot('A'), [
  ['A', ['1', '2', '3']],
  ['Overview', ['Overview']],
  ['B', ['4', '5']],
]);
assert.deepEqual(snapshot('B'), [
  ['B', ['4', '5', '6']],
  ['Overview', ['Overview']],
  ['A', ['1', '2']],
]);
assert.deepEqual(
  sections.map((section) => section.label),
  ['Overview', 'A', 'B'],
);

const pinned = togglePin(important, 'A', '3');
assert.deepEqual(snapshot('B', pinned).at(-1), ['A', ['1', '2', '3']]);
assert.deepEqual(snapshot('B', togglePin(pinned, 'A', '1')).at(-1), ['A', ['2', '3']]);
assert.deepEqual(togglePin(pinned, 'A', '3'), important);
assert.deepEqual(important.A, ['1', '2']);
assert.deepEqual(pinned.B, important.B);
assert.deepEqual(snapshot('Overview', important, ['B']), [
  ['Overview', ['Overview']],
  ['A', ['1', '2']],
  ['B', ['4', '5', '6']],
]);
assert.deepEqual(snapshot('A').at(-1), ['B', ['4', '5']]);
// Unpinning every item is intentional; show-all still reveals every page.
const empty = togglePin(togglePin(important, 'A', '1'), 'A', '2');
assert.deepEqual(visibleItems(sections[1], empty, false, 'B'), []);
assert.equal(visibleItems(sections[1], empty, true, 'B').length, 3);
assert.equal(visibleItems(sections[1], empty, false, 'A').length, 3);

const defaults = defaultImportant(navigation);
for (const section of navigation)
  assert.deepEqual(
    defaults[section.label],
    section.items.slice(0, 2).map((item) => item.route),
  );
assert.deepEqual(
  orderSections('Intelligence', navigation).map((section) => section.label),
  ['Intelligence', 'Workspace', 'Data', 'Engineering', 'Administration'],
);
// Disabled pages remain visible/pinnable and routeAvailable still gates navigation.
const data = navigation.find((section) => section.label === 'Data');
assert.deepEqual(
  visibleItems(data, defaults, false, 'Workspace').map((item) => [
    item.route,
    routeAvailable(null, item.route),
  ]),
  [
    ['Sources', false],
    ['Explorer', false],
  ],
);
const noAccessPins = togglePin(defaults, 'Data', 'SQL');
assert.equal(visibleItems(data, noAccessPins, false, 'Workspace').at(-1).route, 'SQL');
assert.equal(routeAvailable(null, 'SQL'), false);
const reader = { privileges: { admin: false, read: true, sync_admin: false, grants: [] } };
assert.equal(data.items.find((item) => routeAvailable(reader, item.route)).route, 'Explorer');
assert.equal(
  navigation.at(-1).items.find((item) => routeAvailable(null, item.route)).route,
  'Settings',
);

for (const corrupt of [
  undefined,
  null,
  42,
  false,
  'broken {',
  'null',
  '[]',
  '{"A":true}',
  { A: '1' },
])
  assert.deepEqual(parseImportant(corrupt, sections), important);
assert.deepEqual(parseImportant({ A: ['3', '3', 'unknown', 1], B: [] }, sections), {
  Overview: ['Overview'],
  A: ['3'],
  B: [],
});
assert.deepEqual(parseImportant(JSON.stringify(pinned), sections), pinned);
const parsed = parseImportant(null, sections);
parsed.A.push('3');
assert.deepEqual(important.A, ['1', '2']);
assert.deepEqual(parseSidebar('bad storage'), defaultSidebar);
console.log(
  'Sidebar A/B ordering, defaults, pin/unpin, show-all, permission disabling and corrupt persistence passed.',
);
