import { CronField } from '@/features/schedules/CronField';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/workbench/Field';
import type { Action } from '@/components/workbench/Field';
import type { Api, Dataset, Source } from '@/lib/api';
import { Sheet } from '@/components/workbench/primitives';
import { datasetLabel } from '@/lib/view-model';
import { eligibleWatermarkColumns, hasIncrementalSettings } from './job-model';
import { SearchableChoice } from '../pipelines/SearchableChoice';

// New sync job: source and dataset, full or incremental with watermark, keys and delete
// detection, and an optional cron. A seed dataset pre-fills the form each time it opens.
export function CreateJobSheet({
  open,
  onClose,
  seed,
  sources,
  datasets,
  client,
  action,
  busy,
  readOnly,
}: {
  open: boolean;
  onClose: () => void;
  seed: Dataset | null;
  sources: Pick<Source, 'id' | 'name' | 'kind'>[];
  datasets: Dataset[];
  client: Api;
  action: Action;
  busy: boolean;
  readOnly: boolean;
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
  return (
    <Sheet open={open} title="Create sync job" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (readOnly) return;
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
          <SearchableChoice
            label="Source"
            value={source}
            disabled={readOnly}
            onChange={(value) => {
              setSource(value);
              setDataset('');
              setMode('full');
            }}
            options={[
              { value: '', label: 'Select source' },
              ...sources
                .filter((source) =>
                  [
                    'postgres',
                    'sqlserver',
                    'mysql',
                    'mongodb',
                    'sqlite',
                    'csv',
                    'stripe',
                    'salesforce',
                    'noop',
                  ].includes(source.kind),
                )
                .map((source) => ({ value: source.id, label: source.name })),
            ]}
          />
          <SearchableChoice
            label="Dataset"
            value={dataset}
            disabled={readOnly}
            onChange={setDataset}
            options={[
              { value: '', label: 'Select discovered dataset' },
              ...datasets
                .filter((item) => item.source_id === source && !item.stale)
                .map((item) => ({ value: item.name, label: datasetLabel(item) })),
            ]}
          />
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
                  <code>id</code>. If the last sync is older than Stripe's 30-day event window, the
                  run falls back to a full refresh.
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
                  <option value="">Select an integer, date, timestamp or rowversion column</option>
                  {eligibleWatermarkColumns(selectedDataset?.columns ?? [], sourceKind).map((c) => (
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
          <CronField value={cron} onChange={setCron} />
        </div>
        <Button
          variant="default"
          disabled={
            readOnly ||
            busy ||
            !source ||
            !dataset ||
            (mode === 'incremental' && !hasIncrementalSettings(sourceKind, watermark, keys))
          }
        >
          Create job
        </Button>
      </form>
    </Sheet>
  );
}
