import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  ConnectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { Connection as FlowConnection } from '@xyflow/react';
import type {
  Api,
  ColumnRef,
  DataMap,
  MapSource,
  Dataset,
  EdgeKind,
  EngineEvent,
  Job,
  Relationship,
  Run,
} from '@/lib/api';
import { datasetLabel } from '@/lib/view-model';
import { ConsoleDrawer, RunHistory, Skeleton } from '@/features/console/ConsoleDrawer';
import { datasetJobs } from '@/features/console/workbench-model';
import { CatalogPanel } from './CatalogPanel';
import { ColumnInspector } from './ColumnInspector';
import type { UsageEntity } from './ColumnInspector';
import { Impact } from './Impact';
import { MapEmptyState, MapLegend, MapTools } from './MapControls';
import { edgeTypes, nodeTypes, SourceHealthContext } from './MapNodes';
import { sourceHealth } from '@/features/connections/source-health';
import { edgeKinds, persist } from './map-model';
import type { MapNode, MapEdge, TableNode } from './map-model';
import { AddRelationshipDialog, RemoveRelationshipsDialog } from './RelationshipDialogs';
import { manualSelection, relationshipInput } from './relationship-form';
import { SelectionInspector } from './SelectionInspector';
import { useMapLayout } from './use-map-layout';
import { useVisibleGraph } from './use-visible-graph';
import { PageTabs } from '@/components/workbench/page-layout';
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
  onNavigateUsage: (entity: UsageEntity) => void;
};
export default function DataMapView(props: Props) {
  const [mode, setMode] = useState('Lineage');
  return (
    // The map canvas sizes itself with h-full, so this column needs a definite height.
    <div className="flex h-full min-h-0 flex-col">
      <PageTabs id="lineage-mode" items={['Lineage', 'Impact']} value={mode} onChange={setMode} />
      <div
        id={'lineage-mode-panel-' + mode}
        role="tabpanel"
        aria-labelledby={'lineage-mode-tab-' + mode}
        className={'min-h-0 flex-1 ' + (mode === 'Impact' ? 'overflow-auto' : 'overflow-hidden')}
      >
        {mode === 'Impact' ? (
          <Impact client={props.client} map={props.map} initialRoot={props.focusId} />
        ) : (
          <ReactFlowProvider>
            <Canvas {...props} />
          </ReactFlowProvider>
        )}
      </div>
    </div>
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
  onNavigateUsage,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapEdge>([]);
  const [fieldFocus, setFieldFocus] = useState<ColumnRef | null>(null);
  const section = useRef<HTMLElement>(null);
  const fieldInspectorOpen = !!fieldFocus;
  useEffect(() => {
    if (!fieldInspectorOpen) return;
    const previous = document.activeElement;
    section.current?.querySelector<HTMLButtonElement>('.column-inspector button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [fieldInspectorOpen]);
  const [addingRelationship, setAddingRelationship] = useState(false);
  const [removal, setRemoval] = useState<Relationship[]>([]);
  const relationshipDatasets = map.nodes.filter((n): n is Dataset => n.type === 'dataset');
  const clearSelection = useCallback(() => {
    setNodes((previous) => previous.map((node) => ({ ...node, selected: false })));
    setEdges((previous) => previous.map((edge) => ({ ...edge, selected: false })));
  }, [setNodes, setEdges]);
  const onFieldFocus = useCallback(
    (dataset_id: string, column: string) => {
      setFieldFocus({ dataset_id, column });
      clearSelection();
    },
    [clearSelection],
  );
  const columnQuery = useQuery({
    queryKey: ['engine', 'impact', 'columns', engineUrl, fieldFocus, map],
    queryFn: () => client.columnLineage(fieldFocus!),
    enabled: !!fieldFocus,
  });
  const fieldGraph = columnQuery.data;
  const [consoleTab, setConsoleTab] = useState('Live events');
  const [stateFilter, setStateFilter] = useState(initialStatusFilter);
  useEffect(() => setStateFilter(initialStatusFilter), [initialStatusFilter]);
  const [minimap, setMinimap] = useState(true);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState('');
  const [enabledKinds, setEnabledKinds] = useState<EdgeKind[]>(edgeKinds);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const [hover, setHover] = useState('');
  const [hoveredEdge, setHoveredEdge] = useState('');
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
  const { fitView } = useReactFlow<MapNode, MapEdge>();
  // The dot grid is decoration; React Flow's Background does not forward ARIA props.
  useEffect(() => {
    for (const svg of document.querySelectorAll('.decorative-background'))
      svg.setAttribute('aria-hidden', 'true');
  });
  const { arrange, layingOut, layoutError } = useMapLayout(map, engineUrl, setNodes, setEdges);
  const rendered = useVisibleGraph({
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
  });
  // Dragging between column handles creates a manual relationship in either direction.
  function connect(connection: FlowConnection) {
    if (!connection.sourceHandle || !connection.targetHandle || !canManage || busy) return;
    const forward = connection.sourceHandle.startsWith('out:');
    const source = forward ? connection.source : connection.target;
    const target = forward ? connection.target : connection.source;
    const from = forward ? connection.sourceHandle : connection.targetHandle;
    const to = forward ? connection.targetHandle : connection.sourceHandle;
    void action(
      () =>
        client.createRelationship(
          relationshipInput(
            relationshipDatasets,
            source,
            from.slice(from.indexOf(':') + 1),
            target,
            to.slice(to.indexOf(':') + 1),
          ),
        ),
      'Manual relationship created',
    );
  }
  function removeSelected() {
    if (!canManage || busy) return;
    setRemoval(
      manualSelection(
        map.edges,
        edges.filter((e) => e.selected).map((e) => e.data!.relationshipId),
      ),
    );
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
  // Same health rule as Overview and Connections, so a failing source never reads "Connected".
  const mapDatasets = map.nodes.filter((n): n is Dataset => n.type === 'dataset');
  const health = Object.fromEntries(
    map.nodes
      .filter((n): n is MapSource => n.type === 'source')
      .map((n) => [
        n.id,
        ['parquet', 'models'].includes(n.kind)
          ? 'Built-in'
          : sourceHealth(n.id, jobs, runs, mapDatasets),
      ]),
  );
  const selectedJobs = selectedDataset ? datasetJobs(selectedDataset, jobs) : [];
  const selectedRuns = runs.filter((run) => selectedJobs.some((job) => job.id === run.job_id));
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
    <section
      className="map-section"
      ref={section}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && fieldFocus) {
          event.stopPropagation();
          setFieldFocus(null);
        }
      }}
    >
      <CatalogPanel
        map={map}
        search={search}
        onSearch={setSearch}
        onSearchEnter={zoomSearch}
        sourceFilter={sourceFilter}
        onSourceFilter={setSourceFilter}
        excluded={excluded}
        onToggleExcluded={(id) =>
          setExcluded((previous) =>
            previous.includes(id) ? previous.filter((v) => v !== id) : [...previous, id],
          )
        }
        selectedId={selectedDataset?.id}
        onSelect={selectDataset}
        enabledKinds={enabledKinds}
        onEnabledKinds={setEnabledKinds}
        canManage={canManage}
      />
      {layoutError && (
        <p className="map-feedback message" role="alert">
          {layoutError}
        </p>
      )}
      {!relationshipDatasets.length && (
        <MapEmptyState
          map={map}
          onConnectSource={onConnectSource}
          canManage={canManage}
          busy={busy}
          onDiscover={(id) => void action(() => client.discoverSource(id), 'Catalog discovered')}
        />
      )}
      {layingOut && (
        <div className="map-feedback">
          <Skeleton label="Arranging Data Map…" />
        </div>
      )}
      <div className="map-center">
        {/* Legend and hint live above the canvas, so no overlay can cover map content. */}
        <div className="map-legend-row">
          <MapLegend
            map={map}
            jobs={jobs}
            runs={runs}
            stateFilter={stateFilter}
            onStateFilter={setStateFilter}
          />
          {!fieldFocus && (
            <p className="hint">
              Select a field to trace its sources, transformations and uses. Arrow keys move between
              fields; Enter traces a field.
            </p>
          )}
        </div>
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
          <SourceHealthContext.Provider value={health}>
            <ReactFlow<MapNode, MapEdge>
              nodes={rendered.nodes}
              edges={rendered.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              elevateNodesOnSelect={false}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connect}
              nodesConnectable={canManage && !fieldFocus}
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
              // Open readable: never fit below 75% (13px labels stay about 10px); Fit to view
              // and the minimap still show the whole map on demand.
              fitViewOptions={{ minZoom: 0.75, padding: 0.1 }}
              minZoom={0.1}
              maxZoom={2}
            >
              <Background
                gap={24}
                size={1}
                color="var(--grid-dot)"
                className="decorative-background"
              />

              {minimap && (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) =>
                    node.type === 'source' ? 'var(--line)' : 'var(--primary-300)'
                  }
                />
              )}
              <MapTools
                onAddRelationship={canManage ? () => setAddingRelationship(true) : undefined}
                addDisabled={busy || relationshipDatasets.length === 0}
                layingOut={layingOut}
                onRelayout={() => void arrange(false)}
                minimap={minimap}
                onMinimap={setMinimap}
              />
            </ReactFlow>
          </SourceHealthContext.Provider>
        </div>
        {/* Hidden until the title-bar console toggle opens it, as on every other page. */}
        {!consoleCollapsed && (
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
        )}
      </div>
      {!fieldFocus && (selectedDataset || selectedEdge) && (
        <SelectionInspector
          dataset={selectedDataset}
          edge={selectedEdge}
          map={map}
          jobs={jobs}
          runs={runs}
          canManage={canManage}
          busy={busy}
          client={client}
          action={action}
          canCreateJob={canCreateJob}
          onQuery={onQuery}
          onCreateJob={onCreateJob}
          onClose={clearSelection}
          onRemoveSelected={removeSelected}
          onSelectRelationship={(id) => {
            setNodes((previous) => previous.map((n) => ({ ...n, selected: false })));
            setEdges((previous) =>
              previous.map((edge) => ({ ...edge, selected: edge.data?.relationshipId === id })),
            );
          }}
        />
      )}
      {fieldFocus && (
        <ColumnInspector
          focus={fieldFocus}
          graph={fieldGraph}
          loading={columnQuery.isPending}
          error={columnQuery.error}
          retry={() => void columnQuery.refetch()}
          onClose={() => setFieldFocus(null)}
          onFocus={onFieldFocus}
          onNavigate={onNavigateUsage}
        />
      )}
      <AddRelationshipDialog
        open={addingRelationship}
        onOpenChange={setAddingRelationship}
        datasets={relationshipDatasets}
        busy={busy}
        canManage={canManage}
        client={client}
        action={action}
      />
      <RemoveRelationshipsDialog
        removal={removal}
        onRemoval={setRemoval}
        datasets={relationshipDatasets}
        busy={busy}
        canManage={canManage}
        client={client}
        action={action}
      />
      <span className="visually-hidden" role="status">
        {hover}
      </span>
    </section>
  );
}
