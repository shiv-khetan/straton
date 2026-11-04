import { CronField } from '@/features/schedules/CronField';
import { checkPage } from './pagination';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  Api,
  Dataset,
  Me,
  Model,
  QualityCheck,
  QualityInput,
  QualityKind,
  QualityRun,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { Field } from '@/components/workbench/Field';
import {
  Choice,
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
  useFeatureAction,
} from '@/components/workbench/FeatureState';
import { Pill, StatePill, Sparkline, Tray } from '@/components/workbench/primitives';
import { relativeTime } from '@/lib/view-model';
const kinds: QualityKind[] = [
  'not_null',
  'unique',
  'range',
  'freshness',
  'row_count',
  'custom_sql',
  'drift',
];
const label = (kind: string) => kind.replaceAll('_', ' ');
type DriftKey = 'max_row_change' | 'max_null_increase' | 'max_distinct_change';
const driftKeys: DriftKey[] = ['max_row_change', 'max_null_increase', 'max_distinct_change'];
const driftFields: { key: DriftKey; label: string }[] = [
  { key: 'max_row_change', label: 'Row count change (%)' },
  { key: 'max_null_increase', label: 'Null rise (points)' },
  { key: 'max_distinct_change', label: 'Distinct change (%)' },
];
// Fractions are stored; the form shows percentages without floating-point noise.
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const fresh = (): QualityInput => ({
  name: '',
  dataset_id: null,
  model_id: null,
  kind: 'not_null',
  column_name: null,
  config: {},
  severity: 'error',
  cron: null,
  enabled: true,
});
export default function Quality({
  client,
  me,
  datasets,
  models,
  readOnly,
  request,
  createRequest,
}: {
  client: Api;
  me: Me;
  datasets: Dataset[];
  models: Model[];
  readOnly: boolean;
  request?: { id: string; nonce: number } | null;
  createRequest?: number;
}) {
  const checks = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'checks'],
    queryFn: () => client.qualityChecks(),
  });
  const summary = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'summary'],
    queryFn: () => client.qualitySummary(),
  });
  const recent = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'recent'],
    queryFn: () => client.qualityRuns(100),
  });
  const [page, setPage] = useState(0);
  const displayed = checkPage(checks.data ?? [], page);
  const [editing, setEditing] = useState<QualityCheck | 'new' | null>(null);
  useEffect(() => {
    if (createRequest) setEditing('new');
  }, [createRequest]);
  const [history, setHistory] = useState<QualityCheck | null>(null);
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!request || !checks.data || handledRequest.current === request.nonce) return;
    handledRequest.current = request.nonce;
    setHistory(checks.data.find((q) => q.id === request.id) ?? null);
  }, [request?.nonce, checks.data]);
  const action = useFeatureAction();
  const total = summary.data ? Object.values(summary.data.counts).reduce((a, b) => a + b, 0) : 0;
  const writable = (q: QualityCheck) => me.privileges.admin || q.owner_id === me.user.id;
  return (
    <section className="space-y-5">
      <FeatureError error={action.error} />
      {summary.isPending && <FeatureLoading label="Loading quality score" />}
      <FeatureError error={summary.error} retry={() => void summary.refetch()} />
      {summary.data && (
        <div className="flex flex-wrap items-center gap-6 rounded-card border border-line bg-panel p-4">
          <div>
            <h2 className="font-medium">Quality score</h2>
            <span className="text-2xl font-semibold tabular-nums">
              {total ? summary.data.score.toFixed(1) + '%' : '—'}
            </span>
            <span className="ms-2 text-ink-2">
              {total ? 'of latest check runs passed' : 'Run a check to measure quality'}
            </span>
          </div>
          <div className="flex flex-wrap gap-3">
            <StatePill state="passed" label={summary.data.counts.passed + ' passed'} />
            {/* Zero failures carry no alarm colour. */}
            <StatePill
              state={summary.data.counts.failed ? 'failed' : 'idle'}
              label={summary.data.counts.failed + ' failed'}
            />
            <StatePill
              state={summary.data.counts.error ? 'error' : 'idle'}
              label={
                summary.data.counts.error + (summary.data.counts.error === 1 ? ' error' : ' errors')
              }
            />
          </div>
          <div className="ms-auto">
            <p className="text-caption text-ink-2">Daily pass rate · 30 days</p>
            <Sparkline
              series={summary.data.daily.map((d) => (d.total ? d.score : null))}
              label="Daily quality pass rate · 30 days; gaps mean no runs"
              width={180}
              height={40}
              ceiling={100}
              minPoints={7}
            />
          </div>
        </div>
      )}
      {checks.isPending && <FeatureLoading label="Loading quality checks" />}
      <FeatureError error={checks.error} retry={() => void checks.refetch()} />
      {checks.data?.length === 0 && (
        <FeatureEmpty title="Define what good data looks like">
          Start with a required column or a row count using New check above, then schedule checks or
          add them to a pipeline.
        </FeatureEmpty>
      )}
      {!!checks.data?.length && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Check</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Latest runs</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayed.rows.map((q) => (
                <TableRow key={q.id}>
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto justify-start p-0"
                      onClick={() => setHistory(q)}
                    >
                      {q.name}
                    </Button>
                    <p className="text-caption text-ink-2">
                      {label(q.kind)} · {q.enabled ? (q.cron ?? 'Manual') : 'Disabled'}
                    </p>
                  </TableCell>
                  <TableCell>
                    {datasets.find((d) => d.id === q.dataset_id)?.name ??
                      models.find((m) => m.id === q.model_id)?.name ??
                      'Custom query'}
                    {q.column_name && <code className="block text-caption">{q.column_name}</code>}
                  </TableCell>
                  <TableCell>
                    <Pill>{q.severity === 'error' ? 'Error' : 'Warning'}</Pill>
                  </TableCell>
                  <TableCell>
                    <CheckSparkline client={client} id={q.id} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {writable(q) && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={readOnly || action.pending}
                            onClick={() =>
                              void action.run(() => client.runQualityCheck(q.id), 'Check completed')
                            }
                          >
                            Run now
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={readOnly}
                            onClick={() => setEditing(q)}
                          >
                            Edit
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav aria-label="Quality checks pages" className="flex items-center justify-end gap-3">
            <Button
              variant="outline"
              disabled={displayed.page === 0}
              onClick={() => setPage(displayed.page - 1)}
            >
              Previous
            </Button>
            <span role="status">
              Page {displayed.page + 1} of {displayed.pages} · {checks.data.length} checks
            </span>
            <Button
              variant="outline"
              disabled={displayed.page + 1 === displayed.pages}
              onClick={() => setPage(displayed.page + 1)}
            >
              Next
            </Button>
          </nav>
        </>
      )}
      <Tray title="Recent failures">
        {recent.isPending && <FeatureLoading />}
        <FeatureError error={recent.error} retry={() => void recent.refetch()} />
        {recent.data
          ?.filter((r) => r.status !== 'passed')
          .slice(0, 10)
          .map((r) => (
            <div className="overview-row quality-failure" key={r.id}>
              <span>
                {checks.data?.find((q) => q.id === r.check_id)?.name ?? r.check_id}
                <small>{r.message}</small>
              </span>
              <StatePill state={r.status} />
              <time className="tabular-nums" title={new Date(r.started_at * 1000).toLocaleString()}>
                {relativeTime(r.started_at * 1000)}
              </time>
            </div>
          ))}
        {recent.data && !recent.data.some((r) => r.status !== 'passed') && (
          <p className="text-ink-2">No failures in the loaded history.</p>
        )}
      </Tray>
      {!!summary.data?.datasets.length && (
        <details>
          <summary>Scores by dataset</summary>
          {summary.data.datasets.map((s) => (
            <div key={s.dataset_id} className="overview-row">
              <span>{datasets.find((d) => d.id === s.dataset_id)?.name ?? s.dataset_id}</span>
              <code>
                {s.score.toFixed(1)}% · {s.passed}/{s.total}
              </code>
            </div>
          ))}
        </details>
      )}
      {editing && (
        <CheckEditor
          key={editing === 'new' ? 'new' : editing.id}
          check={editing === 'new' ? null : editing}
          client={client}
          datasets={datasets}
          models={models}
          onClose={() => setEditing(null)}
          readOnly={readOnly}
        />
      )}
      {history && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setHistory(null);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{history.name} · history</DialogTitle>
              <DialogDescription>
                Counts and outcomes from the latest 50 runs. Row values are never exposed.
              </DialogDescription>
            </DialogHeader>
            <CheckHistory client={client} id={history.id} />
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
function CheckSparkline({ client, id }: { client: Api; id: string }) {
  const query = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'sparkline', id],
    queryFn: () => client.qualityCheckRuns(id, 12),
  });
  if (query.isPending) return <span role="status">Loading…</span>;
  if (query.isError)
    return (
      <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
        Retry history
      </Button>
    );
  if (!query.data.length) return <span className="text-ink-2">Not run</span>;
  return (
    <div className="flex items-center gap-2">
      <StatePill state={query.data[0].status} />
      <svg
        width="72"
        height="24"
        viewBox="0 0 72 24"
        role="img"
        aria-label="Recent check results, oldest first"
      >
        <title>
          {[...query.data]
            .reverse()
            .map((r) => r.status + ' · ' + new Date(r.started_at * 1000).toLocaleString())
            .join('; ')}
        </title>
        {[...query.data].reverse().map((r, i) => (
          <rect
            key={r.id}
            x={i * 6}
            y={r.status === 'passed' ? 2 : 14}
            width="3"
            height={r.status === 'passed' ? 20 : 8}
            fill={r.status === 'passed' ? 'var(--mark)' : 'var(--danger-ink)'}
          />
        ))}
      </svg>
    </div>
  );
}
function CheckHistory({ client, id }: { client: Api; id: string }) {
  const query = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'history', id],
    queryFn: () => client.qualityCheckRuns(id),
  });
  return (
    <>
      <FeatureError error={query.error} retry={() => void query.refetch()} />
      {query.isPending && <FeatureLoading />}
      {query.data?.length === 0 && <p>No runs yet. Use Run now on the checks table.</p>}
      {query.data?.map((r: QualityRun) => (
        <div key={r.id} className="border-b border-line py-3">
          <div className="flex flex-wrap gap-3">
            <StatePill state={r.status} />
            <time>{new Date(r.started_at * 1000).toLocaleString()}</time>
            <code>
              Observed: {r.observed ?? '—'} · Failing rows: {r.failing_rows ?? '—'}
            </code>
          </div>
          <p className="mt-2 text-ink-2">{r.message}</p>
        </div>
      ))}
    </>
  );
}
function CheckEditor({
  check,
  client,
  datasets,
  models,
  onClose,
  readOnly,
}: {
  check: QualityCheck | null;
  client: Api;
  datasets: Dataset[];
  models: Model[];
  onClose: () => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState<QualityInput>(() =>
    check
      ? {
          name: check.name,
          dataset_id: check.dataset_id,
          model_id: check.model_id,
          kind: check.kind,
          column_name: check.column_name,
          config: check.config,
          severity: check.severity,
          cron: check.cron,
          enabled: check.enabled,
        }
      : fresh(),
  );
  const [min, setMin] = useState(String(check?.config.min ?? ''));
  const [max, setMax] = useState(String(check?.config.max ?? ''));
  const action = useFeatureAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = (v: Partial<QualityInput>) => setDraft((d) => ({ ...d, ...v }));
  const target = draft.model_id
    ? 'model:' + draft.model_id
    : draft.dataset_id
      ? 'dataset:' + draft.dataset_id
      : '';
  const dataset = datasets.find(
    (d) =>
      d.id === draft.dataset_id ||
      (draft.model_id &&
        d.source_id === 'straton-models' &&
        d.name === models.find((m) => m.id === draft.model_id)?.name),
  );
  function bound(s: string) {
    if (draft.kind === 'row_count') {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < 0)
        throw Error('Row count bounds must be nonnegative integers.');
      return n;
    }
    try {
      const v: unknown = JSON.parse(s);
      if (['string', 'number', 'boolean'].includes(typeof v)) return v as string | number | boolean;
    } catch {}
    return s;
  }
  async function save() {
    const config = { ...draft.config };
    if (['range', 'row_count'].includes(draft.kind)) {
      if (!min && !max) throw Error('Enter a minimum or maximum.');
      if (min) config.min = bound(min);
      else delete config.min;
      if (max) config.max = bound(max);
      else delete config.max;
    }
    const body = { ...draft, config };
    if (check) await client.updateQualityCheck(check.id, body);
    else await client.createQualityCheck(body);
    onClose();
  }
  // Why Save is unavailable, shown next to it.
  const missing = !draft.name.trim()
    ? 'Name the check.'
    : draft.kind !== 'custom_sql' && !target
      ? 'Choose a dataset or model.'
      : ['not_null', 'unique', 'range'].includes(draft.kind) && !draft.column_name
        ? 'Choose a column.'
        : draft.kind === 'drift' && !driftKeys.some((k) => draft.config[k] !== undefined)
          ? 'Set at least one drift threshold.'
          : '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.pending) onClose();
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{check ? 'Edit check' : 'New quality check'}</DialogTitle>
          <DialogDescription>
            Run checks manually, on a UTC schedule, or in a pipeline.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(save, 'Check saved');
          }}
        >
          <FeatureError error={action.error} />
          <Field label="Name">
            <Input
              value={draft.name}
              required
              maxLength={200}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Choice
            label="Check kind"
            value={draft.kind}
            options={kinds.map((k) => ({ value: k, label: label(k) }))}
            onChange={(v) => {
              patch({
                kind: v as QualityKind,
                config:
                  v === 'freshness'
                    ? { max_age_seconds: 3600 }
                    : v === 'drift'
                      ? { max_row_change: 0.5, max_null_increase: 0.1 }
                      : {},
                column_name: null,
              });
              setMin('');
              setMax('');
            }}
          />
          <Choice
            label="Dataset or model"
            value={target}
            options={[
              {
                value: '',
                label: draft.kind === 'custom_sql' ? 'No target (custom SQL)' : 'Choose target',
              },
              // The SQL name is unique and readable (lake aliases otherwise show a source UUID).
              ...datasets
                .filter((d) => d.source_id !== 'straton-models')
                .map((d) => ({
                  value: 'dataset:' + d.id,
                  label: d.sql_schema && d.sql_table ? d.sql_schema + '.' + d.sql_table : d.name,
                }))
                .sort((a, b) => a.label.localeCompare(b.label)),
              ...models.map((m) => ({ value: 'model:' + m.id, label: 'Model · ' + m.name })),
            ]}
            onChange={(v) =>
              patch({
                dataset_id: v.startsWith('dataset:') ? v.slice(8) : null,
                model_id: v.startsWith('model:') ? v.slice(6) : null,
                column_name: null,
              })
            }
          />
          {['not_null', 'unique', 'range'].includes(draft.kind) && (
            <Choice
              label="Column"
              value={draft.column_name ?? ''}
              options={[
                { value: '', label: 'Choose column' },
                ...(dataset?.columns ?? []).map((c) => ({
                  value: c.name,
                  label: c.name + ' · ' + c.type,
                })),
              ]}
              onChange={(v) => patch({ column_name: v || null })}
            />
          )}
          {['range', 'row_count'].includes(draft.kind) && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Minimum (optional)">
                <Input value={min} onChange={(e) => setMin(e.target.value)} />
              </Field>
              <Field label="Maximum (optional)">
                <Input value={max} onChange={(e) => setMax(e.target.value)} />
              </Field>
            </div>
          )}
          {draft.kind === 'freshness' && (
            <Field label="Maximum age (seconds)">
              <Input
                type="number"
                required
                min={1}
                value={draft.config.max_age_seconds ?? 3600}
                onChange={(e) => patch({ config: { max_age_seconds: Number(e.target.value) } })}
              />
            </Field>
          )}
          {draft.kind === 'drift' && (
            <fieldset className="grid gap-3 sm:grid-cols-3">
              <legend className="mb-1 text-caption text-ink-2">
                Fails when a change since the last run exceeds a threshold. Leave a field empty to
                ignore it. The first run records a baseline.
              </legend>
              {driftFields.map(({ key, label: text }) => (
                <Field key={key} label={text}>
                  <Input
                    type="number"
                    min={1}
                    max={key === 'max_null_increase' ? 100 : 10000}
                    step="any"
                    value={draft.config[key] === undefined ? '' : round(draft.config[key] * 100)}
                    onChange={(e) => {
                      const config = { ...draft.config };
                      if (e.target.value === '') delete config[key];
                      else config[key] = Number(e.target.value) / 100;
                      patch({ config });
                    }}
                  />
                </Field>
              ))}
            </fieldset>
          )}
          {draft.kind === 'custom_sql' && (
            <Field label="Read-only SQL (passes when it returns zero rows)">
              <Textarea
                className="min-h-36 font-mono"
                required
                value={draft.config.sql ?? ''}
                onChange={(e) => patch({ config: { sql: e.target.value } })}
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice
              label="Severity"
              value={draft.severity}
              options={[
                { value: 'error', label: 'Error · fails a pipeline' },
                { value: 'warn', label: 'Warning · pipeline continues' },
              ]}
              onChange={(v) => patch({ severity: v as 'error' | 'warn' })}
            />
            <CronField
              value={draft.cron ?? ''}
              onChange={(cron) => patch({ cron: cron || null })}
            />
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              // Only meaningful with a schedule; the stored value is kept for when one is set.
              checked={!!draft.cron && draft.enabled}
              disabled={!draft.cron}
              onCheckedChange={(v) => patch({ enabled: v === true })}
            />
            Schedule enabled
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={readOnly || action.pending || !!missing}>
              {action.pending ? 'Saving…' : 'Save check'}
            </Button>
            <Button type="button" variant="outline" disabled={action.pending} onClick={onClose}>
              Cancel
            </Button>
            {check && (
              <Button
                type="button"
                variant="destructive"
                disabled={readOnly || action.pending}
                onClick={() => {
                  if (!confirmDelete) setConfirmDelete(true);
                  else
                    void action.run(async () => {
                      await client.deleteQualityCheck(check.id);
                      onClose();
                    }, 'Check deleted');
                }}
              >
                {confirmDelete ? 'Confirm delete' : 'Delete check'}
              </Button>
            )}
            {missing && !readOnly && <span className="hint self-center">{missing}</span>}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
