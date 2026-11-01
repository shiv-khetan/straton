import type { ExplorerRequest, ExplorerFilter, FilterOp, SqlCell } from '../../lib/api.ts';
export const filterOps: FilterOp[] = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'starts_with',
  'is_null',
  'not_null',
  'in',
];
/** Readable operator names for the filter picker; values stay the API's operator ids. */
export const filterOpLabels: Record<FilterOp, string> = {
  eq: '= equals',
  ne: '≠ not equal',
  lt: '< less than',
  lte: '≤ at most',
  gt: '> greater than',
  gte: '≥ at least',
  contains: 'contains',
  starts_with: 'starts with',
  is_null: 'is null',
  not_null: 'is not null',
  in: 'is one of',
};
export function parseFilter(column: string, op: FilterOp, text: string): ExplorerFilter {
  if (!column || !filterOps.includes(op)) throw new Error('Choose a column and operator.');
  if (op === 'is_null' || op === 'not_null') return { column, op };
  if (op === 'in') {
    const value: unknown = JSON.parse(text);
    if (
      !Array.isArray(value) ||
      value.some((v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v))
    )
      throw new Error('Use a JSON array of scalar values.');
    return { column, op, value: value as SqlCell[] };
  }
  return { column, op, value: text };
}
export function explorerRequest(
  schema: string,
  table: string,
  state: {
    pageIndex: number;
    pageSize: number;
    sorting: { id: string; desc: boolean }[];
    filters: ExplorerFilter[];
    search: string;
  },
): ExplorerRequest {
  const limit = Math.min(500, Math.max(1, Math.trunc(state.pageSize)));
  return {
    schema,
    table,
    sort: state.sorting.map((s) => ({ column: s.id, dir: s.desc ? 'desc' : 'asc' })),
    filters: state.filters,
    search: state.search || undefined,
    limit,
    offset: Math.max(0, Math.trunc(state.pageIndex)) * limit,
  };
}
export function parseWidths(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 64 && v <= 1200,
    ),
  );
}
export function widthKey(scope: string, table: string) {
  return 'straton:columns:' + JSON.stringify([scope, table]);
}
