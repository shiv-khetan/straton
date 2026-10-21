import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  Panel,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useViewport,
} from '@xyflow/react';
import type { Node, NodeProps, Edge } from '@xyflow/react';
import type { Dataset, Job, Run, Relationship, Model, ModelLineage } from './api';
import { datasetState, datasetRun, statusChip } from './workbench-model';
import { Button, Icon, Pill } from './ui';
import { StatusChip } from './Workbench';
import { datasetLabel, relativeTime } from './view-model';
import { tableSize } from './map-model';
import { modelGraph } from './model-model';
export type ModelSelection = { model?: Model; dataset?: Dataset };
type GraphNode = Node<
  ModelSelection & { dimmed?: boolean; state?: string; batches?: number; foreignKeys?: string[] },
  'entity'
>;
function Entity({ data }: NodeProps<GraphNode>) {
  const model = data.model;
  const dataset = data.dataset;
  const state =
    data.state ??
    (model
      ? model.status === 'broken'
        ? 'failed'
        : model.materialization === 'view'
          ? 'inlined'
          : (model.last_run_status ?? model.status)
      : dataset?.stale
        ? 'stale'
        : dataset?.last_synced_at
          ? 'succeeded'
          : 'never synced');
  const name = model?.name ?? datasetLabel(dataset);
  return (
    <article
      className={'dataset-node model-node state-' + statusChip(state).state.replaceAll(' ', '-')}
      style={{ opacity: data.dimmed ? 0.35 : 1 }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="dataset-title">
        <div className="node-heading-row">
          <Icon name={model ? 'model' : 'table'} />
          <strong title={name}>{name}</strong>
        </div>
        <div className="node-state-row">
          <StatusChip state={state} />
        </div>
      </div>
      {model ? (
        <div className="model-node-body">
          <span>Materialization</span>
          <code>{model.materialization}</code>
          <span>Trigger</span>
          <code title={model.cron ?? undefined}>{model.trigger}</code>
        </div>
      ) : (
        dataset?.columns?.map((column) => (
          <div className="dataset-column" key={column.name} style={{ height: 28 }}>
            <span className="column-name" title={column.name}>
              {column.name}
            </span>
            <span className="column-type" title={column.type}>
              {column.type}
              {column.nullable ? '?' : ''}
            </span>
            <span className="column-badges">
              {column.pk && <Pill tone="primary">PK</Pill>}
              {data.foreignKeys?.includes(column.name) && <Pill title="Foreign key">FK</Pill>}
              {column.masked && <Pill title={column.mask_kind ?? 'Column mask'}>Masked</Pill>}
            </span>
          </div>
        ))
      )}
      {state === 'running' && (
        <div
          className="node-progress"
          role="status"
          aria-label={
            data.batches === undefined
              ? 'Running; progress total unavailable'
              : data.batches + ' committed batches; total unavailable'
          }
        >
          <span className="indeterminate-progress" />
        </div>
      )}
      <div className="dataset-footer">
        <span>{(model?.row_count ?? dataset?.row_count)?.toLocaleString() ?? '—'} rows</span>
        <span>
          {relativeTime(model?.last_run ? model.last_run * 1000 : dataset?.last_synced_at)}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
const nodeTypes = { entity: Entity };
type CanvasProps = {
  models: Model[];
  lineages: Record<string, ModelLineage>;
  jobs: Job[];
  runs: Run[];
  relationships: Relationship[];
  onSelect: (selection: ModelSelection | null) => void;
};
export default function ModelCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
function Canvas({ models, lineages, jobs, runs, relationships, onSelect }: CanvasProps) {
  const graph = useMemo(() => modelGraph(models, lineages), [models, lineages]);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [minimap, setMinimap] = useState(true);
  const [filter, setFilter] = useState('');
  const [hoveredEdge, setHoveredEdge] = useState('');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();
  useEffect(() => {
    let active = true;
    void import('elkjs/lib/elk.bundled.js')
      .then(async ({ default: ELK }) => {
        const layout = await new ELK().layout({
          id: 'root',
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.spacing.nodeNode': '64',
            'elk.layered.spacing.nodeNodeBetweenLayers': '96',
          },
          children: graph.nodes.map((n) => ({
            id: n.id,
            ...(n.dataset ? tableSize(n.dataset) : { width: 256, height: 168 }),
          })),
          edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
        });
        if (!active) return;
        setNodes((previous) =>
          graph.nodes.map((n) => {
            const placed = layout.children?.find((c) => c.id === n.id);
            return {
              id: n.id,
              type: 'entity',
              selected: previous.find((node) => node.id === n.id)?.selected ?? false,
              data: { model: n.model, dataset: n.dataset },
              position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
              ariaLabel: n.model ? 'Model ' + n.model.name : 'Dataset ' + datasetLabel(n.dataset),
              style: n.dataset ? tableSize(n.dataset) : { width: 256, height: 168 },
            };
          }),
        );
        setEdges(
          graph.edges.map((e) => ({
            ...e,
            type: 'smoothstep',
            animated: true,
            className: graph.nodes.some(
              (node) =>
                (node.id === e.source || node.id === e.target) &&
                node.model?.last_run_status === 'running',
            )
              ? 'edge-active'
              : '',
            ariaLabel: 'Model lineage',
            style: { stroke: 'var(--edge-lineage)', strokeWidth: 1.5, strokeDasharray: '8 3' },
            markerEnd: {
              type: 'arrowclosed' as const,
              width: 12,
              height: 12,
              color: 'var(--edge-lineage)',
            },
          })),
        );
        setError('');
        requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1 }));
      })
      .catch((e) => {
        if (active) setError('Cannot arrange models: ' + String(e));
      });
    return () => {
      active = false;
    };
  }, [graph, revision, setNodes, setEdges, fitView]);
  const state = (node: GraphNode) =>
    node.data.model
      ? node.data.model.status === 'broken'
        ? 'failed'
        : node.data.model.materialization === 'view'
          ? 'inlined'
          : (node.data.model.last_run_status ?? node.data.model.status)
      : node.data.dataset
        ? datasetState(node.data.dataset, jobs, runs)
        : 'never synced';
  const handleSelection = useCallback(
    ({ nodes: selected }: { nodes: GraphNode[] }) => onSelect(selected[0]?.data ?? null),
    [onSelect],
  );
  const visibleNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          state: state(n),
          foreignKeys: n.data.dataset
            ? relationships
                .filter(
                  (edge) => edge.kind === 'declared_fk' && edge.from_dataset === n.data.dataset?.id,
                )
                .flatMap((edge) => edge.from_cols)
            : [],
          batches: n.data.dataset
            ? datasetRun(n.data.dataset, jobs, runs)?.committed_batches
            : undefined,
          dimmed: !!filter && statusChip(state(n)).state !== filter,
        },
      })),
    [nodes, filter, jobs, runs, relationships],
  );
  const visibleEdges = edges.map((edge) => {
    const active =
      !!filter ||
      edge.selected ||
      hoveredEdge === edge.id ||
      nodes.some(
        (node) =>
          (node.id === edge.source || node.id === edge.target) &&
          (node.selected || state(node) === 'running'),
      );
    const stroke = active ? 'var(--edge-lineage)' : 'var(--edge-quiet)';
    return {
      ...edge,
      style: { ...edge.style, stroke },
      markerEnd: { type: 'arrowclosed' as const, width: 12, height: 12, color: stroke },
    };
  });
  return (
    <div className="map-canvas" role="region" aria-label="Model DAG canvas">
      {error && (
        <p role="alert" className="map-feedback error">
          {error}
        </p>
      )}
      <ReactFlow<GraphNode>
        nodes={visibleNodes}
        edges={visibleEdges}
        onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
        onEdgeMouseLeave={() => setHoveredEdge('')}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={handleSelection}
        nodesConnectable={false}
        deleteKeyCode={null}
        fitView
        minZoom={0.1}
        maxZoom={2}
      >
        <Background gap={24} size={1} color="var(--grid-dot)" />
        <Panel position="top-left" className="map-legend">
          {['succeeded', 'running', 'queued', 'stale', 'failed', 'never synced', 'inlined'].map(
            (value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(filter === value ? '' : value)}
              >
                <StatusChip state={value} />
                <code>{nodes.filter((n) => statusChip(state(n)).state === value).length}</code>
              </button>
            ),
          )}
        </Panel>
        <Panel position="top-right" className="map-tools">
          <Button aria-label="Zoom in" onClick={() => void zoomIn()}>
            <Icon name="plus" />
          </Button>
          <Button aria-label="Zoom out" onClick={() => void zoomOut()}>
            <Icon name="minus" />
          </Button>
          <Button aria-label="Fit model graph" onClick={() => void fitView({ padding: 0.2 })}>
            <Icon name="fit" />
          </Button>
          <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
          <Button aria-label="Re-layout models" onClick={() => setRevision((v) => v + 1)}>
            <Icon name="refresh" />
          </Button>
          <Button
            aria-label="Toggle minimap"
            aria-pressed={minimap}
            onClick={() => setMinimap(!minimap)}
          >
            <Icon name="map" />
          </Button>
        </Panel>
        {minimap && <MiniMap pannable zoomable nodeColor="var(--surface-3)" />}
      </ReactFlow>
    </div>
  );
}
