import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Button, Icon, Inspector, Pill, Table as UiTable } from '@/components/workbench/primitives';
import type { Api, DataMap, Dataset, Job, MapSource, Relationship, Run } from '@/lib/api';
import { CopyButton, StatusChip } from '@/features/console/ConsoleDrawer';
import { datasetJobs, datasetRun, datasetState } from '@/features/console/workbench-model';
import { tableReference } from '@/features/sql/sql-model';
import { datasetLabel, relativeTime, syncableKinds } from '@/lib/view-model';

type Shared = {
  map: DataMap;
  jobs: Job[];
  runs: Run[];
  canManage: boolean;
  busy: boolean;
  client: Api;
  action: (work: () => Promise<unknown>, message?: string) => Promise<void>;
};

const findDataset = (map: DataMap, id: string) =>
  map.nodes.find((n): n is Dataset => n.type === 'dataset' && n.id === id);

// Right-hand inspector for the selected table or relationship on the Data Map.
export function SelectionInspector({
  dataset,
  edge,
  onClose,
  onSelectRelationship,
  onRemoveSelected,
  canCreateJob,
  onQuery,
  onCreateJob,
  ...shared
}: Shared & {
  dataset?: Dataset;
  edge?: Relationship;
  onClose: () => void;
  onSelectRelationship: (id: string) => void;
  onRemoveSelected: () => void;
  canCreateJob: (dataset: Dataset) => boolean;
  onQuery: (dataset: Dataset) => void;
  onCreateJob: (dataset: Dataset) => void;
}) {
  return (
    <Inspector
      entityId={dataset?.id ?? edge!.id}
      label="Selection inspector"
      title={dataset ? datasetLabel(dataset) : 'Relationship'}
      onClose={onClose}
    >
      <div className="inspector-content">
        {dataset ? (
          <DatasetDetails
            {...shared}
            dataset={dataset}
            onSelectRelationship={onSelectRelationship}
            canCreateJob={canCreateJob(dataset)}
            onQuery={() => onQuery(dataset)}
            onCreateJob={() => onCreateJob(dataset)}
          />
        ) : (
          edge && <EdgeDetails {...shared} edge={edge} onRemove={onRemoveSelected} />
        )}
      </div>
    </Inspector>
  );
}

function DatasetDetails({
  map,
  jobs,
  runs,
  canManage,
  busy,
  client,
  action,
  dataset,
  onSelectRelationship,
  canCreateJob,
  onQuery,
  onCreateJob,
}: Shared & {
  dataset: Dataset;
  onSelectRelationship: (id: string) => void;
  canCreateJob: boolean;
  onQuery: () => void;
  onCreateJob: () => void;
}) {
  const selectedJobs = datasetJobs(dataset, jobs);
  const lastRun = datasetRun(dataset, jobs, runs);
  const target = tableReference(dataset.sql_schema, dataset.sql_table);
  const sourceKind =
    (map.nodes.find((n) => n.id === dataset.source_id) as MapSource | undefined)?.kind ?? '';
  return (
    <>
      <Pill>
        <code title={dataset.id}>{dataset.id}</code>
      </Pill>
      <StatusChip state={datasetState(dataset, jobs, runs)} />
      {dataset.dataset_type === 'view' && <Pill>View</Pill>}
      <h3>Target</h3>
      <div className="target-path">
        <code>{target}</code>
        <CopyButton text={target} label="Copy SQL target" />
      </div>
      <h3>Runtime</h3>
      <dl className="runtime-grid">
        <div>
          <dt>Duration</dt>
          <dd title="Run duration is not exposed by this engine">—</dd>
        </div>
        <div>
          <dt>Rows</dt>
          <dd>{dataset.row_count?.toLocaleString() ?? '—'}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd title={dataset.last_synced_at ?? undefined}>
            {relativeTime(dataset.last_synced_at)}
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
            <Pill>{dataset.row_filtered ? 'Row filter active' : 'No row filter'}</Pill>
            <Pill>{dataset.columns.filter((c) => c.masked).length} masked columns</Pill>
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
          {dataset.columns.map((c) => (
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
                    e.from_dataset === dataset.id &&
                    e.from_cols.includes(c.name),
                ) && <Pill>FK</Pill>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </UiTable>
      {(['Incoming', 'Outgoing'] as const).map((direction) => {
        const related = map.edges.filter(
          (e) => (direction === 'Incoming' ? e.to_dataset : e.from_dataset) === dataset.id,
        );
        return (
          <div key={direction}>
            <h3>{direction === 'Incoming' ? 'Upstream' : 'Downstream'}</h3>
            {related.map((e) => {
              const other = findDataset(
                map,
                direction === 'Incoming' ? e.from_dataset : e.to_dataset,
              );
              return (
                <Button
                  variant="ghost"
                  className="relationship-item"
                  key={e.id}
                  onClick={() => onSelectRelationship(e.id)}
                >
                  <StatusChip state={other ? datasetState(other, jobs, runs) : null} />
                  <span>
                    {datasetLabel(other)}
                    <small>{e.kind.replaceAll('_', ' ')}</small>
                  </span>
                </Button>
              );
            })}
            {!related.length && <p className="hint">No relationships</p>}
          </div>
        );
      })}
      <div className="inspector-actions">
        {lastRun && ['running', 'queued'].includes(lastRun.state) && canCreateJob && (
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
        {selectedJobs[0] && canCreateJob && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy || dataset.stale}
            onClick={() => void action(() => client.runJob(selectedJobs[0].id), 'Run queued')}
          >
            Run now
          </Button>
        )}
        <Button type="button" variant="default" onClick={onQuery}>
          <Icon name="sql" />
          Query in SQL
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !canCreateJob || dataset.stale || !syncableKinds.includes(sourceKind)}
          onClick={onCreateJob}
        >
          <Icon name="plus" />
          Create sync job
        </Button>
      </div>
    </>
  );
}

function EdgeDetails({
  map,
  canManage,
  busy,
  edge,
  onRemove,
}: Shared & { edge: Relationship; onRemove: () => void }) {
  return (
    <>
      <Pill>{edge.kind.replaceAll('_', ' ')}</Pill>
      <dl>
        <dt>Confidence</dt>
        <dd>
          {edge.confidence === null ? 'Not specified' : Math.round(edge.confidence * 100) + '%'}
        </dd>
        <dt>From</dt>
        <dd className="mono">
          {datasetLabel(findDataset(map, edge.from_dataset))} (
          {edge.from_cols.join(', ') || 'dataset'})
        </dd>
        <dt>To</dt>
        <dd className="mono">
          {datasetLabel(findDataset(map, edge.to_dataset))} ({edge.to_cols.join(', ') || 'dataset'})
        </dd>
      </dl>
      {canManage && edge.kind === 'manual' && (
        <Button type="button" variant="destructive" disabled={busy} onClick={onRemove}>
          Delete manual edge
        </Button>
      )}
    </>
  );
}
