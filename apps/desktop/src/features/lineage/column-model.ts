import type { ColumnGraph, ColumnRef, ImpactDirection } from '../../lib/api.ts';
export const fieldKey = (field: ColumnRef) => JSON.stringify([field.dataset_id, field.column]);
export function columnPaths(
  graph: ColumnGraph,
  root: ColumnRef,
  direction: ImpactDirection = 'both',
  depth = 50,
) {
  const nodes = new Set([fieldKey(root)]);
  const edges = new Set<number>();
  for (const upstream of [true, false]) {
    if ((upstream && direction === 'downstream') || (!upstream && direction === 'upstream'))
      continue;
    const visited = new Set([fieldKey(root)]);
    const queue: [string, number][] = [[fieldKey(root), 0]];
    for (let i = 0; i < queue.length; i++) {
      const [current, distance] = queue[i];
      if (distance >= Math.max(0, Math.min(50, depth))) continue;
      graph.edges.forEach((edge, index) => {
        const at = fieldKey(upstream ? edge.to : edge.from);
        const next = fieldKey(upstream ? edge.from : edge.to);
        if (at !== current) return;
        edges.add(index);
        nodes.add(next);
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([next, distance + 1]);
        }
      });
    }
  }
  return { nodes, edges };
}
// Order branches source to target; retain cycle edges once instead of recursing forever.
export function columnHops(graph: ColumnGraph) {
  const pending = new Set(graph.edges.map((_, index) => index));
  const result: number[] = [];
  while (pending.size) {
    let progress = false;
    for (const index of pending) {
      const from = fieldKey(graph.edges[index].from);
      if ([...pending].some((i) => fieldKey(graph.edges[i].to) === from)) continue;
      result.push(index);
      pending.delete(index);
      progress = true;
    }
    if (!progress) {
      result.push(...pending);
      break;
    }
  }
  return result;
}
export function nextFieldIndex(index: number, length: number, key: string) {
  if (length < 1) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  const delta =
    key === 'ArrowDown' || key === 'ArrowRight'
      ? 1
      : key === 'ArrowUp' || key === 'ArrowLeft'
        ? -1
        : 0;
  return (index + delta + length) % length;
}
