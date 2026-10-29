import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  BarChart,
  AreaChart,
  Line,
  Bar,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import type { ChartConfig, ChartData, ChartKind, SqlCell } from '@/lib/api';
import { ResultGrid } from '@/components/workbench/ResultGrid';
import { Button } from '@/components/ui/button';
import { chartRows } from './chart-model';
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// Timestamps arrive as ISO strings; midnight values read as days.
const label = (v: unknown, full = false) =>
  typeof v === 'string' && isoTime.test(v)
    ? (full && !/T00:00(:00)?/.test(v) ? stamp : day).format(new Date(v))
    : String(v);
const colors = [1, 2, 3, 4, 5].map((i) => 'var(--chart-' + i + ')');
export function ChartPreview({
  data,
  kind,
  config,
  scope,
  onDrill,
}: {
  data: ChartData;
  kind: ChartKind;
  config: ChartConfig;
  scope: string;
  onDrill?: (x: SqlCell) => void;
}) {
  const prepared = useMemo(() => chartRows(data, config), [data, config]);
  if (!data.rows.length)
    return (
      <p className="py-6 text-ink-2">The query returned no rows. Adjust the SQL or time range.</p>
    );
  const xIndex = data.columns.findIndex((c) => c.name === config.x);
  if (kind === 'table')
    return (
      <div className="space-y-2">
        <div className="h-72">
          <ResultGrid
            columns={data.columns}
            rows={data.rows}
            scope={scope}
            tableKey="chart-preview"
          />
        </div>
        {onDrill && xIndex >= 0 && (
          <details>
            <summary>Drill into a value</summary>
            <div className="max-h-48 overflow-auto">
              {[
                ...new Map(data.rows.map((r) => [JSON.stringify(r[xIndex]), r[xIndex]])).values(),
              ].map((value, index) => (
                <Button key={index} variant="link" onClick={() => onDrill(value)}>
                  {String(value ?? 'NULL')}
                </Button>
              ))}
            </div>
          </details>
        )}
      </div>
    );
  if (kind === 'stat') {
    const y = data.columns.findIndex((c) => c.name === config.y?.[0]);
    return (
      <div className="py-4">
        <p className="text-ink-2">{config.y?.[0] ?? 'Choose a value column'}</p>
        <output className="text-3xl font-semibold tabular-nums">
          {y < 0
            ? '—'
            : typeof data.rows[0][y] === 'number'
              ? number.format(data.rows[0][y] as number)
              : String(data.rows[0][y] ?? '—')}
        </output>
        {/* Drilling into the plotted value itself filters nothing useful. */}
        {onDrill && xIndex >= 0 && config.x !== config.y?.[0] && (
          <Button variant="link" onClick={() => onDrill(data.rows[0][xIndex])}>
            Drill into {String(data.rows[0][xIndex] ?? 'NULL')}
          </Button>
        )}
      </div>
    );
  }
  if (prepared.error)
    return (
      <p role="alert" className="py-6 text-danger">
        {prepared.error}
      </p>
    );
  if (!config.x || !prepared.keys.length)
    return (
      <p className="py-6 text-ink-2">
        Choose an x column and at least one numeric y column to plot.
      </p>
    );
  const Plot = kind === 'bar' ? BarChart : kind === 'area' ? AreaChart : LineChart;
  return (
    <div className="space-y-2">
      <div className="h-72 min-w-0" role="group" aria-label={kind + ' chart'}>
        <ResponsiveContainer width="100%" height="100%">
          <Plot
            data={prepared.rows}
            accessibilityLayer
            onClick={(state) => {
              const i = Number(state.activeTooltipIndex);
              if (onDrill && state.activeTooltipIndex != null && prepared.rows[i])
                onDrill(prepared.rows[i]._x);
            }}
          >
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis
              dataKey="_x"
              stroke="var(--ink-2)"
              tick={{ fontSize: 12 }}
              tickFormatter={(v) => label(v)}
            />
            <YAxis
              stroke="var(--ink-2)"
              tick={{ fontSize: 12 }}
              tickFormatter={(v) => (typeof v === 'number' ? compact.format(v) : String(v))}
            />
            <Tooltip
              cursor={{ fill: 'var(--primary-tint)', stroke: 'var(--line)' }}
              formatter={(v) => (typeof v === 'number' ? number.format(v) : String(v))}
              labelFormatter={(v) => label(v, true)}
              contentStyle={{
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                color: 'var(--ink)',
              }}
            />
            <Legend />
            {prepared.keys.map((key, i) =>
              kind === 'bar' ? (
                <Bar
                  key={key}
                  dataKey={key}
                  fill={colors[i % colors.length]}
                  isAnimationActive={false}
                />
              ) : kind === 'area' ? (
                <Area
                  key={key}
                  dataKey={key}
                  stroke={colors[i % colors.length]}
                  fill={colors[i % colors.length]}
                  fillOpacity={0.12}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  key={key}
                  dataKey={key}
                  stroke={colors[i % colors.length]}
                  dot={false}
                  isAnimationActive={false}
                />
              ),
            )}
          </Plot>
        </ResponsiveContainer>
      </div>
      <details>
        <summary>View values{onDrill ? ' and drill into a row' : ''}</summary>
        <div className="max-h-48 overflow-auto">
          <table className="w-full text-left text-caption">
            <thead>
              <tr>
                <th className="p-2">{config.x}</th>
                {prepared.keys.map((k) => (
                  <th className="p-2" key={k}>
                    {k}
                  </th>
                ))}
                {onDrill && <th>Details</th>}
              </tr>
            </thead>
            <tbody>
              {prepared.rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="p-2">{String(r._x ?? 'NULL')}</td>
                  {prepared.keys.map((k) => (
                    <td className="p-2 font-mono" key={k}>
                      {String(r[k] ?? '—')}
                    </td>
                  ))}
                  {onDrill && (
                    <td>
                      <Button size="sm" variant="link" onClick={() => onDrill(r._x)}>
                        Drill into {String(r._x ?? 'NULL')}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
