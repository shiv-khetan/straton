import { Button } from '@/components/ui/button';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Job, Run } from '@/lib/api';
import { Table as UiTable, Pill, stateTone } from '@/components/workbench/primitives';
import { runStats } from './job-model';
export function RunTable({
  runs,
  jobs,
  cancel,
  busy,
}: {
  runs: Run[];
  jobs: Job[];
  cancel?: (id: string) => void;
  busy?: boolean;
}) {
  return runs.length ? (
    <UiTable label="Run history">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Job / run</TableHead>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Attempt</TableHead>
          <TableHead scope="col">Batches</TableHead>
          <TableHead scope="col">Changes (+ / ~ / −) / read</TableHead>
          <TableHead scope="col">Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>
              {jobs.find((j) => j.id === run.job_id)?.name || run.job_id}
              <small>
                <code>{run.id}</code>
              </small>
            </TableCell>
            <TableCell>
              <Pill tone={stateTone(run.state)}>{run.state}</Pill>
            </TableCell>
            <TableCell>{run.attempt}</TableCell>
            <TableCell>{run.committed_batches}</TableCell>
            <TableCell>
              <code>{runStats(run)}</code>
              {run.fallback_reason && (
                <small title={run.fallback_reason} tabIndex={0}>
                  <Pill tone="warning">Full refresh fallback</Pill>
                  <span className="visually-hidden">{run.fallback_reason}</span>
                </small>
              )}
            </TableCell>
            <TableCell>
              {run.error || new Date(run.available_at * 1000).toLocaleString()}
              {cancel && ['queued', 'running'].includes(run.state) && (
                <Button variant="outline" disabled={busy} onClick={() => cancel(run.id)}>
                  Cancel run
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </UiTable>
  ) : (
    <p className="empty">No matching runs.</p>
  );
}
