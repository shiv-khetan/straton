import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  ConnectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { Connection as FlowConnection, NodeProps } from '@xyflow/react';
import type { Api, DataMap, EdgeKind } from './api';
import { Field } from './App';
import { buildEdges, layout, loadPositions, persist } from './map-model';
import type { MapNode, MapEdge, TableNode, GroupNode } from './map-model';
type Props = {
  map: DataMap;
  engineUrl: string;
  client: Api;
  action: (work: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
};
const kinds: EdgeKind[] = ['declared_fk', 'inferred', 'lineage', 'manual'];
function Table({ data }: NodeProps<TableNode>) {
  return (
    <article
      className={
        'dataset-node' +
        (data.dataset.stale ? ' stale' : '') +
        (data.highlighted ? ' highlighted' : '')
      }
    >
      <div className="dataset-title">
        <Handle type="target" position={Position.Left} id="dataset:in" isConnectable={false} />
        {data.dataset.display_name ?? data.dataset.name}
        <Handle type="source" position={Position.Right} id="dataset:out" isConnectable={false} />
        {data.dataset.stale && <span className="badge">Stale</span>}
      </div>
      {data.dataset.columns.map((column) => (
        <div className="dataset-column" key={column.name}>
          <Handle
            type="target"
            position={Position.Left}
            id={'in:' + column.name}
            aria-label={'Connect to ' + column.name}
          />
          <span className="column-name">{column.name}</span>
          <span className="column-type">
            {column.type}
            {column.nullable ? '?' : ''}
          </span>
          <span className="column-badges">
            {column.pk && <b title="Primary key">PK</b>}
            {data.fk.includes(column.name) && <b title="Foreign key">FK</b>}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={'out:' + column.name}
            aria-label={'Connect from ' + column.name}
          />
        </div>
      ))}
    </article>
  );
}
function SourceGroup({ data }: NodeProps<GroupNode>) {
  return (
    <div className={'source-label' + (data.external ? ' external-label' : '')}>
      {data.label}
      {data.external && <span> · external</span>}
    </div>
  );
}
const nodeTypes = { table: Table, source: SourceGroup };
export default function DataMapView(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
function Canvas({ map, engineUrl, client, action, busy }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapEdge>([]);
  const [sourceFilter, setSourceFilter] = useState('');
  const [enabledKinds, setEnabledKinds] = useState<EdgeKind[]>(kinds);
  const [search, setSearch] = useState('');
  const [hover, setHover] = useState('');
  const [hoveredEdge, setHoveredEdge] = useState('');
  const [layoutError, setLayoutError] = useState('');
  const [layingOut, setLayingOut] = useState(false);
  // Read Flow selection directly so its selection effect cannot feed back into local state.
  const selected = useMemo(
    () => edges.filter((edge) => edge.selected).map((edge) => edge.id),
    [edges],
  );
  const { fitView } = useReactFlow<MapNode, MapEdge>();
  const generation = useRef(0);
  const arrange = useCallback(
    async (restore: boolean) => {
      const current = ++generation.current;
      setLayingOut(true);
      setLayoutError('');
      try {
        const next = await layout(map);
        if (generation.current !== current) return;
        const saved = restore ? loadPositions(engineUrl) : {};
        for (const node of next) {
          if (saved[node.id]) node.position = saved[node.id];
        }
        setNodes(next);
        if (!restore) persist(engineUrl, next);
        requestAnimationFrame(() => {
          void fitView({ padding: 0.15 });
        });
      } catch {
        if (generation.current === current)
          setLayoutError('Layout failed. Try Re-layout or refresh the catalog.');
      } finally {
        if (generation.current === current) setLayingOut(false);
      }
    },
    [map, engineUrl, setNodes, fitView],
  );
  useEffect(() => {
    void arrange(true);
    return () => {
      generation.current++;
    };
  }, [arrange]);
  useEffect(() => {
    setEdges(buildEdges(map));
  }, [map, setEdges]);
  const visibleNodes = useMemo(
    () =>
      nodes.map(
        (node) =>
          ({
            ...node,
            hidden:
              !!sourceFilter &&
              (node.type === 'source' ? node.id !== sourceFilter : node.parentId !== sourceFilter),
            data:
              node.type === 'table'
                ? {
                    ...node.data,
                    highlighted:
                      !!search &&
                      (node.data.dataset.display_name ?? node.data.dataset.name)
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                  }
                : node.data,
          }) as MapNode,
      ),
    [nodes, sourceFilter, search],
  );
  const visibleIds = useMemo(
    () => new Set(visibleNodes.filter((n) => !n.hidden).map((n) => n.id)),
    [visibleNodes],
  );
  const visibleEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        label: hoveredEdge === edge.id ? edge.data?.description : undefined,
        labelStyle: { fill: 'var(--ink)' },
        labelBgStyle: { fill: 'var(--bg)' },
        hidden:
          !enabledKinds.includes(edge.data!.kind) ||
          !visibleIds.has(edge.source) ||
          !visibleIds.has(edge.target),
      })),
    [edges, hoveredEdge, enabledKinds, visibleIds],
  );
  function connect(connection: FlowConnection) {
    if (!connection.sourceHandle || !connection.targetHandle) return;
    const forward = connection.sourceHandle.startsWith('out:');
    const source = forward ? connection.source : connection.target;
    const target = forward ? connection.target : connection.source;
    const from = forward ? connection.sourceHandle : connection.targetHandle;
    const to = forward ? connection.targetHandle : connection.sourceHandle;
    void action(
      () =>
        client.createRelationship({
          from_dataset: source,
          from_cols: [from.slice(from.indexOf(':') + 1)],
          to_dataset: target,
          to_cols: [to.slice(to.indexOf(':') + 1)],
          kind: 'manual',
          confidence: null,
        }),
      'Manual relationship created',
    );
  }
  function removeSelected() {
    const ids = [
      ...new Set(
        edges
          .filter((e) => selected.includes(e.id) && e.data?.kind === 'manual')
          .map((e) => e.data!.relationshipId),
      ),
    ];
    if (ids.length)
      void action(async () => {
        for (const id of ids) await client.deleteRelationship(id);
      }, 'Manual relationship deleted');
  }
  function zoomSearch() {
    const matches = visibleNodes.filter(
      (n) => n.type === 'table' && n.data.highlighted && !n.hidden,
    );
    if (matches.length)
      void fitView({
        nodes: matches,
        padding: 0.4,
        maxZoom: 1.2,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250,
      });
  }
  return (
    <section className="map-section">
      <div className="toolbar">
        <Field label="Source">
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            <option value="">All sources</option>
            {map.nodes
              .filter((n) => n.type === 'source')
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Find dataset">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') zoomSearch();
            }}
          />
        </Field>
        <button onClick={zoomSearch} disabled={!search}>
          Find
        </button>
        <button disabled={layingOut} onClick={() => void arrange(false)}>
          {layingOut ? 'Laying out…' : 'Re-layout'}
        </button>
        <button
          disabled={
            busy || !edges.some((e) => selected.includes(e.id) && e.data?.kind === 'manual')
          }
          onClick={removeSelected}
        >
          Delete manual edge
        </button>
      </div>
      <fieldset className="edge-filters">
        <legend>Relationships</legend>
        {kinds.map((kind) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={enabledKinds.includes(kind)}
              onChange={(e) =>
                setEnabledKinds(
                  e.target.checked
                    ? [...enabledKinds, kind]
                    : enabledKinds.filter((k) => k !== kind),
                )
              }
            />
            <span className={'edge-sample ' + kind} />
            {kind.replaceAll('_', ' ')}
          </label>
        ))}
      </fieldset>
      <p className="hint">
        Drag between column handles to create a manual edge. Select a manual edge and press Delete
        to remove it. {hover}
      </p>
      {layoutError && <p role="alert">{layoutError}</p>}
      {!map.nodes.some((n) => n.type === 'dataset') && (
        <p className="empty">Discover a source or add an external dataset to start mapping.</p>
      )}
      <div
        className="map-canvas"
        tabIndex={0}
        role="region"
        aria-label="Data Map canvas"
        onKeyDown={(e) => {
          if (
            (e.key === 'Delete' || e.key === 'Backspace') &&
            !(e.target instanceof HTMLInputElement) &&
            !(e.target instanceof HTMLTextAreaElement) &&
            !busy
          ) {
            e.preventDefault();
            removeSelected();
          }
        }}
      >
        <ReactFlow<MapNode, MapEdge>
          nodes={visibleNodes}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection) => {
            if (!busy) connect(connection);
          }}
          connectionMode={ConnectionMode.Loose}
          isValidConnection={(c) =>
            !!c.sourceHandle &&
            !!c.targetHandle &&
            c.sourceHandle.startsWith('out:') !== c.targetHandle.startsWith('out:')
          }
          onNodeDragStop={(_, node) => {
            const next = nodes.map((n) =>
              n.id === node.id ? { ...n, position: node.position } : n,
            );
            persist(engineUrl, next);
          }}
          onEdgeMouseEnter={(_, edge) => {
            setHover(edge.data?.description || '');
            setHoveredEdge(edge.id);
          }}
          onEdgeMouseLeave={() => {
            setHover('');
            setHoveredEdge('');
          }}
          deleteKeyCode={null}
          fitView
          minZoom={0.1}
          maxZoom={2}
        >
          <Background gap={24} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => (node.type === 'source' ? 'var(--border)' : 'var(--primary)')}
          />
          <Controls />
        </ReactFlow>
      </div>
    </section>
  );
}
