import type { Column, Run } from '@/lib/api';
export function eligibleWatermarkColumns(columns: Column[], kind?: string): Column[] {
  if (kind === 'mongodb')
    return columns.filter(
      (c) => c.type.startsWith('Timestamp(') || (c.name === '_id' && c.type === 'Utf8'),
    );
  return columns.filter(
    (c) =>
      /^(?:U?Int(?:8|16|32|64)|Date(?:32|64))$/.test(c.type) ||
      c.type.startsWith('Timestamp(') ||
      c.type === 'FixedSizeBinary(8)',
  );
}
export function runStats(
  run: Pick<Run, 'rows_inserted' | 'rows_updated' | 'rows_deleted' | 'rows_read'>,
): string {
  return (
    '+' +
    run.rows_inserted.toLocaleString() +
    ' / ~' +
    run.rows_updated.toLocaleString() +
    ' / −' +
    run.rows_deleted.toLocaleString() +
    ' / ' +
    run.rows_read.toLocaleString() +
    ' rows read'
  );
}

export function hasIncrementalSettings(
  kind: string | undefined,
  watermark: string,
  keys: string[],
): boolean {
  return kind === 'stripe' || kind === 'salesforce' || Boolean(watermark && keys.length);
}
