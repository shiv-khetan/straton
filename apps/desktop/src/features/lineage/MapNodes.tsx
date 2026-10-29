import { Home } from 'lucide-react';
import { BaseEdge, Handle, Position } from '@xyflow/react';
import type { EdgeProps, NodeProps } from '@xyflow/react';
import { Icon, Pill, StatePill } from '@/components/workbench/primitives';
import { StatusChip } from '@/features/console/ConsoleDrawer';
import { datasetLabel, relativeTime } from '@/lib/view-model';
import { nextFieldIndex } from './column-model';
import {
  routedEdgePath,
  TABLE_FOOTER_HEIGHT,
  TABLE_HEADER_HEIGHT,
  TABLE_ROW_HEIGHT,
} from './map-model';
import type { GroupNode, MapEdge, TableNode } from './map-model';

// Custom React Flow node and edge renderers for the Data Map canvas.
function Table({ data }: NodeProps<TableNode>) {
  return (
    <article
      data-field-table={data.dataset.id}
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
          {data.dataset.dataset_type === 'view' && <Pill>View</Pill>}
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
        <div
          className="dataset-column"
          key={column.name}
          data-field-home={data.fieldFocus === column.name}
          data-field-dimmed={data.focusActive && !data.fieldPath?.includes(column.name)}
          style={{ height: TABLE_ROW_HEIGHT }}
        >
          <Handle
            type="target"
            position={Position.Left}
            id={'in:' + column.name}
            aria-label={'Connect to ' + column.name}
          />
          <button
            type="button"
            data-field-button
            className="column-name field-button nodrag nopan"
            title={'Trace ' + column.name}
            aria-pressed={data.fieldFocus === column.name}
            onClick={(event) => {
              event.stopPropagation();
              data.onFieldFocus?.(data.dataset.id, column.name);
            }}
            onKeyDown={(event) => {
              if (
                ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                event.stopPropagation();
                const buttons = Array.from(
                  event.currentTarget
                    .closest('[data-field-table]')!
                    .querySelectorAll<HTMLButtonElement>('[data-field-button]'),
                );
                buttons[
                  nextFieldIndex(buttons.indexOf(event.currentTarget), buttons.length, event.key)
                ]?.focus();
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
              }
            }}
          >
            {data.fieldFocus === column.name && <Home size={13} aria-label="Focal field" />}
            {column.name}
          </button>
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
        <span>
          {data.dataset.row_count?.toLocaleString() ??
            (data.dataset.approximate_row_count != null
              ? '≈ ' + data.dataset.approximate_row_count.toLocaleString()
              : '—')}{' '}
          rows
        </span>
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
      <StatePill state={data.stale ? 'Stale data' : data.external ? 'External' : 'Connected'} />
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
export const edgeTypes = { elk: RoutedEdge };
export const nodeTypes = { table: Table, source: SourceGroup };
