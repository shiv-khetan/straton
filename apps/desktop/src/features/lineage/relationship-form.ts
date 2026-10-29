import type { Dataset, Relationship } from '../../lib/api.ts';

export function relationshipInput(
  datasets: Dataset[],
  source: string,
  from: string,
  target: string,
  to: string,
): Omit<Relationship, 'id'> {
  if (
    !datasets.some((d) => d.id === source && d.columns.some((c) => c.name === from)) ||
    !datasets.some((d) => d.id === target && d.columns.some((c) => c.name === to))
  )
    throw new Error('Choose an available source and target column.');
  if (source === target && from === to) throw new Error('Choose two different columns.');
  return {
    from_dataset: source,
    from_cols: [from],
    to_dataset: target,
    to_cols: [to],
    kind: 'manual',
    confidence: null,
  };
}

export function manualSelection(relationships: Relationship[], ids: string[]) {
  const selected = new Set(ids);
  return relationships.filter((r) => r.kind === 'manual' && selected.has(r.id));
}
