import type { Grant, MaskKind, Me, Policies, Privilege } from '@/lib/api';
export function can(
  me: Me | null,
  privilege: Privilege,
  source?: string,
  dataset?: string,
): boolean {
  if (!me) return false;
  if (me.privileges.admin) return true;
  if (!source && !dataset) return me.privileges[privilege];
  return me.privileges.grants.some(
    (g: Grant) =>
      (g.privilege === privilege || g.privilege === 'admin') &&
      ((g.target_kind === 'source' && g.target_id === source) ||
        (g.target_kind === 'dataset' && g.target_id === dataset)),
  );
}
export function canPage(me: Me | null, page: string): boolean {
  if (page === 'Connect') return true;
  if (
    [
      'Dashboard',
      'Models',
      'Activity',
      'Pipelines',
      'Schedules',
      'Analytics',
      'Dashboards',
      'Data Quality',
    ].includes(page)
  )
    return me !== null;
  if (page === 'Sources')
    return (
      can(me, 'admin') ||
      !!me?.privileges.grants.some((g) => g.target_kind === 'source' && g.privilege === 'admin')
    );
  if (['Backups', 'Access'].includes(page)) return can(me, 'admin');
  return can(me, page === 'Jobs' ? 'sync_admin' : 'read');
}
export function setMask(
  masks: Policies['masks'],
  role_id: string,
  column: string,
  kind: MaskKind | null,
): Policies['masks'] {
  const next = masks.filter((m) => m.role_id !== role_id || m.column !== column);
  return kind === null ? next : [...next, { role_id, column, kind }];
}
