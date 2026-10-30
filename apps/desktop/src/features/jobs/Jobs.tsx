import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { Choice } from '@/components/workbench/FeatureState';
import type { Action } from '@/components/workbench/Field';
import type { Api, Dataset, EngineEvent, Job, Run, Source } from '@/lib/api';
import { Tray } from '@/components/workbench/primitives';
import { RunTable } from './RunTable';
import { SearchableChoice } from '../pipelines/SearchableChoice';
import { useReadOnly } from '@/components/workbench/ReadOnlyScope';
import { CreateJobSheet } from './CreateJobSheet';
import { JobTable } from './JobTable';
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
  readOnly: readOnlyProp = false,
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
  readOnly?: boolean;
}) {
  const readOnly = useReadOnly() || readOnlyProp;
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
      <JobTable
        jobs={jobs}
        datasets={datasets}
        client={client}
        action={action}
        busy={busy}
        readOnly={readOnly}
        onHistory={setJobFilter}
      />
      <CreateJobSheet
        open={open}
        onClose={onClose}
        seed={seed}
        sources={sources}
        datasets={datasets}
        client={client}
        action={action}
        busy={busy}
        readOnly={readOnly}
      />
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
          <SearchableChoice
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
          cancel={
            readOnly
              ? undefined
              : (id) => void action(() => client.cancelRun(id), 'Cancellation requested')
          }
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
