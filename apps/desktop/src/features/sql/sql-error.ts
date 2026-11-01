// Turn engine query errors into a headline, an optional suggestion and the cleaned detail.

export type SqlErrorView = { title: string; hint?: string; detail: string };

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length];
}
/** Closest candidate within a third of the name's length, or undefined. */
export function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let score = Infinity;
  for (const c of candidates) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d < score) [best, score] = [c, d];
  }
  return best && score > 0 && score <= Math.max(2, Math.ceil(name.length / 3)) ? best : undefined;
}
export function explainSqlError(
  raw: string,
  tables: { schema: string; name: string; columns?: { name: string }[] }[] = [],
): SqlErrorView {
  // "datafusion." is the engine's internal catalog name, not something users write.
  const detail = raw.replace(/\bdatafusion\./g, '').trim();
  const table = detail.match(/table '([^']+)' not found/i);
  if (table) {
    const name = table[1];
    const guess = closest(
      name,
      tables.map((t) => t.schema + '.' + t.name),
    );
    return {
      title: `Table ${name} doesn't exist`,
      hint: guess ? `Did you mean ${guess}?` : 'Check the Catalog panel for available tables.',
      detail,
    };
  }
  const column = detail.match(/No field named ([^\s.]+(?:\.[^\s.]+)*)/i);
  if (column) {
    const name = column[1].replace(/["`]/g, '');
    const short = name.split('.').pop()!;
    const guess = closest(short, [
      ...new Set(tables.flatMap((t) => (t.columns ?? []).map((c) => c.name))),
    ]);
    return {
      title: `Column ${short} doesn't exist`,
      hint: guess ? `Did you mean ${guess}?` : undefined,
      detail,
    };
  }
  if (/sql parser error|syntax error|expected/i.test(detail))
    return {
      title: 'The query has a syntax error',
      hint: 'Check the statement near the position below.',
      detail,
    };
  if (/timed out|timeout/i.test(detail))
    return {
      title: 'The query timed out',
      hint: 'Add filters or a LIMIT, or ask an admin to raise sql.query_timeout_secs.',
      detail,
    };
  if (/read-only|not allowed|DDL|DML/i.test(detail))
    return {
      title: 'Only read-only queries can run here',
      hint: 'Use Transformations to create tables or views.',
      detail,
    };
  return { title: 'The query failed', detail };
}
