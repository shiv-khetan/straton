import type { Policies } from '../../lib/api.ts';

export function savedPredicate(policies: Policies, role: string) {
  return policies.row_filters.find((filter) => filter.role_id === role)?.predicate ?? '';
}

export function dirtyPredicates(policies: Policies, drafts: Record<string, string>) {
  return Object.entries(drafts).some(([role, value]) => value !== savedPredicate(policies, role));
}

export function savePredicate(
  policies: Policies,
  role: string,
  predicate: string | null,
): Policies {
  const row_filters = policies.row_filters.filter((filter) => filter.role_id !== role);
  if (predicate !== null) row_filters.push({ role_id: role, predicate });
  return { ...policies, row_filters };
}
