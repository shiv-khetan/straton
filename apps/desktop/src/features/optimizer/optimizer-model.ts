import type { AdvisorRecommendation, AdvisorSource } from '../../lib/api.ts';
export function applyReason(
  r: AdvisorRecommendation,
  source: AdvisorSource | undefined,
  admin: boolean,
  offline: boolean,
): string {
  if (!admin) return 'Admin access is required.';
  if (offline) return 'Reconnect the engine before applying changes.';
  if (!source?.advisor_may_write)
    return 'Advisor may write is off. Enable it in Connections to approve source changes.';
  if (!r.applicable) return 'Advice only. Review this change with your DBA.';
  if (r.status !== 'open') return 'Only an open recommendation can be applied.';
  return '';
}
export function canRollback(r: AdvisorRecommendation): boolean {
  return r.status === 'applied' || (r.status === 'failed' && r.applied_at !== null);
}
export function rankRecommendations(rows: AdvisorRecommendation[]): AdvisorRecommendation[] {
  return [...rows].sort(
    (a, b) => b.estimated_benefit - a.estimated_benefit || a.id.localeCompare(b.id),
  );
}
// "CREATE INDEX [ix] ON [sales].[orders] ([customer_id], [status])" -> ["customer_id", "status"]
export function indexColumns(ddl: string): string[] {
  const m = /\bON\s+[^(]+\(([^)]*)\)/i.exec(ddl);
  return m
    ? m[1].split(',').map((c) =>
        c
          .trim()
          .replace(/\s+(ASC|DESC)$/i, '')
          .replace(/^\[|\]$/g, ''),
      )
    : [];
}
// One readable sentence per piece of workload evidence; the raw JSON stays one click away.
export function evidenceSummary(e: Record<string, unknown>): string[] {
  const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : null);
  const out: string[] = [];
  if (n(e.observations))
    out.push(
      `${n(e.observations)} ${e.op ? String(e.op) + ' ' : ''}${e.role ? String(e.role).replace('_', ' ') : 'use'}${
        e.observations === 1 ? '' : 's'
      } seen in Straton's workload${n(e.rows_scanned) ? `, scanning ${n(e.rows_scanned)} rows` : ''}.`,
    );
  const t = e.source_table as Record<string, unknown> | undefined;
  if (t && typeof t === 'object')
    out.push(
      `Source table ${[t.schema, t.table].filter(Boolean).join('.')}${n(t.rows) ? ` holds ${n(t.rows)} rows` : ''}${
        n(t.modifications)
          ? ` with ${n(t.modifications)} modifications since its statistics were updated`
          : ''
      }.`,
    );
  if (Array.isArray(e.metadata_warnings) && e.metadata_warnings.length)
    out.push(`Warnings: ${e.metadata_warnings.join('; ')}.`);
  return out;
}
