import type { Me } from '@/lib/api';
import { canPage } from '@/features/access/access-model';
import type { IconName } from '@/components/workbench/Icon';
import type { NavGroup } from '@/stores/sidebar-state';
import { laterRoutes } from '@/stores/route-history';
import type { Route } from '@/stores/route-history';
export const navigation: { label: NavGroup; items: { route: Route; icon: IconName }[] }[] = [
  {
    label: 'Workspace',
    items: [
      { route: 'Dashboard', icon: 'dashboard' },
      { route: 'Activity', icon: 'activity' },
      { route: 'Favorites', icon: 'star' },
      { route: 'Recent', icon: 'history' },
    ],
  },
  {
    label: 'Data',
    items: [
      { route: 'Sources', icon: 'source' },
      { route: 'Explorer', icon: 'explorer' },
      { route: 'SQL', icon: 'sql' },
      { route: 'Query History', icon: 'history' },
    ],
  },
  {
    label: 'Engineering',
    items: [
      { route: 'Pipelines', icon: 'jobs' },
      { route: 'Models', icon: 'model' },
      { route: 'Jobs', icon: 'refresh' },
      { route: 'Schedules', icon: 'schedule' },
      { route: 'Optimizer', icon: 'settings' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { route: 'Analytics', icon: 'analytics' },
      { route: 'Dashboards', icon: 'dashboards' },
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
export function routeAvailable(me: Me | null, route: Route) {
  return (
    ['Favorites', 'Recent', 'Connect'].includes(route) ||
    laterRoutes.includes(route) ||
    canPage(me, route)
  );
}
// Top-bar section names; the sidebar lists the active section's pages.
export const sectionLabels: Record<NavGroup, string> = {
  Workspace: 'Overview',
  Data: 'Data',
  Engineering: 'Engineering',
  Intelligence: 'Intelligence',
  Administration: 'Admin',
};
export function sectionOf(route: Route): (typeof navigation)[number] {
  return navigation.find((g) => g.items.some((i) => i.route === route)) ?? navigation[0];
}
