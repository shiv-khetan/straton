import { Panel, useReactFlow, useViewport } from '@xyflow/react';
import { Button, Icon } from '@/components/workbench/primitives';
import type { DataMap, Dataset, Job, MapSource, Run } from '@/lib/api';
import { syncableKinds } from '@/lib/view-model';
import { StatusChip } from '@/features/console/ConsoleDrawer';
import { datasetState } from '@/features/console/workbench-model';

const legendStates = ['succeeded', 'running', 'queued', 'stale', 'failed', 'never synced'] as const;

// Top-left state legend; each state doubles as a filter toggle with its dataset count.
export function MapLegend({
  map,
  jobs,
  runs,
  stateFilter,
  onStateFilter,
}: {
  map: DataMap;
  jobs: Job[];
  runs: Run[];
  stateFilter: string;
  onStateFilter: (state: string) => void;
}) {
  const datasets = map.nodes.filter((d): d is Dataset => d.type === 'dataset');
  return (
    <Panel position="bottom-left" className="map-legend">
      {legendStates.map((state) => (
        <Button
          variant="ghost"
          key={state}
          aria-pressed={stateFilter === state}
          onClick={() => onStateFilter(stateFilter === state ? '' : state)}
        >
          <StatusChip state={state} />
          <code>{datasets.filter((d) => datasetState(d, jobs, runs) === state).length}</code>
        </Button>
      ))}
    </Panel>
  );
}

// Top-right canvas tools: add relationship, fit, zoom, re-layout and minimap.
export function MapTools({
  onAddRelationship,
  addDisabled,
  layingOut,
  onRelayout,
  minimap,
  onMinimap,
}: {
  /** Absent when the viewer cannot manage relationships. */
  onAddRelationship?: () => void;
  addDisabled: boolean;
  layingOut: boolean;
  onRelayout: () => void;
  minimap: boolean;
  onMinimap: (value: boolean) => void;
}) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel position="top-right" className="map-tools">
      {onAddRelationship && (
        <Button variant="outline" disabled={addDisabled} onClick={onAddRelationship}>
          Add relationship
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        aria-label="Fit to view"
        title="Fit to view"
        onClick={() => void fitView({ padding: 0.15 })}
      >
        <Icon name="fit" />
      </Button>
      <Button type="button" variant="ghost" aria-label="Zoom out" onClick={() => void zoomOut()}>
        <Icon name="minus" />
      </Button>
      <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
      <Button type="button" variant="ghost" aria-label="Zoom in" onClick={() => void zoomIn()}>
        <Icon name="plus" />
      </Button>
      <span className="tool-divider" />
      <Button
        type="button"
        variant="ghost"
        disabled={layingOut}
        title="Re-layout"
        aria-label="Re-layout"
        onClick={onRelayout}
      >
        <Icon name="refresh" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        aria-label="Toggle minimap"
        aria-pressed={minimap}
        title="Toggle minimap"
        onClick={() => onMinimap(!minimap)}
      >
        <Icon name="map" />
      </Button>
    </Panel>
  );
}

// Shown before any dataset exists: connect a source, or discover one already connected.
export function MapEmptyState({
  map,
  onConnectSource,
  canManage,
  busy,
  onDiscover,
}: {
  map: DataMap;
  onConnectSource?: () => void;
  canManage: boolean;
  busy: boolean;
  onDiscover: (sourceId: string) => void;
}) {
  return (
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
              node.type === 'source' && node.connected && syncableKinds.includes(node.kind),
          )
          .map((source) => (
            <Button
              type="button"
              variant="ghost"
              key={source.id}
              disabled={busy}
              onClick={() => onDiscover(source.id)}
            >
              Discover {source.name}
            </Button>
          ))}
    </div>
  );
}
