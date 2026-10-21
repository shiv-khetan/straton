import { Input } from '@/components/ui/input';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BaseEdge,
  Panel,
  useViewport,
  MiniMap,
  Handle,
  Position,
  ConnectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { Connection as FlowConnection, EdgeProps, NodeProps } from '@xyflow/react';
import type { Api, DataMap, Dataset, EdgeKind, MapSource, Job, Run, EngineEvent } from '@/lib/api';
import {
  Button,
  Icon,
  Inspector,
  Pill,
  SchemaTree,
  Table as UiTable,
} from '@/components/workbench/primitives';
import { datasetLabel, relativeTime } from '@/lib/view-model';
import { Field } from '@/components/workbench/Field';
import {
  ConsoleDrawer,
  CopyButton,
  RunHistory,
  StatusChip,
  Skeleton,
} from '@/features/console/ConsoleDrawer';
import { datasetState, datasetRun, datasetJobs } from '@/features/console/workbench-model';
import { tableReference } from '@/features/sql/sql-model';
import {
  buildEdges,
  layout,
  loadPositions,
  persist,
  restorePositions,
  routeEdges,
  routedEdgePath,
  TABLE_HEADER_HEIGHT,
  TABLE_ROW_HEIGHT,
  TABLE_FOOTER_HEIGHT,
} from '@/features/lineage/map-model';
import type { MapNode, MapEdge, TableNode, GroupNode } from '@/features/lineage/map-model';
type Props = {
  map: DataMap;
  jobs: Job[];
  runs: Run[];
  events: EngineEvent[];
  focusId: string;
  initialStatusFilter: string;
  consoleCollapsed: boolean;
  onConsoleCollapsed: (value: boolean) => void;
  onConnectSource?: () => void;
  canManage: boolean;
  canCreateJob: (dataset: Dataset) => boolean;
  engineUrl: string;
  client: Api;
  action: (work: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
  onQuery: (dataset: Dataset) => void;
  onCreateJob: (dataset: Dataset) => void;
  onSelection: (name: string, id?: string) => void;
};
const kinds: EdgeKind[] = ['declared_fk', 'inferred', 'lineage', 'manual'];
function Table({ data }: NodeProps<TableNode>) {
  return (
    <article
      className={
        'dataset-node state-' +
        (data.state ?? 'never-synced').replaceAll(' ', '-') +
        (data.external ? ' external-node' : '') +
        (data.dataset.stale ? ' stale' : '') +
        (data.highlighted ? ' highlighted' : '')
      }
    >
      <div className="dataset-title" style={{ height: TABLE_HEADER_HEIGHT }}>
        <Handle type="target" position={Position.Left} id="dataset:in" isConnectable={false} />
        <div className="node-heading-row">
          <Icon name="table" />
          <strong title={datasetLabel(data.dataset)}>{datasetLabel(data.dataset)}</strong>
        </div>
        <div className="node-state-row">
          <StatusChip state={data.state} />
          {data.dataset.row_filtered && (
            <Pill title="Row filter active">
              <Icon name="lock" />
              Filtered
            </Pill>
          )}
        </div>
        <Handle type="source" position={Position.Right} id="dataset:out" isConnectable={false} />
      </div>
      {data.dataset.columns.map((column) => (
        <div className="dataset-column" key={column.name} style={{ height: TABLE_ROW_HEIGHT }}>
          <Handle
            type="target"
            position={Position.Left}
            id={'in:' + column.name}
            aria-label={'Connect to ' + column.name}
          />
          <span className="column-name" title={column.name}>
            {column.name}
          </span>
          <span className="column-type" title={column.type}>
            {column.type}
            {column.nullable ? '?' : ''}
          </span>
          <span className="column-badges">
            {column.masked && <Pill title={column.mask_kind ?? 'Column mask'}>Masked</Pill>}
            {column.pk && (
              <Pill tone="primary" title="Primary key">
                PK
              </Pill>
            )}
            {data.fk.includes(column.name) && <Pill title="Foreign key">FK</Pill>}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={'out:' + column.name}
            aria-label={'Connect from ' + column.name}
          />
        </div>
      ))}
      {data.state === 'running' && (
        <div className="node-progress" role="status">
          <span className="indeterminate-progress" />
          <span className="visually-hidden">
            Running · {data.batches ?? 0} committed batches; total unavailable
          </span>
        </div>
      )}
      <div className="dataset-footer" style={{ height: TABLE_FOOTER_HEIGHT }}>
        <span>{data.dataset.row_count?.toLocaleString() ?? '—'} rows</span>
        {data.state === 'running' && <span>{data.batches ?? 0} batches</span>}
        <Pill title={data.dataset.last_synced_at ?? 'Never synced'}>
          <Icon name="clock" />
          {relativeTime(data.dataset.last_synced_at)}
        </Pill>
      </div>
    </article>
  );
}
function SourceGroup({ data }: NodeProps<GroupNode>) {
  return (
    <div className={'source-label mono-caption' + (data.external ? ' external-label' : '')}>
      <Icon name="source" />
      <span>{data.label}</span>
      <Pill tone={data.stale ? 'warning' : data.external ? 'neutral' : 'success'}>
        {data.stale ? 'Stale data' : data.external ? 'External' : 'Connected'}
      </Pill>
    </div>
  );
}
function RoutedEdge(props: EdgeProps<MapEdge>) {
  const { path, label } = routedEdgePath(props.data?.route ?? []);
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style}
      markerStart={props.markerStart}
      markerEnd={props.markerEnd}
      interactionWidth={props.interactionWidth}
      label={props.label}
      labelX={label.x}
      labelY={label.y}
      labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg}
      labelBgStyle={props.labelBgStyle}
    />
  );
}
const edgeTypes = { elk: RoutedEdge };
const nodeTypes = { table: Table, source: SourceGroup };
export default function DataMapView(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
function Canvas({
  map,
  jobs,
  runs,
  events,
  focusId,
  initialStatusFilter,
  consoleCollapsed,
  onConsoleCollapsed,
  onConnectSource,
  canManage,
  canCreateJob,
  engineUrl,
  client,
  action,
  busy,
  onQuery,
  onCreateJob,
  onSelection,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapEdge>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [consoleTab, setConsoleTab] = useState('Live events');
  const [stateFilter, setStateFilter] = useState(initialStatusFilter);
  useEffect(() => setStateFilter(initialStatusFilter), [initialStatusFilter]);
  const [minimap, setMinimap] = useState(true);
  const [excluded, setExcluded] = useState<string[]>([]);
  const { zoom } = useViewport();
  const [sourceFilter, setSourceFilter] = useState('');
  const [enabledKinds, setEnabledKinds] = useState<EdgeKind[]>(kinds);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const [hover, setHover] = useState('');
  const [hoveredEdge, setHoveredEdge] = useState('');
  const [layoutError, setLayoutError] = useState('');
  const [layingOut, setLayingOut] = useState(false);
  // Read Flow selection directly so its selection effect cannot feed back into local state.
  const selected = useMemo(
    () => edges.filter((edge) => edge.selected).map((edge) => edge.id),
    [edges],
  );
  const selectedDataset = nodes.find(
    (node): node is TableNode => node.type === 'table' && !!node.selected,
  )?.data.dataset;
  const selectedEdge = map.edges.find((e) =>
    edges.some((edge) => edge.selected && edge.data?.relationshipId === e.id),
  );
  useEffect(() => {
    onSelection(
      selectedDataset
        ? datasetLabel(selectedDataset)
        : selectedEdge
          ? selectedEdge.kind.replaceAll('_', ' ')
          : '',
      selectedDataset?.id ?? selectedEdge?.id,
    );
  }, [selectedDataset, selectedEdge, onSelection]);
  const { fitView, zoomIn, zoomOut } = useReactFlow<MapNode, MapEdge>();
  const generation = useRef(0);
  const arrange = useCallback(
    async (restore: boolean) => {
      const current = ++generation.current;
      setLayingOut(true);
      setLayoutError('');
      try {
        const next = await layout(map);
        if (generation.current !== current) return;
        const positioned = restore
          ? restorePositions(next.nodes, loadPositions(engineUrl))
          : next.nodes;
        setNodes((previous) =>
          positioned.map((node) => ({
            ...node,
            selected: previous.find((existing) => existing.id === node.id)?.selected ?? false,
          })),
        );
        setEdges((previous) =>
          next.edges.map((edge) => ({
            ...edge,
            selected: previous.find((existing) => existing.id === edge.id)?.selected ?? false,
          })),
        );
        if (!restore) persist(engineUrl, positioned);
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
    [map, engineUrl, setNodes, setEdges, fitView],
  );
  useEffect(() => {
    void arrange(true);
    return () => {
      generation.current++;
    };
  }, [arrange]);
  useEffect(() => {
    setEdges((previous) =>
      buildEdges(map).map((edge) => ({
        ...edge,
        selected: previous.find((existing) => existing.id === edge.id)?.selected ?? false,
      })),
    );
  }, [map, setEdges]);
  const visibleNodes = useMemo(
    () =>
      nodes.map(
        (node) =>
          ({
            ...node,
            hidden:
              excluded.includes(node.id) ||
              (!!node.parentId && excluded.includes(node.parentId)) ||
              (!!sourceFilter &&
                (node.type === 'source'
                  ? node.id !== sourceFilter
                  : node.parentId !== sourceFilter)),
            style: {
              ...node.style,
              opacity:
                node.type === 'table' &&
                stateFilter &&
                datasetState(node.data.dataset, jobs, runs) !== stateFilter
                  ? 0.35
                  : 1,
            },
            data:
              node.type === 'table'
                ? {
                    ...node.data,
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
    [nodes, sourceFilter, query, excluded, stateFilter, map, jobs, runs],
  );
  const visibleIds = useMemo(
    () => new Set(visibleNodes.filter((n) => !n.hidden).map((n) => n.id)),
    [visibleNodes],
  );
  const activeNodes = useMemo(
    () =>
      new Set(
        visibleNodes
          .filter((node) => node.type === 'table' && node.data.state === 'running')
          .map((node) => node.id),
      ),
    [visibleNodes],
  );
  const visibleEdges = useMemo(
    () =>
      routeEdges(edges, nodes).map((edge) => ({
        ...edge,
        className:
          'edge-kind-' +
          edge.data!.kind +
          (edge.data?.kind === 'lineage' &&
          (activeNodes.has(edge.source) || activeNodes.has(edge.target))
            ? ' edge-active'
            : ''),
        style: {
          ...edge.style,
          stroke:
            hoveredEdge === edge.id ||
            edge.selected ||
            enabledKinds.length !== kinds.length ||
            !!sourceFilter ||
            excluded.length > 0 ||
            !!search ||
            activeNodes.has(edge.source) ||
            activeNodes.has(edge.target) ||
            !!stateFilter
              ? edge.style?.stroke
              : 'var(--edge-quiet)',
        },
        markerEnd: {
          type: 'arrowclosed' as const,
          width: 12,
          height: 12,
          color:
            hoveredEdge === edge.id ||
            edge.selected ||
            enabledKinds.length !== kinds.length ||
            !!sourceFilter ||
            excluded.length > 0 ||
            !!search ||
            !!stateFilter ||
            activeNodes.has(edge.source) ||
            activeNodes.has(edge.target)
              ? String(edge.style?.stroke)
              : 'var(--edge-quiet)',
        },
        label: hoveredEdge === edge.id ? edge.data?.description : undefined,
        labelStyle: { fill: 'var(--ink)' },
        labelBgStyle: { fill: 'var(--bg)' },
        hidden:
          !enabledKinds.includes(edge.data!.kind) ||
          !visibleIds.has(edge.source) ||
          !visibleIds.has(edge.target),
      })),
    [
      edges,
      nodes,
      hoveredEdge,
      enabledKinds,
      visibleIds,
      sourceFilter,
      excluded,
      search,
      stateFilter,
      activeNodes,
    ],
  );
  function connect(connection: FlowConnection) {
    if (!canManage) return;
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
    if (!canManage) return;
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
  function selectDataset(id: string) {
    const dataset = map.nodes.find((n): n is Dataset => n.type === 'dataset' && n.id === id);
    if (!dataset) return;
    setExcluded((previous) =>
      previous.filter((value) => value !== id && value !== dataset.source_id),
    );
    if (sourceFilter && sourceFilter !== dataset.source_id) setSourceFilter('');
    setNodes((previous) => previous.map((node) => ({ ...node, selected: node.id === id })));
    setEdges((previous) => previous.map((edge) => ({ ...edge, selected: false })));
    requestAnimationFrame(() => {
      void fitView({
        nodes: [{ id }],
        padding: 0.4,
        maxZoom: 1.2,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250,
      });
    });
  }
  const focused = useRef('');
  useEffect(() => {
    if (!focusId) focused.current = '';
    if (focusId && focused.current !== focusId && nodes.some((n) => n.id === focusId)) {
      focused.current = focusId;
      selectDataset(focusId);
    }
  }, [focusId, nodes]);
  const selectedJobs = selectedDataset ? datasetJobs(selectedDataset, jobs) : [];
  const selectedRuns = runs.filter((run) => selectedJobs.some((job) => job.id === run.job_id));
  const lastRun = selectedDataset ? datasetRun(selectedDataset, jobs, runs) : undefined;
  function zoomSearch() {
    if (!query) return;
    const match = nodes.find(
      (node) =>
        node.type === 'table' &&
        (!sourceFilter || node.parentId === sourceFilter) &&
        datasetLabel(node.data.dataset).toLowerCase().includes(query),
    );
    if (match) selectDataset(match.id);
  }
  return (
    <section className="map-section">
      <div className="map-library" data-collapsed={!panelOpen}>
        <div className="panel-heading">
          {panelOpen && <h2>Catalog</h2>}
          <Button
            type="button"
            variant="ghost"
            aria-label={panelOpen ? 'Collapse catalog' : 'Expand catalog'}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            <Icon name="collapse" />
          </Button>
        </div>
        {panelOpen && (
          <>
            <div className="library-content">
              <Field label="Find dataset">
                <Input
                  type="search"
                  value={search}
                  placeholder="Search datasets…"
                  aria-describedby="dataset-search-help"
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') zoomSearch();
                  }}
                />
              </Field>
              <p id="dataset-search-help" className="hint">
                Filters the catalog and highlights canvas matches. Press Enter to select the first
                match.
              </p>
              <Field label="Source">
                <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                  <option value="">All sources</option>
                  {map.nodes
                    .filter((n): n is MapSource => n.type === 'source')
                    .map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            <SchemaTree
              groups={map.nodes
                .filter((n): n is MapSource => n.type === 'source')
                .filter((source) => !sourceFilter || source.id === sourceFilter)
                .map((source) => ({
                  id: source.id,
                  label: source.name,
                  items: map.nodes
                    .filter((n): n is Dataset => n.type === 'dataset' && n.source_id === source.id)
                    .filter((d) => datasetLabel(d).toLowerCase().includes(query))
                    .map((d) => ({ id: d.id, label: datasetLabel(d) })),
                }))}
              hidden={excluded}
              onToggle={(id) =>
                setExcluded((previous) =>
                  previous.includes(id) ? previous.filter((v) => v !== id) : [...previous, id],
                )
              }
              onSelect={selectDataset}
              selected={selectedDataset?.id}
            />
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
            {canManage && (
              <p className="hint library-content">
                Drag between column handles to create a manual relationship.
              </p>
            )}
          </>
        )}
      </div>
      {layoutError && (
        <p className="map-feedback message" role="alert">
          {layoutError}
        </p>
      )}
      {!map.nodes.some((n) => n.type === 'dataset') && (
        <div className="map-feedback empty-state">
          <p>Connect a source and run Discover to see your data here</p>
          {onConnectSource && (
            <Button type="button" variant="ghost" onClick={onConnectSource}>
              Connect a source
            </Button>
          )}
          {canManage &&
            map.nodes
              .filter(
                (node): node is MapSource =>
                  node.type === 'source' &&
                  node.connected &&
                  ['postgres', 'sqlite', 'csv', 'stripe', 'salesforce', 'noop'].includes(node.kind),
              )
              .map((source) => (
                <Button
                  type="button"
                  variant="ghost"
                  key={source.id}
                  disabled={busy}
                  onClick={() =>
                    void action(() => client.discoverSource(source.id), 'Catalog discovered')
                  }
                >
                  Discover {source.name}
                </Button>
              ))}
        </div>
      )}
      {layingOut && (
        <div className="map-feedback">
          <Skeleton label="Arranging Data Map…" />
        </div>
      )}
      <div className="map-center">
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
            edgeTypes={edgeTypes}
            elevateNodesOnSelect={false}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(connection) => {
              if (!busy) connect(connection);
            }}
            nodesConnectable={canManage}
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
            <Background gap={24} size={1} color="var(--grid-dot)" />
            <Panel position="top-left" className="map-legend">
              {(['succeeded', 'running', 'queued', 'stale', 'failed', 'never synced'] as const).map(
                (state) => (
                  <Button
                    variant="ghost"
                    key={state}
                    aria-pressed={stateFilter === state}
                    onClick={() => setStateFilter(stateFilter === state ? '' : state)}
                  >
                    <StatusChip state={state} />
                    <code>
                      {
                        map.nodes
                          .filter((d): d is Dataset => d.type === 'dataset')
                          .filter((d) => datasetState(d, jobs, runs) === state).length
                      }
                    </code>
                  </Button>
                ),
              )}
            </Panel>
            {minimap && (
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) =>
                  node.type === 'source' ? 'var(--line)' : 'var(--primary-300)'
                }
              />
            )}
            <Panel position="top-right" className="map-tools">
              <Button
                type="button"
                variant="ghost"
                aria-label="Fit to view"
                title="Fit to view"
                onClick={() => void fitView({ padding: 0.15 })}
              >
                <Icon name="fit" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label="Zoom out"
                onClick={() => void zoomOut()}
              >
                <Icon name="minus" />
              </Button>
              <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
              <Button
                type="button"
                variant="ghost"
                aria-label="Zoom in"
                onClick={() => void zoomIn()}
              >
                <Icon name="plus" />
              </Button>
              <span className="tool-divider" />
              <Button
                type="button"
                variant="ghost"
                disabled={layingOut}
                title="Re-layout"
                aria-label="Re-layout"
                onClick={() => void arrange(false)}
              >
                <Icon name="refresh" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label="Toggle minimap"
                aria-pressed={minimap}
                title="Toggle minimap"
                onClick={() => setMinimap(!minimap)}
              >
                <Icon name="map" />
              </Button>
            </Panel>
          </ReactFlow>
        </div>
        <ConsoleDrawer
          tab={consoleTab}
          onTab={setConsoleTab}
          collapsed={consoleCollapsed}
          onCollapsed={onConsoleCollapsed}
          events={events}
        >
          <RunHistory
            jobs={jobs}
            runs={selectedRuns}
            busy={busy}
            cancel={
              selectedDataset && canCreateJob(selectedDataset)
                ? (id) => void action(() => client.cancelRun(id), 'Cancellation requested')
                : undefined
            }
          />
        </ConsoleDrawer>
      </div>
      {(selectedDataset || selectedEdge) && (
        <Inspector
          entityId={selectedDataset?.id ?? selectedEdge!.id}
          label="Selection inspector"
          title={selectedDataset ? datasetLabel(selectedDataset) : 'Relationship'}
          onClose={() => {
            setNodes((previous) => previous.map((node) => ({ ...node, selected: false })));
            setEdges((previous) => previous.map((edge) => ({ ...edge, selected: false })));
          }}
        >
          <div className="inspector-content">
            {selectedDataset ? (
              <>
                <Pill>
                  <code title={selectedDataset.id}>{selectedDataset.id}</code>
                </Pill>
                <StatusChip state={datasetState(selectedDataset, jobs, runs)} />
                <h3>Target</h3>
                <div className="target-path">
                  <code>
                    {tableReference(selectedDataset.sql_schema, selectedDataset.sql_table)}
                  </code>
                  <CopyButton
                    text={tableReference(selectedDataset.sql_schema, selectedDataset.sql_table)}
                    label="Copy SQL target"
                  />
                </div>
                <h3>Runtime</h3>
                <dl className="runtime-grid">
                  <div>
                    <dt>Duration</dt>
                    <dd title="Run duration is not exposed by this engine">—</dd>
                  </div>
                  <div>
                    <dt>Rows</dt>
                    <dd>{selectedDataset.row_count?.toLocaleString() ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Last sync</dt>
                    <dd title={selectedDataset.last_synced_at ?? undefined}>
                      {relativeTime(selectedDataset.last_synced_at)}
                    </dd>
                  </div>
                  <div>
                    <dt>Mode</dt>
                    <dd>{lastRun?.mode_used ?? selectedJobs[0]?.mode ?? '—'}</dd>
                  </div>
                </dl>
                {canManage && (
                  <>
                    <h3>Policies</h3>
                    <div className="actions">
                      <Pill>
                        {selectedDataset.row_filtered ? 'Row filter active' : 'No row filter'}
                      </Pill>
                      <Pill>
                        {selectedDataset.columns.filter((c) => c.masked).length} masked columns
                      </Pill>
                    </div>
                  </>
                )}
                <h3>Columns</h3>
                <UiTable label="Dataset columns">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Key</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedDataset.columns.map((c) => (
                      <TableRow key={c.name}>
                        <TableCell>
                          <code>{c.name}</code>
                        </TableCell>
                        <TableCell>
                          <code>
                            {c.type}
                            {c.nullable ? '?' : ''}
                          </code>
                        </TableCell>
                        <TableCell>
                          {c.masked && <Pill>Masked</Pill>}
                          {c.pk && <Pill tone="primary">PK</Pill>}
                          {map.edges.some(
                            (e) =>
                              e.kind === 'declared_fk' &&
                              e.from_dataset === selectedDataset.id &&
                              e.from_cols.includes(c.name),
                          ) && <Pill>FK</Pill>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </UiTable>
                {(['Incoming', 'Outgoing'] as const).map((direction) => (
                  <div key={direction}>
                    <h3>{direction === 'Incoming' ? 'Upstream' : 'Downstream'}</h3>
                    {map.edges
                      .filter(
                        (e) =>
                          (direction === 'Incoming' ? e.to_dataset : e.from_dataset) ===
                          selectedDataset.id,
                      )
                      .map((e) => (
                        <Button
                          variant="ghost"
                          className="relationship-item"
                          key={e.id}
                          onClick={() => {
                            setNodes((previous) =>
                              previous.map((n) => ({ ...n, selected: false })),
                            );
                            setEdges((previous) =>
                              previous.map((edge) => ({
                                ...edge,
                                selected: edge.data?.relationshipId === e.id,
                              })),
                            );
                          }}
                        >
                          <StatusChip
                            state={(() => {
                              const dataset = map.nodes.find(
                                (node): node is Dataset =>
                                  node.type === 'dataset' &&
                                  node.id ===
                                    (direction === 'Incoming' ? e.from_dataset : e.to_dataset),
                              );
                              return dataset ? datasetState(dataset, jobs, runs) : null;
                            })()}
                          />
                          <span>
                            {datasetLabel(
                              map.nodes.find(
                                (n) =>
                                  n.type === 'dataset' &&
                                  n.id ===
                                    (direction === 'Incoming' ? e.from_dataset : e.to_dataset),
                              ),
                            )}
                            <small>{e.kind.replaceAll('_', ' ')}</small>
                          </span>
                        </Button>
                      ))}
                    {!map.edges.some(
                      (e) =>
                        (direction === 'Incoming' ? e.to_dataset : e.from_dataset) ===
                        selectedDataset.id,
                    ) && <p className="hint">No relationships</p>}
                  </div>
                ))}
                <div className="inspector-actions">
                  {lastRun &&
                    ['running', 'queued'].includes(lastRun.state) &&
                    canCreateJob(selectedDataset) && (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={busy}
                        onClick={() =>
                          void action(() => client.cancelRun(lastRun.id), 'Cancellation requested')
                        }
                      >
                        Cancel run
                      </Button>
                    )}
                  {selectedJobs[0] && canCreateJob(selectedDataset) && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || selectedDataset.stale}
                      onClick={() =>
                        void action(() => client.runJob(selectedJobs[0].id), 'Run queued')
                      }
                    >
                      Run now
                    </Button>
                  )}
                  <Button type="button" variant="default" onClick={() => onQuery(selectedDataset)}>
                    <Icon name="sql" />
                    Query in SQL
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={
                      busy ||
                      !canCreateJob(selectedDataset) ||
                      selectedDataset.stale ||
                      !['postgres', 'sqlite', 'csv', 'stripe', 'salesforce', 'noop'].includes(
                        (
                          map.nodes.find((n) => n.id === selectedDataset.source_id) as
                            MapSource | undefined
                        )?.kind ?? '',
                      )
                    }
                    onClick={() => onCreateJob(selectedDataset)}
                  >
                    <Icon name="plus" />
                    Create sync job
                  </Button>
                </div>
              </>
            ) : (
              selectedEdge && (
                <>
                  <Pill>{selectedEdge.kind.replaceAll('_', ' ')}</Pill>
                  <dl>
                    <dt>Confidence</dt>
                    <dd>
                      {selectedEdge.confidence === null
                        ? 'Not specified'
                        : Math.round(selectedEdge.confidence * 100) + '%'}
                    </dd>
                    <dt>From</dt>
                    <dd className="mono">
                      {datasetLabel(
                        map.nodes.find(
                          (n) => n.type === 'dataset' && n.id === selectedEdge.from_dataset,
                        ),
                      )}{' '}
                      ({selectedEdge.from_cols.join(', ') || 'dataset'})
                    </dd>
                    <dt>To</dt>
                    <dd className="mono">
                      {datasetLabel(
                        map.nodes.find(
                          (n) => n.type === 'dataset' && n.id === selectedEdge.to_dataset,
                        ),
                      )}{' '}
                      ({selectedEdge.to_cols.join(', ') || 'dataset'})
                    </dd>
                  </dl>
                  {canManage && selectedEdge.kind === 'manual' && (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={removeSelected}
                    >
                      Delete manual edge
                    </Button>
                  )}
                </>
              )
            )}
          </div>
        </Inspector>
      )}
      <span className="visually-hidden" role="status">
        {hover}
      </span>
    </section>
  );
}
