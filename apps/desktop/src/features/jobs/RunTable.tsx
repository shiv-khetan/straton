import { Button } from '@/components/ui/button';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Job, Run } from '@/lib/api';
import { Table as UiTable, StatePill, Icon } from '@/components/workbench/primitives';
import { relativeTime } from '@/lib/view-model';
import { toast } from 'sonner';
import { runStats } from './job-model';
export function RunTable({
  runs,
  jobs,
  cancel,
  busy,
  label = 'Run history',
}: {
  runs: Run[];
  jobs: Job[];
  cancel?: (id: string) => void;
  busy?: boolean;
  label?: string;
}) {
  return runs.length ? (
    <div className="run-history-table">
      <p className="hint">
        Actual start time is unavailable. Times below show scheduled availability.
      </p>
      <UiTable label={label}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Job / run</TableHead>
            <TableHead scope="col">State</TableHead>
            <TableHead scope="col" className="text-right tabular-nums">
              Attempt
            </TableHead>
            <TableHead scope="col" className="text-right tabular-nums">
              Batches
            </TableHead>
            <TableHead scope="col" className="text-right tabular-nums">
              Changes (+ / ~ / −) / read
            </TableHead>
            <TableHead scope="col">Scheduled availability</TableHead>
            <TableHead scope="col">
              <span className="visually-hidden">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell>
                <div className="run-name">
                  <span>
                    {jobs.find((j) => j.id === run.job_id)?.name || run.job_id.slice(0, 8)}
                  </span>
                  <code title={run.id}>{run.id.slice(0, 8)}</code>
                </div>
              </TableCell>
              <TableCell>
                <StatePill state={run.state} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{run.attempt}</TableCell>
              <TableCell className="text-right tabular-nums">{run.committed_batches}</TableCell>
              <TableCell className="text-right tabular-nums">
                <span title={run.fallback_reason ?? undefined}>{runStats(run)}</span>
                {run.fallback_reason && (
                  <span className="ms-2">
                    <StatePill state="warning" label="Full refresh fallback" />
                    <span className="visually-hidden">{run.fallback_reason}</span>
                  </span>
                )}
              </TableCell>
              <TableCell>
                <time
                  dateTime={new Date(run.available_at * 1000).toISOString()}
                  title={
                    new Date(run.available_at * 1000).toLocaleString() +
                    ' · scheduled availability; actual start time is not reported'
                  }
                >
                  {relativeTime(run.available_at * 1000)}
                </time>
                {run.error && (
                  <details className="run-error">
                    <summary>Error</summary>
                    <p>{run.error}</p>
                  </details>
                )}
              </TableCell>
              <TableCell>
                <div className="actions row-actions">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={'Copy run ID ' + run.id.slice(0, 8)}
                    title="Copy full run ID"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(run.id)
                        .then(() => toast.success('Run ID copied'))
                        .catch(() => toast.error('Copy unavailable. Select the run ID to copy.'));
                    }}
                  >
                    <Icon name="copy" />
                  </Button>
                  {cancel && ['queued', 'running'].includes(run.state) && (
                    <Button variant="outline" disabled={busy} onClick={() => cancel(run.id)}>
                      Cancel run
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </UiTable>
    </div>
  ) : (
    <p className="empty">No matching runs.</p>
  );
}
