import type { Me } from '@/lib/api';
import { canPage } from '../features/access/access-model.ts';
import type { IconName } from '@/components/workbench/Icon';
import type { NavGroup } from '@/stores/sidebar-state';
import { laterRoutes, routeLabels } from '../stores/route-history.ts';
import type { Route } from '@/stores/route-history';
// A sidebar item opens one page. Items with `members` combine several routes on one page;
// each member route still exists (deep links, notifications, history) and scrolls to its section.
export type NavItem = { route: Route; icon: IconName; label?: string; members?: Route[] };
export const navigation: { label: NavGroup; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { route: 'Dashboard', icon: 'dashboard' },
      { route: 'Activity', icon: 'activity' },
      { route: 'Favorites', icon: 'star', label: 'Library', members: ['Favorites', 'Recent'] },
    ],
  },
  {
    label: 'Data',
    items: [
      { route: 'Sources', icon: 'source' },
      { route: 'Explorer', icon: 'explorer' },
      { route: 'SQL', icon: 'sql', members: ['SQL', 'Query History'] },
    ],
  },
  {
    label: 'Engineering',
    items: [
      {
        route: 'Pipelines',
        icon: 'jobs',
        label: 'Orchestration',
        members: ['Pipelines', 'Jobs', 'Schedules'],
      },
      { route: 'Models', icon: 'model' },
      { route: 'Optimizer', icon: 'settings' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { route: 'Analytics', icon: 'analytics', members: ['Analytics', 'Dashboards'] },
      { route: 'Data Quality', icon: 'quality' },
      { route: 'Data Map', icon: 'map' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { route: 'Access', icon: 'user' },
      { route: 'Backups', icon: 'lock' },
      { route: 'Settings', icon: 'settings' },
      { route: 'Config as Code', icon: 'config' },
    ],
  },
];
// How each route lays out its body. Record<Route, ...> makes the compiler reject a route
// without one. document: scrolling page with standard padding (PageTabs, sections, trays);
// workbench: full-bleed tool that manages its own panes; connect: the centred sign-in form.
export const pageLayout: Record<Route, 'document' | 'workbench' | 'connect'> = {
  Dashboard: 'document',
  Activity: 'document',
  Favorites: 'document',
  Recent: 'document',
  Sources: 'document',
  Explorer: 'workbench',
  SQL: 'workbench',
  'Query History': 'workbench',
  Pipelines: 'document',
  Models: 'workbench',
  Jobs: 'document',
  Schedules: 'document',
  Optimizer: 'document',
  Analytics: 'document',
  Dashboards: 'document',
  'Data Quality': 'document',
  'Data Map': 'workbench',
  Access: 'document',
  Backups: 'document',
  Settings: 'document',
  'Config as Code': 'document',
  Connect: 'connect',
};
const allItems = navigation.flatMap((group) => group.items);
export const membersOf = (item: NavItem): Route[] => item.members ?? [item.route];
/** The sidebar item that shows this route (a combined page for member routes). */
export function navItemOf(route: Route): NavItem {
  return allItems.find((item) => membersOf(item).includes(route)) ?? { route, icon: 'dashboard' };
}
/** Page title for a route: the combined page's name for member routes. */
export function pageLabelOf(route: Route): string {
  const item = navItemOf(route);
  return item.label ?? routeLabels[item.route];
}
export function routeAvailable(me: Me | null, route: Route) {
  return (
    ['Favorites', 'Recent', 'Connect'].includes(route) ||
    laterRoutes.includes(route) ||
    canPage(me, route)
  );
}
/** First route of the item this identity may open, or undefined when none. */
export function itemEntry(me: Me | null, item: NavItem): Route | undefined {
  return membersOf(item).find((route) => routeAvailable(me, route));
}
// Shared section names for sidebar headings, breadcrumbs and shortcuts.
export const sectionLabels: Record<NavGroup, string> = {
  Workspace: 'Overview',
  Data: 'Data',
  Engineering: 'Engineering',
  Intelligence: 'Intelligence',
  Administration: 'Admin',
};
export function sectionOf(route: Route): (typeof navigation)[number] {
  return navigation.find((g) => g.items.some((i) => membersOf(i).includes(route))) ?? navigation[0];
}
