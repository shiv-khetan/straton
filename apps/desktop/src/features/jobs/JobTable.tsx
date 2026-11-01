import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Field } from '@/components/workbench/Field';
import type { Action } from '@/components/workbench/Field';
import type { Api, Dataset, Job, Run } from '@/lib/api';
import { lastJobRun } from '@/features/overview/attention-model';
import { relativeTime } from '@/lib/view-model';
import {
  Tray,
  Pill,
  StatePill,
  RowMenu,
  Table as UiTable,
} from '@/components/workbench/primitives';
import { datasetLabel } from '@/lib/view-model';
import { CronText } from '@/features/schedules/CronText';

/** Update body that changes only `enabled`; shared by the row menu and bulk actions. */
export function withEnabled(job: Job, enabled: boolean) {
  return {
    name: job.name,
    source_id: job.source_id!,
    dataset: job.dataset,
    cron: job.cron,
    enabled,
    mode: job.mode,
    watermark_column: job.watermark_column,
    key_columns: job.key_columns,
    delete_detection: job.delete_detection,
    key_diff_every_runs: job.key_diff_every_runs,
  };
}
/** Jobs whose enabled state can change (user jobs with a source; not built-ins). */
export const togglable = (job: Job) => !job.builtin && !!job.source_id;

// Sync jobs with name search, selection and bulk actions, run now, enable/disable and history.
export function JobTable({
  jobs,
  runs,
  datasets,
  client,
  action,
  busy,
  readOnly,
  onHistory,
}: {
  jobs: Job[];
  runs: Run[];
  datasets: Dataset[];
  client: Api;
  action: Action;
  busy: boolean;
  readOnly: boolean;
  onHistory: (jobId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visible = jobs.filter((job) =>
    job.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const chosen = jobs.filter((job) => selected.has(job.id));
  const allVisible = visible.length > 0 && visible.every((job) => selected.has(job.id));
  const someVisible = visible.some((job) => selected.has(job.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // One request at a time so a failure stops the batch with a clear message.
  const bulk = (label: string, targets: Job[], run: (job: Job) => Promise<unknown>) =>
    void action(
      async () => {
        for (const job of targets) await run(job);
        setSelected(new Set());
      },
      label + ' ' + targets.length + (targets.length === 1 ? ' job' : ' jobs'),
    );
  const toEnable = chosen.filter((job) => togglable(job) && !job.enabled);
  const toDisable = chosen.filter((job) => togglable(job) && job.enabled);
  return (
    <Tray title="Sync jobs" className="jobs-table">
      <Field label="Search jobs by name">
        <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
      </Field>
      {search &&
        !jobs.some((job) => job.name.toLowerCase().includes(search.trim().toLowerCase())) && (
          <p className="empty">
            No matching jobs.{' '}
            <Button variant="link" onClick={() => setSearch('')}>
              Clear search
            </Button>
          </p>
        )}
      {chosen.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span role="status">{chosen.length} selected</span>
          <Button
            size="sm"
            disabled={readOnly || busy}
            onClick={() => bulk('Queued', chosen, (job) => client.runJob(job.id))}
          >
            Run {chosen.length}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || busy || !toEnable.length}
            onClick={() =>
              bulk('Enabled', toEnable, (job) => client.updateJob(job.id, withEnabled(job, true)))
            }
          >
            Enable
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || busy || !toDisable.length}
            onClick={() =>
              bulk('Disabled', toDisable, (job) =>
                client.updateJob(job.id, withEnabled(job, false)),
              )
            }
          >
            Disable
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}
      <UiTable label="Sync jobs">
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="w-8">
              <Checkbox
                aria-label="Select all visible jobs"
                checked={allVisible ? true : someVisible ? 'indeterminate' : false}
                onCheckedChange={(on) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const job of visible) {
                      if (on === true) next.add(job.id);
                      else next.delete(job.id);
                    }
                    return next;
                  })
                }
              />
            </TableHead>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Dataset</TableHead>
            <TableHead scope="col" className="max-[1100px]:hidden">
              Mode / watermark
            </TableHead>
            <TableHead scope="col">Schedule</TableHead>
            <TableHead scope="col">Last run</TableHead>
            <TableHead scope="col">
              <span className="visually-hidden">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((job) => (
            <TableRow key={job.id} data-state={selected.has(job.id) ? 'selected' : undefined}>
              <TableCell>
                <Checkbox
                  aria-label={'Select ' + job.name}
                  checked={selected.has(job.id)}
                  onCheckedChange={(on) => toggle(job.id, on === true)}
                />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="max-w-44 truncate" title={job.name}>
                    {job.name}
                  </span>
                  {!job.enabled && <StatePill state="Disabled" />}
                </div>
              </TableCell>
              <TableCell className="max-w-48 truncate whitespace-nowrap">
                {job.builtin ? (
                  <span className="text-ink-2">Engine backup</span>
                ) : (
                  datasetLabel(
                    datasets.find(
                      (d) => d.source_id === job.source_id && d.name === job.dataset,
                    ) ?? { name: job.dataset },
                  )
                )}
              </TableCell>
              <TableCell className="max-[1100px]:hidden">
                <div className="flex items-center gap-2 whitespace-nowrap">
                  {job.builtin ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <Pill>{job.mode === 'incremental' ? 'Incremental' : 'Full refresh'}</Pill>
                  )}
                  {job.mode === 'incremental' && (
                    <code className="text-ink-2" title="Watermark">
                      {job.watermark ?? 'No watermark yet'}
                    </code>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <CronText cron={job.cron} />
              </TableCell>
              <TableCell>
                <LastRun
                  summary={lastJobRun(job.id, runs)}
                  onOpen={() => onHistory(job.id)}
                  name={job.name}
                />
              </TableCell>
              <TableCell>
                <div className="actions row-actions">
                  <Button
                    variant="outline"
                    disabled={readOnly || busy}
                    onClick={() => void action(() => client.runJob(job.id), 'Run queued')}
                  >
                    Run now
                  </Button>
                  {/* On narrow windows the Last run cell opens history instead. */}
                  <Button
                    variant="outline"
                    className="max-[1100px]:hidden"
                    onClick={() => onHistory(job.id)}
                  >
                    History
                  </Button>
                  {!job.builtin && job.source_id && (
                    <RowMenu label={'More actions for ' + job.name}>
                      {!job.builtin && job.source_id && (
                        <Button
                          variant="outline"
                          disabled={readOnly || busy}
                          onClick={() =>
                            void action(
                              () => client.updateJob(job.id, withEnabled(job, !job.enabled)),
                              'Job updated',
                            )
                          }
                        >
                          {job.enabled ? 'Disable' : 'Enable'}
                        </Button>
                      )}
                    </RowMenu>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </UiTable>
      {!jobs.length && <p className="empty">Create a job after discovering a source.</p>}
    </Tray>
  );
}

/** Latest finished run: state, when, and a failure streak (×N) when it keeps failing. */
function LastRun({
  summary,
  onOpen,
  name,
}: {
  summary: ReturnType<typeof lastJobRun>;
  onOpen: () => void;
  name: string;
}) {
  if (!summary) return <span className="text-ink-3">Never run</span>;
  return (
    <button
      type="button"
      className="last-run flex items-center gap-2 whitespace-nowrap tabular-nums"
      aria-label={'Run history for ' + name}
      onClick={onOpen}
    >
      <StatePill state={summary.run.state} />
      <span className="text-ink-2">{relativeTime(summary.run.available_at * 1000)}</span>
      {summary.streak > 1 && (
        <span className="text-danger-ink" title={summary.streak + ' failures in a row'}>
          ×{summary.streak}
        </span>
      )}
    </button>
  );
}
