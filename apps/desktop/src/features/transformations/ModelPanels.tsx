import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { FeatureError } from '@/components/workbench/FeatureState';
import type {
  Dataset,
  EngineEvent,
  Job,
  Me,
  Model,
  ModelExplain,
  ModelLineage,
  Run,
} from '@/lib/api';
import { Button, Inspector, Pill, Table } from '@/components/workbench/primitives';
import { can } from '@/features/access/access-model';
import { datasetState } from '@/features/console/workbench-model';
import { datasetLabel, relativeTime } from '@/lib/view-model';
import {
  ConsoleDrawer,
  CopyButton,
  ExplainPlan,
  Skeleton,
  StatusChip,
} from '@/features/console/ConsoleDrawer';
import type { ModelSelection } from './ModelCanvas';

export type AsyncState<T> = { pending: boolean; error: string; data: T | null };

// Bottom console on the Models page: live events, the selected model's last run, and Explain.
export function ModelConsole({
  tab,
  onTab,
  onCollapsed,
  events,
  explainState,
  inspectedModel,
  onRetryExplain,
}: {
  tab: string;
  onTab: (tab: string) => void;
  onCollapsed: (value: boolean) => void;
  events: EngineEvent[];
  explainState: AsyncState<ModelExplain>;
  inspectedModel?: Model;
  onRetryExplain: () => void;
}) {
  return (
    <ConsoleDrawer
      tabs={['Live events', 'Run history', 'Explain']}
      tab={tab}
      onTab={onTab}
      collapsed
      onCollapsed={onCollapsed}
      events={events}
    >
      {tab === 'Explain' ? (
        explainState.pending ? (
          <Skeleton label="Planning…" />
        ) : explainState.error ? (
          <FeatureError
            error={explainState.error}
            retry={inspectedModel ? onRetryExplain : undefined}
          />
        ) : (
          <ExplainPlan plans={explainState.data} />
        )
      ) : inspectedModel ? (
        <>
          <Table label="Selected model last run">
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Rows</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>
                  <code>{inspectedModel.name}</code>
                </TableCell>
                <TableCell>
                  <StatusChip state={inspectedModel.last_run_status} />
                </TableCell>
                <TableCell>
                  {relativeTime(inspectedModel.last_run ? inspectedModel.last_run * 1000 : null)}
                </TableCell>
                <TableCell>{inspectedModel.row_count ?? '—'}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="hint">
            The engine exposes the latest model run; a model history endpoint is not available.
          </p>
        </>
      ) : (
        <p className="empty">Select a model to see its latest run.</p>
      )}
    </ConsoleDrawer>
  );
}

// Right-hand inspector for a model or dataset selected on the model canvas or list.
export function ModelInspector({
  inspected,
  inspectedModel,
  inspectLineage,
  policyDataset,
  jobs,
  runs,
  me,
  busy,
  readOnly,
  canEditInspected,
  canCreateJob,
  onClose,
  onQuery,
  onQueryDataset,
  onCreateJob,
  onEdit,
  onRun,
  onExplain,
}: {
  inspected: ModelSelection;
  inspectedModel?: Model;
  inspectLineage: ModelLineage | null | undefined;
  policyDataset?: Dataset;
  jobs: Job[];
  runs: Run[];
  me: Me;
  busy: boolean;
  readOnly: boolean;
  canEditInspected: boolean;
  canCreateJob: (dataset: Dataset) => boolean;
  onClose: () => void;
  onQuery: (model: Model) => void;
  onQueryDataset: (dataset: Dataset) => void;
  onCreateJob: (dataset: Dataset) => void;
  onEdit: (model: Model) => void;
  onRun: (model: Model) => void;
  onExplain: () => void;
}) {
  return (
    <Inspector
      entityId={inspectedModel?.id ?? inspected.dataset!.id}
      label="Model selection inspector"
      title={inspectedModel?.name ?? datasetLabel(inspected.dataset)}
      onClose={onClose}
    >
      <div className="inspector-content">
        <Pill>
          <code>{inspectedModel?.id ?? inspected.dataset?.id}</code>
        </Pill>
        <StatusChip
          state={
            inspectedModel
              ? inspectedModel.status === 'broken'
                ? 'failed'
                : (inspectedModel.last_run_status ?? inspectedModel.status)
              : inspected.dataset
                ? datasetState(inspected.dataset, jobs, runs)
                : null
          }
        />
        <h3>Target</h3>
        <div className="target-path">
          <code>
            {inspectedModel
              ? 'models.' + inspectedModel.name
              : inspected.dataset?.sql_schema + '.' + inspected.dataset?.sql_table}
          </code>
          <CopyButton
            text={
              inspectedModel
                ? 'models.' + inspectedModel.name
                : inspected.dataset?.sql_schema + '.' + inspected.dataset?.sql_table
            }
            label="Copy target"
          />
        </div>
        <h3>Runtime</h3>
        <dl className="runtime-grid">
          <div>
            <dt>Duration</dt>
            <dd>—</dd>
          </div>
          <div>
            <dt>Rows</dt>
            <dd>
              {(inspectedModel?.row_count ?? inspected.dataset?.row_count)?.toLocaleString() ?? '—'}
            </dd>
          </div>
          <div>
            <dt>Last sync</dt>
            <dd>
              {relativeTime(
                inspectedModel?.last_run
                  ? inspectedModel.last_run * 1000
                  : inspected.dataset?.last_synced_at,
              )}
            </dd>
          </div>
          <div>
            <dt>Materialization</dt>
            <dd>{inspectedModel?.materialization ?? 'dataset'}</dd>
          </div>
        </dl>
        {(['upstream', 'downstream'] as const).map((direction) => (
          <section key={direction}>
            <h3>{direction}</h3>
            {inspectLineage?.[direction]?.map((dataset) => (
              <div className="relationship-item" key={dataset.id}>
                <StatusChip
                  state={dataset.stale ? 'stale' : dataset.last_synced_at ? 'succeeded' : null}
                />
                <code>{datasetLabel(dataset)}</code>
              </div>
            ))}
            {!inspectLineage?.[direction]?.length && (
              <p className="hint">No visible {direction} datasets.</p>
            )}
          </section>
        ))}
        {me.privileges.admin && policyDataset && (
          <>
            <h3>Policies</h3>
            <Pill>{policyDataset.row_filtered ? 'Row filtered' : 'No row filter'}</Pill>
            <Pill>{policyDataset.columns.filter((c) => c.masked).length} masks</Pill>
          </>
        )}
        {inspected.dataset && (
          <div className="inspector-actions">
            <Button
              type="button"
              variant="default"
              disabled={!can(me, 'read')}
              onClick={() => onQueryDataset(inspected.dataset!)}
            >
              Query in SQL
            </Button>
            {canCreateJob(inspected.dataset) && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy || inspected.dataset.stale || readOnly}
                onClick={() => onCreateJob(inspected.dataset!)}
              >
                Create sync job
              </Button>
            )}
          </div>
        )}
        {inspectedModel && (
          <div className="inspector-actions">
            <Button
              type="button"
              variant="default"
              disabled={!can(me, 'read')}
              onClick={() => onQuery(inspectedModel)}
            >
              Query in SQL
            </Button>
            <Button type="button" variant="ghost" onClick={() => onEdit(inspectedModel)}>
              Open definition
            </Button>
            {canEditInspected && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={
                    busy ||
                    inspectedModel.status === 'broken' ||
                    inspectedModel.materialization === 'view'
                  }
                  onClick={() => onRun(inspectedModel)}
                >
                  Run now
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={onExplain}>
                  Explain
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Inspector>
  );
}
