import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { ELK, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { DataMap, Dataset, EdgeKind, MapSource } from './api';
type LayoutData = { layoutPosition?: XYPosition };
export type TableData = LayoutData & { dataset: Dataset; fk: string[]; highlighted: boolean };
export type TableNode = Node<TableData, 'table'>;
export type GroupNode = Node<LayoutData & { label: string; external: boolean }, 'source'>;
export type MapNode = TableNode | GroupNode;
export type MapEdge = Edge<{
  relationshipId: string;
  kind: EdgeKind;
  description: string;
  route?: XYPosition[][];
}>;
export const TABLE_HEADER_HEIGHT = 48;
export const TABLE_ROW_HEIGHT = 32;
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
let textContext: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, header = false) {
  textContext ??=
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!textContext) return Array.from(text).length * (header ? 9 : 8);
  textContext.font = header
    ? '650 14px "Segoe UI", system-ui, sans-serif'
    : '12px "Segoe UI", system-ui, sans-serif';
  return textContext.measureText(text).width;
}
export function tableSize(dataset: Dataset) {
  return {
    width: Math.ceil(
      Math.max(
        320,
        textWidth(dataset.display_name ?? dataset.name, true) + 28 + (dataset.stale ? 60 : 0),
        ...dataset.columns.map(
          (column) =>
            textWidth(column.name) + textWidth(column.type + (column.nullable ? '?' : '')) + 88,
        ),
      ),
    ),
    height: TABLE_HEADER_HEIGHT + dataset.columns.length * TABLE_ROW_HEIGHT,
  };
}
function portId(datasetId: string, handle: string) {
  return JSON.stringify([datasetId, handle]);
}
const layoutOptions: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.spacing.nodeNode': '100',
  'elk.layered.spacing.nodeNodeBetweenLayers': '160',
  'elk.spacing.edgeNode': '28',
  'elk.layered.spacing.edgeNodeBetweenLayers': '36',
  'elk.spacing.edgeEdge': '18',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
  'elk.spacing.portPort': '0',
};
export function buildLayoutGraph(map: DataMap): ElkNode {
  const sources = map.nodes.filter((n): n is MapSource => n.type === 'source');
  const datasets = map.nodes.filter((n): n is Dataset => n.type === 'dataset');
  return {
    id: 'root',
    layoutOptions,
    children: sources.map((source) => ({
      id: source.id,
      layoutOptions: {
        ...layoutOptions,
        'elk.padding': '[top=96,left=64,bottom=64,right=64]',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum':
          '(' +
          Math.ceil(
            Math.max(380, textWidth(source.name, true) + 44 + (source.connected ? 0 : 80)),
          ) +
          ',160)',
      },
      children: datasets
        .filter((d) => d.source_id === source.id)
        .map((dataset) => {
          const size = tableSize(dataset);
          const rows = [
            { incoming: 'dataset:in', outgoing: 'dataset:out', y: 0, height: TABLE_HEADER_HEIGHT },
            ...dataset.columns.map((column, index) => ({
              incoming: 'in:' + column.name,
              outgoing: 'out:' + column.name,
              y: TABLE_HEADER_HEIGHT + index * TABLE_ROW_HEIGHT,
              height: TABLE_ROW_HEIGHT,
            })),
          ];
          return {
            id: dataset.id,
            ...size,
            layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' },
            // Row-sized ports fill each side, keeping FIXED_ORDER anchors at row centers.
            ports: rows.flatMap((row, index) => [
              {
                id: portId(dataset.id, row.incoming),
                x: 0,
                y: row.y,
                width: 0,
                height: row.height,
                layoutOptions: {
                  'elk.port.side': 'WEST',
                  'elk.port.index': String(2 * rows.length - 1 - index),
                },
              },
              {
                id: portId(dataset.id, row.outgoing),
                x: size.width,
                y: row.y,
                width: 0,
                height: row.height,
                layoutOptions: { 'elk.port.side': 'EAST', 'elk.port.index': String(index) },
              },
            ]),
          };
        }),
    })),
    edges: buildEdges(map).map((edge) => ({
      id: edge.id,
      sources: [portId(edge.source, edge.sourceHandle!)],
      targets: [portId(edge.target, edge.targetHandle!)],
    })),
  };
}
export function collectRoutes(graph: ElkNode): Record<string, XYPosition[][]> {
  const origins = new Map<string, XYPosition>();
  function index(node: ElkNode, parent: XYPosition) {
    const origin =
      node === graph
        ? { x: 0, y: 0 }
        : { x: parent.x + (node.x ?? 0), y: parent.y + (node.y ?? 0) };
    origins.set(node.id, origin);
    node.children?.forEach((child) => index(child, origin));
  }
  index(graph, { x: 0, y: 0 });
  const routes: Record<string, XYPosition[][]> = {};
  function visit(node: ElkNode) {
    for (const edge of node.edges ?? []) {
      // ELK may keep an edge on root.edges while naming a nested coordinate container.
      const origin = origins.get(edge.container ?? node.id);
      if (!origin || !edge.sections?.length) continue;
      routes[edge.id] = edge.sections.map((section) =>
        [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({
          x: point.x + origin.x,
          y: point.y + origin.y,
        })),
      );
    }
    node.children?.forEach(visit);
  }
  visit(graph);
  return routes;
}
export function routedEdgePath(sections: XYPosition[][]) {
  let label = sections[0]?.[0] ?? { x: 0, y: 0 };
  let longest = 0;
  const path = sections
    .map((section) => {
      const points = section.filter(
        (point, index) =>
          index === 0 || point.x !== section[index - 1].x || point.y !== section[index - 1].y,
      );
      if (points.length < 2) return '';
      let path = 'M ' + points[0].x + ' ' + points[0].y;
      for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1],
          point = points[i],
          next = points[i + 1];
        const length = Math.hypot(point.x - previous.x, point.y - previous.y);
        if (length > longest) {
          longest = length;
          label = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
        }
        if (!next) {
          path += ' L ' + point.x + ' ' + point.y;
          continue;
        }
        const after = Math.hypot(next.x - point.x, next.y - point.y);
        const radius = Math.min(6, length / 2, after / 2);
        const before = {
          x: point.x + ((previous.x - point.x) * radius) / length,
          y: point.y + ((previous.y - point.y) * radius) / length,
        };
        const beyond = {
          x: point.x + ((next.x - point.x) * radius) / after,
          y: point.y + ((next.y - point.y) * radius) / after,
        };
        path +=
          ' L ' +
          before.x +
          ' ' +
          before.y +
          ' Q ' +
          point.x +
          ' ' +
          point.y +
          ' ' +
          beyond.x +
          ' ' +
          beyond.y;
      }
      return path;
    })
    .join(' ');
  return { path, label };
}
export function restorePositions(nodes: MapNode[], saved: Record<string, XYPosition>): MapNode[] {
  return nodes.map((node) =>
    saved[node.id]
      ? ({
          ...node,
          position: saved[node.id],
          data: { ...node.data, layoutPosition: undefined },
        } as MapNode)
      : node,
  );
}
export function routeEdges(edges: MapEdge[], nodes: MapNode[]): MapEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  function unchanged(id: string): boolean {
    const node = byId.get(id);
    const original = node?.data.layoutPosition;
    return (
      !!node &&
      !!original &&
      original.x === node.position.x &&
      original.y === node.position.y &&
      (!node.parentId || unchanged(node.parentId))
    );
  }
  return edges.map((edge) => ({
    ...edge,
    type:
      edge.data?.route?.length && unchanged(edge.source) && unchanged(edge.target)
        ? 'elk'
        : 'smoothstep',
  }));
}
export async function layout(map: DataMap): Promise<{ nodes: MapNode[]; edges: MapEdge[] }> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK());
  const elk = await elkPromise;
  const graph = await elk.layout(buildLayoutGraph(map));
  const sources = map.nodes.filter((n): n is MapSource => n.type === 'source');
  const datasets = map.nodes.filter((n): n is Dataset => n.type === 'dataset');
  const nodes: MapNode[] = [];
  for (const group of graph.children || []) {
    const source = sources.find((s) => s.id === group.id)!;
    const position = { x: group.x ?? 0, y: group.y ?? 0 };
    nodes.push({
      id: source.id,
      type: 'source',
      position,
      data: { label: source.name, external: !source.connected, layoutPosition: position },
      style: { width: group.width, height: group.height },
      className: source.connected ? 'source-group' : 'source-group external-group',
      connectable: false,
      zIndex: 0,
    });
    for (const child of group.children || []) {
      const dataset = datasets.find((d) => d.id === child.id)!;
      const position = { x: child.x ?? 64, y: child.y ?? 96 };
      nodes.push({
        id: dataset.id,
        type: 'table',
        parentId: source.id,
        extent: 'parent',
        position,
        data: {
          dataset,
          fk: map.edges
            .filter((e) => e.kind === 'declared_fk' && e.from_dataset === dataset.id)
            .flatMap((e) => e.from_cols),
          highlighted: false,
          layoutPosition: position,
        },
        style: { width: child.width, height: child.height },
        zIndex: 1,
      });
    }
  }
  const routes = collectRoutes(graph);
  const edges = buildEdges(map).map((edge) => ({
    ...edge,
    data: { ...edge.data!, route: routes[edge.id] },
  }));
  return { nodes, edges: routeEdges(edges, nodes) };
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
      type: 'smoothstep',
      zIndex: 2,
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
