import { useMemo } from 'react';
import type { Api, ColumnRef, DataMap, EdgeKind, Job, MapSource, Run } from '@/lib/api';
import { datasetRun, datasetState } from '@/features/console/workbench-model';
import { datasetLabel } from '@/lib/view-model';
import { fieldKey } from './column-model';
import { edgeKinds, routeEdges } from './map-model';
import type { MapEdge, MapNode } from './map-model';

export type MapFilters = {
  excluded: string[];
  sourceFilter: string;
  stateFilter: string;
  enabledKinds: EdgeKind[];
  search: string;
};

type FieldGraph = Awaited<ReturnType<Api['columnLineage']>>;

// Derives what React Flow renders from the laid-out graph: filter visibility, run state,
// search highlight, field-trace dimming, edge emphasis, and the traced field edges on top.
export function useVisibleGraph({
  nodes,
  edges,
  map,
  jobs,
  runs,
  filters: { excluded, sourceFilter, stateFilter, enabledKinds, search },
  fieldFocus,
  fieldGraph,
  hoveredEdge,
  onFieldFocus,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  map: DataMap;
  jobs: Job[];
  runs: Run[];
  filters: MapFilters;
  fieldFocus: ColumnRef | null;
  fieldGraph: FieldGraph | undefined;
  hoveredEdge: string;
  onFieldFocus: (dataset_id: string, column: string) => void;
}) {
  const query = search.trim().toLowerCase();
  const pathFields = useMemo(
    () =>
      new Set([
        ...(fieldGraph?.nodes.map(fieldKey) ?? []),
        ...(fieldFocus ? [fieldKey(fieldFocus)] : []),
      ]),
    [fieldGraph, fieldFocus],
  );
  const pathDatasets = useMemo(
    () =>
      new Set([
        ...(fieldGraph?.nodes.map((n) => n.dataset_id) ?? []),
        ...(fieldFocus ? [fieldFocus.dataset_id] : []),
      ]),
    [fieldGraph, fieldFocus],
  );
  const visibleNodes = useMemo(
    () =>
      nodes.map(
        (node) =>
          ({
            ...node,
            hidden:
              !fieldFocus &&
              (excluded.includes(node.id) ||
                (!!node.parentId && excluded.includes(node.parentId)) ||
                (!!sourceFilter &&
                  (node.type === 'source'
                    ? node.id !== sourceFilter
                    : node.parentId !== sourceFilter))),
            style: {
              ...node.style,
              opacity:
                fieldFocus && node.type === 'table' && !pathDatasets.has(node.id)
                  ? 0.22
                  : node.type === 'table' &&
                      stateFilter &&
                      datasetState(node.data.dataset, jobs, runs) !== stateFilter
                    ? 0.35
                    : 1,
            },
            data:
              node.type === 'table'
                ? {
                    ...node.data,
                    focusActive: !!fieldFocus,
                    fieldFocus: fieldFocus?.dataset_id === node.id ? fieldFocus.column : undefined,
                    fieldPath: node.data.dataset.columns
                      .filter((c) =>
                        pathFields.has(fieldKey({ dataset_id: node.id, column: c.name })),
                      )
                      .map((c) => c.name),
                    onFieldFocus,
                    state: datasetState(node.data.dataset, jobs, runs),
                    batches: datasetRun(node.data.dataset, jobs, runs)?.committed_batches,
                    external: !(
                      map.nodes.find((n) => n.id === node.data.dataset.source_id) as
                        MapSource | undefined
                    )?.connected,
                    highlighted:
                      !!query && datasetLabel(node.data.dataset).toLowerCase().includes(query),
                  }
                : node.data,
          }) as MapNode,
      ),
    [
      nodes,
      sourceFilter,
      query,
      excluded,
      stateFilter,
      map,
      jobs,
      runs,
      fieldFocus,
      pathDatasets,
      pathFields,
      onFieldFocus,
    ],
  );
  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(visibleNodes.filter((n) => !n.hidden).map((n) => n.id));
    const activeNodes = new Set(
      visibleNodes
        .filter((node) => node.type === 'table' && node.data.state === 'running')
        .map((node) => node.id),
    );
    // Any active filter or search shows every edge in its kind colour; otherwise edges stay quiet.
    const filtering =
      enabledKinds.length !== edgeKinds.length ||
      !!sourceFilter ||
      excluded.length > 0 ||
      !!search ||
      !!stateFilter;
    return routeEdges(edges, nodes).map((edge) => {
      const active = activeNodes.has(edge.source) || activeNodes.has(edge.target);
      const emphasized = filtering || active || hoveredEdge === edge.id || !!edge.selected;
      return {
        ...edge,
        className:
          'edge-kind-' +
          edge.data!.kind +
          (edge.data?.kind === 'lineage' && active ? ' edge-active' : ''),
        style: {
          ...edge.style,
          opacity: fieldFocus ? 0.12 : 1,
          stroke: emphasized ? edge.style?.stroke : 'var(--edge-quiet)',
        },
        markerEnd: {
          type: 'arrowclosed' as const,
          width: 12,
          height: 12,
          color: emphasized ? String(edge.style?.stroke) : 'var(--edge-quiet)',
        },
        label: hoveredEdge === edge.id ? edge.data?.description : undefined,
        labelStyle: { fill: 'var(--ink)' },
        labelBgStyle: { fill: 'var(--bg)' },
        hidden:
          !enabledKinds.includes(edge.data!.kind) ||
          !visibleIds.has(edge.source) ||
          !visibleIds.has(edge.target),
      };
    });
  }, [
    edges,
    nodes,
    visibleNodes,
    hoveredEdge,
    enabledKinds,
    sourceFilter,
    excluded,
    search,
    stateFilter,
    fieldFocus,
  ]);
  const focusedEdges = useMemo<MapEdge[]>(
    () =>
      (fieldGraph?.edges ?? []).map((edge, index) => ({
        id: 'field:' + index,
        source: edge.from.dataset_id,
        target: edge.to.dataset_id,
        sourceHandle: 'out:' + edge.from.column,
        targetHandle: 'in:' + edge.to.column,
        type: 'smoothstep',
        zIndex: 4,
        deletable: false,
        selectable: false,
        ariaLabel: edge.from.column + ' to ' + edge.to.column + ': ' + edge.kind,
        className: 'field-lineage-edge',
        data: { relationshipId: 'field:' + index, kind: 'lineage', description: edge.kind },
        style: { stroke: 'var(--primary)', strokeWidth: 2 },
        markerEnd: { type: 'arrowclosed', color: 'var(--primary)' },
      })),
    [fieldGraph],
  );
  const renderedEdges = useMemo(
    () => [...visibleEdges, ...focusedEdges],
    [visibleEdges, focusedEdges],
  );
  return { nodes: visibleNodes, edges: renderedEdges };
}
