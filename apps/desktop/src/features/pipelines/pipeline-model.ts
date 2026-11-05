import type { PipelineInput, PipelineValidation } from '../../lib/api.ts';
export function graphValidation(graph: PipelineInput): PipelineValidation {
  const errors: PipelineValidation['errors'] = [];
  if (!graph.name.trim()) errors.push({ message: 'Enter a pipeline name.' });
  if (!graph.nodes.length) errors.push({ message: 'Add at least one node.' });
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.node_id || ids.has(n.node_id))
      errors.push({ node_id: n.node_id, message: 'Node IDs must be unique.' });
    if (!n.ref_id) errors.push({ node_id: n.node_id, message: 'Choose a reference.' });
    ids.add(n.node_id);
  }
  const degree = new Map([...ids].map((id) => [id, 0]));
  const edges = new Set<string>();
  for (const e of graph.edges) {
    const key = JSON.stringify([e.from_node, e.to_node]);
    if (!ids.has(e.from_node) || !ids.has(e.to_node)) {
      errors.push({ node_id: e.to_node, message: 'Edge references a missing node.' });
      continue;
    }
    if (edges.has(key)) {
      errors.push({ node_id: e.to_node, message: 'Duplicate edge.' });
      continue;
    }
    edges.add(key);
    if (e.from_node === e.to_node)
      errors.push({ node_id: e.to_node, message: 'Self-edges are forbidden.' });
    degree.set(e.to_node, degree.get(e.to_node)! + 1);
  }
  const ready = [...degree].filter(([, d]) => d === 0).map(([id]) => id);
  let count = 0;
  while (ready.length) {
    const id = ready.pop()!;
    count++;
    for (const key of edges) {
      const [from, to] = JSON.parse(key) as string[];
      if (from === id) {
        degree.set(to, degree.get(to)! - 1);
        if (degree.get(to) === 0) ready.push(to);
      }
    }
  }
  if (count !== ids.size) {
    errors.push({ message: 'Graph contains a cycle.' });
    for (const [node_id, remaining] of degree)
      if (remaining > 0)
        errors.push({ node_id, message: 'Node is part of, or blocked by, a cycle.' });
  }
  return { valid: errors.length === 0, errors };
}
export function dependencyError(graph: PipelineInput, from: string, to: string): string {
  if (
    !graph.nodes.some((node) => node.node_id === from) ||
    !graph.nodes.some((node) => node.node_id === to)
  )
    return 'Choose both dependency nodes.';
  if (from === to) return 'A node cannot depend on itself.';
  if (graph.edges.some((edge) => edge.from_node === from && edge.to_node === to))
    return 'This dependency already exists.';
  const candidate = { ...graph, edges: [...graph.edges, { from_node: from, to_node: to }] };
  return graphValidation(candidate).errors.some(
    (error) => error.message === 'Graph contains a cycle.',
  )
    ? 'This dependency would create a cycle.'
    : '';
}

export function selectionChange(
  current: string,
  changes: { type: string; id?: string; selected?: boolean }[],
): string {
  for (const change of changes) {
    if (change.type !== 'select' || !change.id) continue;
    if (change.selected) current = change.id;
    else if (current === change.id) current = '';
  }
  return current;
}

export function validationDisplay(graph: PipelineInput, validation: PipelineValidation) {
  return {
    global: validation.errors.filter((e) => !e.node_id).map((e) => e.message),
    nodes: Object.fromEntries(
      graph.nodes.map((n) => [
        n.node_id,
        validation.errors.filter((e) => e.node_id === n.node_id).map((e) => e.message),
      ]),
    ) as Record<string, string[]>,
  };
}
// Graphs created through the API may carry no positions; lay those out by longest-path layer.
export function placeNodes<T extends Pick<PipelineInput, 'nodes' | 'edges'>>(graph: T): T {
  const seen = new Set(graph.nodes.map((n) => n.x + ',' + n.y));
  if (seen.size === graph.nodes.length) return graph;
  const layer = new Map(graph.nodes.map((n) => [n.node_id, 0]));
  // ponytail: n relaxation passes, fine for pipeline-sized graphs; cycles are rejected on save.
  for (let i = 0; i < graph.nodes.length; i++)
    for (const e of graph.edges)
      layer.set(e.to_node, Math.max(layer.get(e.to_node) ?? 0, (layer.get(e.from_node) ?? 0) + 1));
  const rows = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const l = layer.get(n.node_id) ?? 0;
      const row = rows.get(l) ?? 0;
      rows.set(l, row + 1);
      return { ...n, x: l * 300, y: row * 170 };
    }),
  };
}

// idle: the graph at rest (editor) · flowing: data is moving across this hop now
// done: both ends finished · blocked: the upstream failed or the hop was skipped
export type FlowState = 'idle' | 'flowing' | 'done' | 'blocked';

export function flowState(from?: string, to?: string): FlowState {
  if (from === 'failed' || to === 'skipped' || to === 'cancelled') return 'blocked';
  if (from === 'succeeded' && to === 'succeeded') return 'done';
  if (from === 'running' || (from === 'succeeded' && (to === 'running' || to === 'pending')))
    return 'flowing';
  return 'idle';
}
/** Steps in run order (dependencies first; ties keep editor order), each with the labels of
 *  the steps it waits for. Steps caught in a cycle come last, flagged. */
export function stepOrder(graph: Pick<PipelineInput, 'nodes' | 'edges'>): {
  node_id: string;
  label: string;
  kind: string;
  after: string[];
  cyclic: boolean;
}[] {
  const ids = graph.nodes.map((n) => n.node_id);
  const label = (id: string) => graph.nodes.find((n) => n.node_id === id)?.label || id;
  const parents = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of graph.edges)
    if (parents.has(e.to_node) && parents.has(e.from_node) && e.from_node !== e.to_node)
      parents.get(e.to_node)!.push(e.from_node);
  const done = new Set<string>();
  const order: string[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const id of ids)
      if (!done.has(id) && parents.get(id)!.every((p) => done.has(p))) {
        done.add(id);
        order.push(id);
        progress = true;
      }
  }
  const cyclic = ids.filter((id) => !done.has(id));
  return [...order, ...cyclic].map((id) => ({
    node_id: id,
    label: label(id),
    kind: graph.nodes.find((n) => n.node_id === id)?.kind ?? '',
    after: [...new Set(parents.get(id)!)].map(label),
    cyclic: !done.has(id),
  }));
}
