import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Api, PipelineRunDetail } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import {
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
  useFeatureAction,
} from '@/components/workbench/FeatureState';
import { PageActions, StatePill } from '@/components/workbench/primitives';
import { relativeTime } from '@/lib/view-model';
import { SearchableChoice } from './SearchableChoice';
import { historyPage, historyPageSize } from './history-model';

// Run controls and paged run history for one saved pipeline.
export function RunActions({
  client,
  id,
  disabled,
  onRun,
}: {
  client: Api;
  id: string;
  disabled: boolean;
  onRun: () => void;
}) {
  const action = useFeatureAction();
  return (
    <div className="space-y-2">
      <FeatureError error={action.error} />
      <PageActions>
        <Button
          variant="outline"
          title="Runs the last saved version of this pipeline"
          disabled={disabled || action.pending}
          onClick={() =>
            void action.run(async () => {
              await client.runPipeline(id);
              onRun();
            }, 'Pipeline queued')
          }
        >
          <Play size={16} aria-hidden="true" />
          {action.pending ? 'Queuing…' : 'Run saved version'}
        </Button>
      </PageActions>
    </div>
  );
}
export function RunHistory({
  client,
  id,
  readOnly,
  initialRunId,
}: {
  client: Api;
  id: string;
  readOnly: boolean;
  initialRunId?: string;
}) {
  const [runId, setRunId] = useState(initialRunId ?? '');
  const [page, setPage] = useState(0);
  useEffect(() => setRunId(initialRunId ?? ''), [initialRunId]);
  const runs = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', id, 'history', page],
    queryFn: () => client.pipelineRuns(id, (page + 1) * historyPageSize + 1),
    refetchInterval: 5000,
  });
  const loaded = historyPage(runs.data ?? [], page);
  const current = runId || loaded.rows[0]?.id;
  const run = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', 'run', current],
    queryFn: () => client.pipelineRun(current!),
    enabled: !!current,
    refetchInterval: (q) =>
      ['running', 'queued'].includes(q.state.data?.state ?? '') ? 1000 : false,
  });
  const action = useFeatureAction();
  return (
    <div
      id="pipeline-panel-Run history"
      role="tabpanel"
      aria-labelledby="pipeline-tab-Run history"
      className="space-y-4"
    >
      <FeatureError error={action.error} />
      {runs.isPending && <FeatureLoading />}
      <FeatureError error={runs.error} retry={() => void runs.refetch()} />
      {runs.data?.length === 0 && (
        <FeatureEmpty title="No pipeline runs yet">
          Run the saved pipeline to track each node as it executes.
        </FeatureEmpty>
      )}
      {!!runs.data?.length && (
        <SearchableChoice
          label="Run"
          value={current ?? ''}
          onChange={setRunId}
          options={loaded.rows.map((r) => ({
            value: r.id,
            label:
              (r.started_at ? new Date(r.started_at * 1000).toLocaleString() : 'Queued') +
              ' · ' +
              r.state +
              ' · ' +
              r.id.slice(0, 8),
          }))}
        />
      )}
      {runs.data && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-caption text-ink-2">
            Showing {loaded.first}–{loaded.last} · {runs.data.length} runs loaded, newest first
          </p>
          <Button
            variant="outline"
            disabled={page === 0 || runs.isFetching}
            onClick={() => {
              setPage((value) => value - 1);
              setRunId('');
            }}
          >
            Previous runs
          </Button>
          <Button
            variant="outline"
            disabled={runs.isFetching || runs.data.length <= (page + 1) * historyPageSize}
            onClick={() => {
              setPage((value) => value + 1);
              setRunId('');
            }}
          >
            Next runs
          </Button>
        </div>
      )}
      {current && run.isPending && <FeatureLoading />}
      <FeatureError error={run.error} retry={() => void run.refetch()} />
      {run.data && (
        <>
          <div className="section-toolbar">
            <StatePill state={run.data.state} />
            <span>{run.data.trigger}</span>
            {['queued', 'running'].includes(run.data.state) && (
              <Button
                variant="outline"
                disabled={readOnly || action.pending}
                onClick={() =>
                  void action.run(
                    () => client.cancelPipelineRun(run.data!.id),
                    'Cancellation requested',
                  )
                }
              >
                Cancel run
              </Button>
            )}
          </div>
          {run.data.error && <FeatureError error={run.data.error} />}
          <p className="text-caption text-ink-2">
            These are the actual run-node records. The engine does not provide the executed graph
            snapshot, so historical topology and labels are unavailable.
          </p>
          <RunNodes run={run.data} />
        </>
      )}
    </div>
  );
}
function RunNodes({ run }: { run: PipelineRunDetail }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Child run</TableHead>
          <TableHead>Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {run.nodes.map((n) => (
          <TableRow key={n.node_id}>
            <TableCell>
              <code>{n.node_id}</code>
            </TableCell>
            <TableCell>
              <StatePill state={n.state} />
            </TableCell>
            <TableCell>
              <code>{n.child_run_id ?? '—'}</code>
            </TableCell>
            <TableCell>
              {n.error ??
                (n.started_at ? relativeTime(n.started_at * 1000) : 'Start time unavailable')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
