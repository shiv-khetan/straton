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
      'Settings',
    ].includes(page)
  )
    return me !== null;
  if (page === 'Sources')
    return (
      can(me, 'admin') ||
      !!me?.privileges.grants.some((g) => g.target_kind === 'source' && g.privilege === 'admin')
    );
  if (['Backups', 'Access', 'Optimizer'].includes(page)) return can(me, 'admin');
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

const strictness: Record<MaskKind, number> = { null: 4, redact: 3, hash: 2, last4: 1 };
/** The tag mask a role gets on a column (strictest tag wins, as in the engine) and its tag. */
export function tagMaskSource(
  policies: Policies,
  role_id: string,
  column: string,
): { tag: string; kind: MaskKind } | null {
  const tags = new Set((policies.tags ?? []).filter((t) => t.column === column).map((t) => t.tag));
  let best: { tag: string; kind: MaskKind } | null = null;
  for (const m of policies.tag_masks ?? [])
    if (
      m.role_id === role_id &&
      tags.has(m.tag) &&
      (!best || strictness[m.kind] > strictness[best.kind])
    )
      best = { tag: m.tag, kind: m.kind };
  return best;
}
export function tagMaskFor(policies: Policies, role_id: string, column: string): MaskKind | null {
  return tagMaskSource(policies, role_id, column)?.kind ?? null;
}
/** Engine tag rules: 1–64 of a–z, 0–9, '_', '-', '.', ':'; case-insensitive. */
export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase();
  return /^[a-z0-9_.:-]{1,64}$/.test(tag) ? tag : null;
}
export function setTag(
  tags: NonNullable<Policies['tags']>,
  column: string,
  tag: string,
  tagged: boolean,
): NonNullable<Policies['tags']> {
  const next = tags.filter((t) => t.column !== column || t.tag !== tag);
  return tagged ? [...next, { column, tag }] : next;
}
/** Why a tag cannot be added yet, for the field's description; empty when it can. */
export function tagProblem(draft: string, duplicate: boolean): string {
  if (draft.trim() === '') return '';
  if (!normalizeTag(draft)) return 'Use 1–64 letters, digits, or _ - . : (no spaces).';
  return duplicate ? 'Already tagged.' : '';
}
