import type { ImpactDirection, ImpactGraph } from '../../lib/api.ts';
export function impactPaths(
  graph: ImpactGraph,
  root: string,
  direction: ImpactDirection,
  depth = 50,
) {
  const nodes = new Set<string>();
  const edges = new Set<number>();
  if (!graph.nodes.some((n) => n.id === root)) return { nodes, edges };
  // Walk each direction independently so a sibling is not mistaken for an ancestor.
  for (const dir of direction === 'both' ? ['upstream', 'downstream'] : [direction]) {
    const seen = new Set([root]);
    const queue: [string, number][] = [[root, 0]];
    nodes.add(root);
    for (let i = 0; i < queue.length; i++) {
      const [id, level] = queue[i];
      if (level >= Math.min(50, Math.max(0, depth))) continue;
      graph.edges.forEach((edge, index) => {
        const next =
          dir === 'upstream'
            ? edge.to === id
              ? edge.from
              : null
            : edge.from === id
              ? edge.to
              : null;
        if (next === null) return;
        edges.add(index);
        nodes.add(next);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push([next, level + 1]);
        }
      });
    }
  }
  return { nodes, edges };
}
