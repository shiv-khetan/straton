import type { SqlCell } from './api';
export function tableReference(schema: string, table: string): string {
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  return quote(schema) + '.' + quote(table);
}
export function cellText(value: SqlCell): string {
  return value === null ? 'NULL' : String(value);
}
