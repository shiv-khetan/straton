import type { ChartConfig, ChartData, SqlCell } from '../../lib/api.ts';
export function chartRows(result: ChartData, config: ChartConfig) {
  const x = result.columns.findIndex((c) => c.name === config.x);
  const series = result.columns.findIndex((c) => c.name === config.series);
  const ys = (config.y ?? [])
    .map((name) => ({ name, index: result.columns.findIndex((c) => c.name === name) }))
    .filter((y) => y.index >= 0);
  const numeric = (value: SqlCell) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
        ? Number(value)
        : null;
  if (series < 0)
    return {
      keys: ys.map((y) => y.name),
      rows: result.rows.map(
        (r, i) =>
          Object.fromEntries([
            ['_x', x >= 0 ? r[x] : i],
            ...ys.map((y) => [y.name, numeric(r[y.index])]),
          ]) as Record<string, SqlCell>,
      ),
    };
  const keys = new Set<string>();
  const rows = new Map<string, Record<string, SqlCell>>();
  result.rows.forEach((r, i) => {
    const value = x >= 0 ? r[x] : i;
    const id = JSON.stringify(value);
    const row = rows.get(id) ?? { _x: value };
    for (const y of ys) {
      const key = series >= 0 ? y.name + ' · ' + String(r[series]) : y.name;
      keys.add(key);
      row[key] = numeric(r[y.index]);
    }
    rows.set(id, row);
  });
  return { rows: [...rows.values()], keys: [...keys] };
}
