import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { ELK } from 'elkjs/lib/elk-api';
import type { DataMap, Dataset, EdgeKind, MapSource } from './api';
export type TableData = { dataset: Dataset; fk: string[]; highlighted: boolean };
export type TableNode = Node<TableData, 'table'>;
export type GroupNode = Node<{ label: string; external: boolean }, 'source'>;
export type MapNode = TableNode | GroupNode;
export type MapEdge = Edge<{ relationshipId: string; kind: EdgeKind; description: string }>;
let elkPromise: Promise<ELK> | undefined;
function storageKey(url: string) {
  return 'straton:map:v1:' + url;
}
export function loadPositions(url: string): Record<string, XYPosition> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(url)) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, XYPosition] => {
        const p: unknown = entry[1];
        return (
          typeof p === 'object' &&
          p !== null &&
          'x' in p &&
          'y' in p &&
          typeof p.x === 'number' &&
          Number.isFinite(p.x) &&
          typeof p.y === 'number' &&
          Number.isFinite(p.y)
        );
      }),
    );
  } catch {
    return {};
  }
}
export function persist(url: string, nodes: MapNode[]) {
  try {
    localStorage.setItem(
      storageKey(url),
      JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, n.position]))),
    );
  } catch {
    /* Layout still works when storage is unavailable. */
  }
}
export async function layout(map: DataMap): Promise<MapNode[]> {
  const sources = map.nodes.filter((n): n is MapSource => n.type === 'source');
  const datasets = map.nodes.filter((n): n is Dataset => n.type === 'dataset');
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK());
  const elk = await elkPromise;
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '70',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    },
    children: sources.map((source) => ({
      id: source.id,
      layoutOptions: {
        'elk.padding': '[top=60,left=30,bottom=30,right=30]',
        'elk.algorithm': 'layered',
      },
      children: datasets
        .filter((d) => d.source_id === source.id)
        .map((d) => ({ id: d.id, width: 320, height: 48 + d.columns.length * 32 })),
    })),
    edges: map.edges
      .filter(
        (e) =>
          datasets.some((d) => d.id === e.from_dataset) &&
          datasets.some((d) => d.id === e.to_dataset),
      )
      .map((e) => ({ id: e.id, sources: [e.from_dataset], targets: [e.to_dataset] })),
  });
  const nodes: MapNode[] = [];
  for (const group of graph.children || []) {
    const source = sources.find((s) => s.id === group.id)!;
    nodes.push({
      id: source.id,
      type: 'source',
      position: { x: group.x || 0, y: group.y || 0 },
      data: { label: source.name, external: !source.connected },
      style: { width: Math.max(group.width || 0, 380), height: Math.max(group.height || 0, 120) },
      className: source.connected ? 'source-group' : 'source-group external-group',
      connectable: false,
    });
    for (const child of group.children || []) {
      const dataset = datasets.find((d) => d.id === child.id)!;
      nodes.push({
        id: dataset.id,
        type: 'table',
        parentId: source.id,
        extent: 'parent',
        position: { x: child.x || 30, y: child.y || 60 },
        data: {
          dataset,
          fk: map.edges
            .filter((e) => e.kind === 'declared_fk' && e.from_dataset === dataset.id)
            .flatMap((e) => e.from_cols),
          highlighted: false,
        },
        style: { width: 320 },
      });
    }
  }
  return nodes;
}

const colors: Record<EdgeKind, string> = {
  declared_fk: 'var(--edge-fk)',
  inferred: 'var(--edge-inferred)',
  lineage: 'var(--edge-lineage)',
  manual: 'var(--edge-manual)',
};
export function buildEdges(map: DataMap): MapEdge[] {
  const datasets = new Map(
    map.nodes
      .filter((node): node is Dataset => node.type === 'dataset')
      .map((node) => [node.id, node]),
  );
  function handle(datasetId: string, column: string | undefined, direction: 'in' | 'out') {
    return column !== undefined && datasets.get(datasetId)?.columns.some((c) => c.name === column)
      ? direction + ':' + column
      : 'dataset:' + direction;
  }
  return map.edges.flatMap((relationship) => {
    if (!datasets.has(relationship.from_dataset) || !datasets.has(relationship.to_dataset))
      return [];
    const pairs = relationship.from_cols.length
      ? relationship.from_cols.map((from, index) => ({ from, to: relationship.to_cols[index] }))
      : [{ from: undefined, to: undefined }];
    return pairs.map((pair, index): MapEdge => ({
      id: relationship.id + ':' + index,
      source: relationship.from_dataset,
      target: relationship.to_dataset,
      sourceHandle: handle(relationship.from_dataset, pair.from, 'out'),
      targetHandle: handle(relationship.to_dataset, pair.to, 'in'),
      animated: relationship.kind === 'lineage',
      deletable: false,
      ariaLabel: relationship.kind.replaceAll('_', ' ') + ' relationship',
      data: {
        relationshipId: relationship.id,
        kind: relationship.kind,
        description:
          relationship.kind.replaceAll('_', ' ') +
          (relationship.confidence === null
            ? ''
            : ' · ' + Math.round(relationship.confidence * 100) + '% confidence'),
      },
      style: {
        stroke: colors[relationship.kind],
        strokeWidth: relationship.kind === 'manual' ? 3 : 2,
        strokeDasharray: relationship.kind === 'inferred' ? '6 5' : undefined,
      },
      markerEnd: { type: 'arrowclosed', color: colors[relationship.kind] },
    }));
  });
}
