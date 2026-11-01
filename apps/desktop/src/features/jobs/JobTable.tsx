import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Field } from '@/components/workbench/Field';
import type { Action } from '@/components/workbench/Field';
import type { Api, Dataset, Job } from '@/lib/api';
import {
  Tray,
  Pill,
  StatePill,
  RowMenu,
  Table as UiTable,
} from '@/components/workbench/primitives';
import { datasetLabel } from '@/lib/view-model';
import { CronText } from '@/features/schedules/CronText';

// Sync jobs with name search, run now, enable/disable and a jump to each job's history.
export function JobTable({
  jobs,
  datasets,
  client,
  action,
  busy,
  readOnly,
  onHistory,
}: {
  jobs: Job[];
  datasets: Dataset[];
  client: Api;
  action: Action;
  busy: boolean;
  readOnly: boolean;
  onHistory: (jobId: string) => void;
}) {
  const [search, setSearch] = useState('');
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
      <UiTable label="Sync jobs">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Dataset</TableHead>
            <TableHead scope="col">Mode / watermark</TableHead>
            <TableHead scope="col">Schedule</TableHead>
            <TableHead scope="col">
              <span className="visually-hidden">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs
            .filter((job) => job.name.toLowerCase().includes(search.trim().toLowerCase()))
            .map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <span className="max-w-44 truncate" title={job.name}>
                      {job.name}
                    </span>
                    <StatePill state={job.enabled ? 'Enabled' : 'Disabled'} />
                  </div>
                </TableCell>
                <TableCell>
                  {datasetLabel(
                    datasets.find(
                      (d) => d.source_id === job.source_id && d.name === job.dataset,
                    ) ?? { name: job.dataset },
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <Pill>{job.mode === 'incremental' ? 'Incremental' : 'Full refresh'}</Pill>
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
                  <div className="actions row-actions">
                    <Button
                      variant="outline"
                      disabled={readOnly || busy}
                      onClick={() => void action(() => client.runJob(job.id), 'Run queued')}
                    >
                      Run now
                    </Button>
                    <Button variant="outline" onClick={() => onHistory(job.id)}>
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
                                () =>
                                  client.updateJob(job.id, {
                                    name: job.name,
                                    source_id: job.source_id!,
                                    dataset: job.dataset,
                                    cron: job.cron,
                                    enabled: !job.enabled,
                                    mode: job.mode,
                                    watermark_column: job.watermark_column,
                                    key_columns: job.key_columns,
                                    delete_detection: job.delete_detection,
                                    key_diff_every_runs: job.key_diff_every_runs,
                                  }),
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
