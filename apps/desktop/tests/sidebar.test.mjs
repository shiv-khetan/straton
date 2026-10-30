import assert from 'node:assert/strict';
import { sidebarLayout } from '../src/app/sidebar-model.ts';
import {
  itemEntry,
  membersOf,
  navigation,
  navItemOf,
  pageLabelOf,
  pageLayout,
  routeAvailable,
  sectionOf,
} from '../src/app/navigation.ts';
import { routes } from '../src/stores/route-history.ts';
import { parseSidebar, defaultSidebar } from '../src/stores/sidebar-state.ts';

const sections = [
  { label: 'Overview', items: [{ route: 'Overview' }] },
  { label: 'A', items: ['1', '2', '3'].map((route) => ({ route })) },
  { label: 'B', items: ['4', '5', '6'].map((route) => ({ route })) },
];
const view = (pinned = []) => {
  const layout = sidebarLayout(sections, pinned);
  return {
    favorites: layout.favorites.map((item) => item.route),
    sections: layout.sections.map((s) => [s.label, s.items.map((item) => item.route)]),
  };
};

// Nothing is pinned by default: no Favorites, every section open in its fixed order.
assert.deepEqual(view(), {
  favorites: [],
  sections: [
    ['Overview', ['Overview']],
    ['A', ['1', '2', '3']],
    ['B', ['4', '5', '6']],
  ],
});
// A pinned item moves to Favorites (in pin order) and leaves its own section.
assert.deepEqual(view(['5', '2']), {
  favorites: ['5', '2'],
  sections: [
    ['Overview', ['Overview']],
    ['A', ['1', '3']],
    ['B', ['4', '6']],
  ],
});
// Duplicate or unknown pins are ignored.
assert.deepEqual(view(['3', '3', 'gone']).favorites, ['3']);
assert.deepEqual(
  sidebarLayout(navigation, []).sections.map((section) => section.label),
  ['Workspace', 'Data', 'Engineering', 'Intelligence', 'Administration'],
);
// Every route declares its body layout.
assert.deepEqual(Object.keys(pageLayout).sort(), [...routes].sort());

// Combined pages: one sidebar item, every member route still lands on it.
for (const route of ['Pipelines', 'Jobs', 'Schedules']) {
  assert.equal(navItemOf(route).route, 'Pipelines');
  assert.equal(pageLabelOf(route), 'Orchestration');
  assert.equal(sectionOf(route).label, 'Engineering');
}
assert.equal(pageLabelOf('Dashboards'), 'Analytics');
assert.equal(pageLabelOf('Recent'), 'Library');
assert.equal(navItemOf('Query History').route, 'SQL');
assert.equal(sectionOf('Query History').label, 'Data');
assert.equal(pageLabelOf('Models'), 'Transformations');
// Every route that used to have its own sidebar item still belongs to exactly one item.
const shown = navigation.flatMap((group) => group.items.flatMap(membersOf));
assert.equal(new Set(shown).size, shown.length);
assert.equal(shown.length, 21);
assert.ok(!shown.includes('Connect'));

// A combined item opens the first member this identity may use.
const syncAdmin = { privileges: { admin: false, read: true, sync_admin: true, grants: [] } };
const orchestration = navItemOf('Jobs');
assert.equal(itemEntry(null, orchestration), undefined);
assert.equal(
  itemEntry(syncAdmin, orchestration),
  membersOf(orchestration).find((r) => routeAvailable(syncAdmin, r)),
);
assert.equal(itemEntry(null, navItemOf('Recent')), 'Favorites');

assert.deepEqual(parseSidebar('bad storage'), defaultSidebar);
console.log(
  'Sidebar favorites, section ordering, combined pages and permission entry points passed.',
);
