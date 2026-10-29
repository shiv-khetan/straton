export const routes = [
  'Dashboard',
  'Activity',
  'Favorites',
  'Recent',
  'Sources',
  'Explorer',
  'SQL',
  'Query History',
  'Pipelines',
  'Models',
  'Jobs',
  'Schedules',
  'Optimizer',
  'Analytics',
  'Dashboards',
  'Data Quality',
  'Data Map',
  'Access',
  'Backups',
  'Settings',
  'Config as Code',
  'Connect',
] as const;
export type Route = (typeof routes)[number];
export type RouteHistory = { entries: Route[]; index: number };
export function navigateHistory(history: RouteHistory, route: Route): RouteHistory {
  if (history.entries[history.index] === route) return history;
  const entries = [...history.entries.slice(0, history.index + 1), route].slice(-100);
  return { entries, index: entries.length - 1 };
}
export function stepHistory(history: RouteHistory, delta: number): RouteHistory {
  return {
    ...history,
    index: Math.max(
      0,
      Math.min(
        history.entries.length - 1,
        history.index + Math.trunc(Number.isFinite(delta) ? delta : 0),
      ),
    ),
  };
}
export function isRoute(value: unknown): value is Route {
  return typeof value === 'string' && (routes as readonly string[]).includes(value);
}
export const routeLabels: Record<Route, string> = {
  Dashboard: 'Overview',
  Activity: 'Activity',
  Favorites: 'Favorites',
  Recent: 'Recent',
  Sources: 'Connections',
  Explorer: 'Explorer',
  SQL: 'SQL Workspace',
  'Query History': 'Query History',
  Pipelines: 'Pipelines',
  Models: 'Transformations',
  Jobs: 'Jobs',
  Schedules: 'Schedules',
  Optimizer: 'Optimizer',
  Analytics: 'Analytics',
  Dashboards: 'Dashboards',
  'Data Quality': 'Data Quality',
  'Data Map': 'Lineage',
  Access: 'Team & Permissions',
  Backups: 'Security & Backups',
  Settings: 'Settings',
  'Config as Code': 'Config as Code',
  Connect: 'Connect',
};
export const laterRoutes: readonly Route[] = ['Settings', 'Config as Code'];
