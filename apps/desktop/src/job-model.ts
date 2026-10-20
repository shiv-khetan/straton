import type { Column, Run } from './api';
export function eligibleWatermarkColumns(columns: Column[]): Column[] {
  return columns.filter(
    (c) =>
      /^(?:U?Int(?:8|16|32|64)|Date(?:32|64))$/.test(c.type) || c.type.startsWith('Timestamp('),
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
