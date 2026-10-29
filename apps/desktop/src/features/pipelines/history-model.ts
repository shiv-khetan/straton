export const historyPageSize = 50;

// The engine exposes a latest-N limit, without an offset or a cursor.
export function historyPage<T>(runs: T[], page: number, size = historyPageSize) {
  const start = page * size;
  const rows = runs.slice(start, start + size);
  return { rows, first: rows.length ? start + 1 : 0, last: start + rows.length };
}
