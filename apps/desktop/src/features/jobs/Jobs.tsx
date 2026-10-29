import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { useEffect, useState } from 'react';
import { Field } from '@/components/workbench/Field';
import { Choice } from '@/components/workbench/FeatureState';
import type { Action } from '@/components/workbench/Field';
import type { Api, Dataset, EngineEvent, Job, Run, Source } from '@/lib/api';
import {
  Tray,
  Pill,
  StatePill,
  Sheet,
  RowMenu,
  Table as UiTable,
} from '@/components/workbench/primitives';
import { datasetLabel } from '@/lib/view-model';
import { eligibleWatermarkColumns, hasIncrementalSettings } from './job-model';
import { RunTable } from './RunTable';
export default function Jobs({
  sources,
  datasets,
  jobs,
  runs,
  events,
  initialStateFilter,
  focusRun,
  client,
  action,
  busy,
  open,
  onClose,
  seed,
}: {
  sources: Pick<Source, 'id' | 'name' | 'kind'>[];
  datasets: Dataset[];
  jobs: Job[];
  runs: Run[];
  events: EngineEvent[];
  initialStateFilter: string;
  focusRun?: { id: string; nonce: number } | null;
  client: Api;
  action: Action;
  busy: boolean;
  open: boolean;
  onClose: () => void;
  seed: Dataset | null;
}) {
  const [name, setName] = useState(seed ? 'Sync ' + datasetLabel(seed) : '');
  const [source, setSource] = useState(seed?.source_id ?? '');
  const [dataset, setDataset] = useState(seed?.name ?? '');
  useEffect(() => {
    if (open) {
      setName(seed ? 'Sync ' + datasetLabel(seed) : '');
      setSource(seed?.source_id ?? '');
      setDataset(seed?.name ?? '');
    }
  }, [seed, open]);
  const [mode, setMode] = useState<'full' | 'incremental'>('full');
  const [watermark, setWatermark] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [deletes, setDeletes] = useState<'none' | 'key_diff'>('none');
  const [every, setEvery] = useState(10);
  const selectedDataset = datasets.find((d) => d.source_id === source && d.name === dataset);
  const sourceKind = sources.find((s) => s.id === source)?.kind;
  const csv = sourceKind === 'csv';
  // Stripe tracks changes through its events feed: no watermark, key or delete settings.
  const eventsSource = sourceKind === 'stripe' || sourceKind === 'salesforce';
  useEffect(() => {
    setWatermark('');
    setKeys(selectedDataset?.columns.filter((c) => c.pk).map((c) => c.name) ?? []);
  }, [source, dataset, open]);
  useEffect(() => {
    if (open) {
      setMode('full');
      setDeletes('none');
      setEvery(10);
    }
  }, [open]);
  const [cron, setCron] = useState('0 */5 * * * *');
  const [jobFilter, setJobFilter] = useState('');
  const [stateFilter, setStateFilter] = useState(initialStateFilter);
  useEffect(() => setStateFilter(initialStateFilter), [initialStateFilter]);
  const [focusedRun, setFocusedRun] = useState(focusRun?.id ?? '');
  useEffect(() => {
    if (focusRun) {
      setFocusedRun(focusRun.id);
      setJobFilter('');
      setStateFilter('');
    }
  }, [focusRun?.nonce]);
  useEffect(() => {
    if (focusedRun)
      requestAnimationFrame(() =>
        document.getElementById('notification-run')?.scrollIntoView({ block: 'center' }),
      );
  }, [focusedRun]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Jobs</h1>
          <p className="hint">Keep your local lake in sync.</p>
        </div>
      </div>
      <Tray title="Sync jobs" className="jobs-table">
        <UiTable label="Sync jobs">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Dataset</TableHead>
              <TableHead scope="col">Mode / watermark</TableHead>
              <TableHead scope="col">Schedule (UTC)</TableHead>
              <TableHead scope="col">
                <span className="visually-hidden">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
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
                  <code>{job.cron || 'Manual'}</code>
                </TableCell>
                <TableCell>
                  <div className="actions row-actions">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void action(() => client.runJob(job.id), 'Run queued')}
                    >
                      Run now
                    </Button>
                    {!job.builtin && job.source_id && (
                      <RowMenu label={'More actions for ' + job.name}>
                        {' '}
                        {!job.builtin && job.source_id && (
                          <Button
                            variant="outline"
                            disabled={busy}
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
                    <Button variant="outline" onClick={() => setJobFilter(job.id)}>
                      History
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </UiTable>
        {!jobs.length && <p className="empty">Create a job after discovering a source.</p>}
      </Tray>
      <Sheet open={open} title="Create sync job" onClose={onClose}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await client.createJob({
                name,
                source_id: source,
                dataset,
                cron: cron.trim() || null,
                enabled: true,
                mode,
                watermark_column: mode === 'incremental' && !eventsSource ? watermark : null,
                key_columns: mode === 'incremental' && !eventsSource ? keys : null,
                delete_detection: mode === 'incremental' && !eventsSource ? deletes : 'none',
                key_diff_every_runs:
                  mode === 'incremental' && !eventsSource && deletes === 'key_diff' ? every : 0,
              });
              setName('');
              onClose();
            }, 'Job created');
          }}
        >
          <div className="form-grid">
            <Field label="Job name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Source">
              <select
                required
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setDataset('');
                  setMode('full');
                }}
              >
                <option value="">Select source</option>
                {sources
                  .filter((s) =>
                    ['postgres', 'sqlite', 'csv', 'stripe', 'salesforce', 'noop'].includes(s.kind),
                  )
                  .map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Dataset">
              <select required value={dataset} onChange={(e) => setDataset(e.target.value)}>
                <option value="">Select discovered dataset</option>
                {datasets
                  .filter((d) => d.source_id === source && !d.stale)
                  .map((d) => (
                    <option key={d.id} value={d.name}>
                      {datasetLabel(d)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Mode">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'full' | 'incremental')}
                aria-describedby={csv ? 'csv-incremental-help' : undefined}
              >
                <option value="full">Full refresh</option>
                <option value="incremental" disabled={csv}>
                  Incremental
                </option>
              </select>
            </Field>
            {csv && (
              <p id="csv-incremental-help" className="hint">
                CSV supports full refresh only.
              </p>
            )}
            {mode === 'incremental' && eventsSource && (
              <p className="hint">
                {sourceKind === 'stripe' ? (
                  <>
                    Uses Stripe events: updates and deletes since the last sync are merged by{' '}
                    <code>id</code>. If the last sync is older than Stripe's 30-day event window,
                    the run falls back to a full refresh.
                  </>
                ) : (
                  <>
                    Uses <code>queryAll</code> on <code>SystemModstamp</code>: changed and deleted
                    records since the last sync are merged by <code>Id</code>. If the last sync is
                    older than 14 days, the run falls back to a full refresh.
                  </>
                )}
              </p>
            )}
            {mode === 'incremental' && !eventsSource && (
              <>
                <Field label="Watermark column">
                  <select required value={watermark} onChange={(e) => setWatermark(e.target.value)}>
                    <option value="">Select an integer, date or timestamp column</option>
                    {eligibleWatermarkColumns(selectedDataset?.columns ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} · {c.type}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Key columns">
                  <select
                    multiple
                    required
                    size={Math.min(6, Math.max(2, selectedDataset?.columns.length ?? 2))}
                    value={keys}
                    onChange={(e) => setKeys(Array.from(e.target.selectedOptions, (o) => o.value))}
                    aria-describedby="key-columns-help"
                  >
                    {selectedDataset?.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                        {c.pk ? ' (PK)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <p id="key-columns-help" className="hint">
                  Defaults to the primary key. Use Ctrl or Command to select several columns. Keys
                  must be unique and non-null.
                </p>
                <Field label="Delete detection">
                  <select
                    value={deletes}
                    onChange={(e) => setDeletes(e.target.value as 'none' | 'key_diff')}
                  >
                    <option value="none">None</option>
                    <option value="key_diff">Key diff every N runs</option>
                  </select>
                </Field>
                {deletes === 'key_diff' && (
                  <Field label="Key diff interval (successful runs)">
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      required
                      value={every}
                      onChange={(e) => setEvery(Number(e.target.value))}
                      aria-describedby="key-diff-help"
                    />
                  </Field>
                )}
                {deletes === 'key_diff' && (
                  <p id="key-diff-help" className="hint">
                    Scans all source keys at this interval. 0 disables delete detection.
                  </p>
                )}
              </>
            )}
            <Field label="Cron (UTC, seconds first)">
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                aria-describedby="cron-help"
              />
            </Field>
          </div>
          <p id="cron-help" className="hint">
            Six fields: second minute hour day month weekday. “0 */5 * * * *” runs every five
            minutes. Leave blank for manual runs.
          </p>
          <Button
            variant="default"
            disabled={
              busy ||
              !dataset ||
              (mode === 'incremental' && !hasIncrementalSettings(sourceKind, watermark, keys))
            }
          >
            Create job
          </Button>
        </form>
      </Sheet>
      {focusedRun && (
        <section id="notification-run" className="mb-4 rounded-card border border-line p-4">
          <div className="section-toolbar">
            <h2>Notification run</h2>
            <Button variant="ghost" onClick={() => setFocusedRun('')}>
              Dismiss
            </Button>
          </div>
          <RunTable runs={runs.filter((r) => r.id === focusedRun)} jobs={jobs} />
          {!runs.some((r) => r.id === focusedRun) && (
            <p className="hint">
              Run <code>{focusedRun}</code> is outside the loaded run history.
            </p>
          )}
        </section>
      )}
      <Tray title="Run history" className="run-history-card">
        <div className="toolbar">
          <Choice
            label="Job"
            value={jobFilter}
            onChange={setJobFilter}
            options={[
              { value: '', label: 'All jobs' },
              ...jobs.map((j) => ({ value: j.id, label: j.name })),
            ]}
          />
          <Choice
            label="State"
            value={stateFilter}
            onChange={setStateFilter}
            options={[
              { value: '', label: 'All states' },
              ...['queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'].map(
                (state) => ({ value: state, label: state[0].toUpperCase() + state.slice(1) }),
              ),
            ]}
          />
        </div>
        <RunTable
          runs={runs.filter(
            (r) =>
              (!jobFilter || r.job_id === jobFilter) && (!stateFilter || r.state === stateFilter),
          )}
          jobs={jobs}
          cancel={(id) => void action(() => client.cancelRun(id), 'Cancellation requested')}
          busy={busy}
        />
      </Tray>
      <Tray title="Live activity">
        <p className="hint">
          Run state events from the engine. Historical log text is not exposed by this engine
          version.
        </p>
        <div className="event-log" role="log" aria-live="polite">
          {events
            .filter((e) => e.type.startsWith('run.') || e.type.includes('log'))
            .slice(0, 30)
            .map((e, i) => (
              <div key={i}>
                <code>{e.type}</code> {e.id} {e.state} {e.message}
              </div>
            ))}
        </div>
      </Tray>
    </>
  );
}
