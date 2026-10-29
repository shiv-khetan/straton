import { useRouteStore } from '@/stores/route';
import { useDraftExit, useDraftValue } from './DraftExit';
import { clearDraft, draftKey, readDraft, snapshotSave, writeDraft } from './draft-store';
import type { DashboardContinuation } from './draft-store';
import { Plus } from 'lucide-react';
import { PageActions } from '@/components/workbench/primitives';
import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useQuery } from '@tanstack/react-query';
import { autocomplete, editorTheme } from '@/features/sql/monaco';
import { useResolvedTheme } from '@/stores/theme';
import type { Api, Chart, ChartData, ChartInput, ChartKind, Me } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/workbench/Field';
import { Pill } from '@/components/workbench/primitives';
import {
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
  Choice,
  useFeatureAction,
} from '@/components/workbench/FeatureState';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { ChartPreview } from './ChartPreview';
const fresh = (): ChartInput => ({
  name: '',
  sql: 'SELECT 1 AS value',
  kind: 'stat',
  config: { y: ['value'] },
  shared: false,
});
function AnalyticsLibrary({
  client,
  me,
  scope,
  readOnly,
}: {
  client: Api;
  me: Me;
  scope: string;
  readOnly: boolean;
}) {
  const charts = useQuery({
    queryKey: [...queryKeys.charts, 'view', 'library'],
    queryFn: () => client.charts(),
  });
  const continuation = readDraft<DashboardContinuation>(draftKey(scope, 'dashboard-continuation'));
  const [editing, setEditing] = useDraftValue<Chart | 'new' | null>(draftKey(scope, 'chart'), () =>
    continuation ? 'new' : null,
  );
  return (
    <section className="space-y-4">
      {editing ? (
        <Builder
          key={editing === 'new' ? 'new' : editing.id}
          chart={editing === 'new' ? null : editing}
          client={client}
          me={me}
          scope={scope}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="section-toolbar">
            <p className="text-ink-2">
              Saved charts built from SQL, with your access rules applied.
            </p>
            <PageActions>
              <Button disabled={readOnly} onClick={() => setEditing('new')}>
                <Plus size={16} aria-hidden="true" />
                New chart
              </Button>
            </PageActions>
          </div>
          {charts.isPending && <FeatureLoading label="Loading charts" />}
          <FeatureError error={charts.error} retry={() => void charts.refetch()} />
          {charts.data?.length === 0 && (
            <FeatureEmpty
              title="Turn a query into a chart"
              action="New chart"
              disabled={readOnly}
              onAction={() => setEditing('new')}
            >
              Map columns from a read-only SQL query, preview it, and add the saved chart to a
              dashboard.
            </FeatureEmpty>
          )}
          {!!charts.data?.length && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chart</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {charts.data.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Button variant="link" onClick={() => setEditing(c)}>
                        {c.name}
                      </Button>
                    </TableCell>
                    <TableCell>{c.kind}</TableCell>
                    <TableCell>
                      <Pill>{c.shared ? 'Shared' : 'Private'}</Pill>
                    </TableCell>
                    <TableCell>
                      <time>{new Date(c.updated_at * 1000).toLocaleString()}</time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}
function Builder({
  chart,
  client,
  me,
  scope,
  readOnly,
  onClose,
}: {
  chart: Chart | null;
  client: Api;
  me: Me;
  scope: string;
  readOnly: boolean;
  onClose: () => void;
}) {
  const key = draftKey(scope, 'chart', chart?.id ?? 'new');
  const [draft, setDraft] = useDraftValue<ChartInput>(key, () =>
    chart
      ? {
          name: chart.name,
          sql: chart.sql,
          kind: chart.kind,
          config: chart.config,
          shared: chart.shared,
        }
      : fresh(),
  );
  const baseline = chart
    ? {
        name: chart.name,
        sql: chart.sql,
        kind: chart.kind,
        config: chart.config,
        shared: chart.shared,
      }
    : fresh();
  const exit = useDraftExit(JSON.stringify(draft) !== JSON.stringify(baseline), () => {
    clearDraft(key);
    setDraft(baseline);
  });
  const close = () =>
    exit.request(() => {
      clearDraft(key);
      onClose();
      const continuationKey = draftKey(scope, 'dashboard-continuation');
      if (readDraft<DashboardContinuation>(continuationKey)) {
        clearDraft(continuationKey);
        exit.allow(() => useRouteStore.getState().navigate('Dashboards'));
      }
    });
  const [preview, setPreview] = useState<ChartData | null>(null);
  const [previewSql, setPreviewSql] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [theme, setTheme] = useState('vs');
  const dark = useResolvedTheme() === 'dark';
  const mounted = useRef(true);
  const previewGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setTheme(editorTheme(dark));
  }, [dark]);
  const tables = useQuery({
    queryKey: [...queryKeys.catalog, 'view', 'chart-builder'],
    queryFn: () => client.sqlTables(),
  });
  useEffect(() => {
    const provider = autocomplete(tables.data?.tables ?? []);
    return () => provider.dispose();
  }, [tables.data]);
  const action = useFeatureAction();
  const execution = useFeatureAction();
  const writable = !chart || me.privileges.admin || chart.owner_id === me.user.id;
  const patch = (v: Partial<ChartInput>) => setDraft((d) => ({ ...d, ...v }));
  const columns = preview?.columns ?? [];
  const options = [
    { value: '', label: 'None' },
    ...columns.map((c) => ({ value: c.name, label: c.name + ' · ' + c.type })),
  ];
  const mapping = (v: Partial<ChartInput['config']>) => {
    const config = { ...draft.config, ...v };
    for (const k of ['x', 'series', 'time_column'] as const) if (!config[k]) delete config[k];
    patch({ config });
  };
  return (
    <div className="space-y-4">
      <div className="section-toolbar">
        <Button variant="ghost" disabled={action.pending} onClick={close}>
          ← Chart library
        </Button>
        <h2>{chart?.name ?? 'New chart'}</h2>
        {!writable && <Pill>Read only · shared chart</Pill>}
      </div>
      <FeatureError error={action.error} />
      <FeatureError error={execution.error} />
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Chart name">
          <Input
            required
            maxLength={200}
            value={draft.name}
            disabled={!writable || readOnly}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Choice
          label="Chart kind"
          value={draft.kind}
          options={['line', 'bar', 'area', 'stat', 'table'].map((k) => ({ value: k, label: k }))}
          onChange={(v) => patch({ kind: v as ChartKind })}
          disabled={!writable || readOnly}
        />
        <label className="flex items-center gap-2">
          <Checkbox
            checked={draft.shared}
            disabled={!writable || readOnly}
            onCheckedChange={(v) => patch({ shared: v === true })}
          />
          Shared with workspace
        </label>
      </div>
      <section className="overflow-hidden rounded-card border border-line">
        <h3 className="border-b border-line bg-panel px-4 py-2 font-medium">SQL</h3>
        <Editor
          height="260px"
          language="sql"
          value={draft.sql}
          theme={theme}
          loading={<FeatureLoading label="Loading SQL editor" />}
          options={{
            readOnly: !writable || readOnly,
            minimap: { enabled: false },
            automaticLayout: true,
            fontFamily: 'JetBrains Mono Variable',
            fontSize: 13,
            scrollBeyondLastLine: false,
          }}
          onChange={(v) => {
            previewGeneration.current++;
            patch({ sql: v ?? '' });
            setPreview(null);
          }}
        />
      </section>
      <FeatureError error={tables.error} retry={() => void tables.refetch()} />
      <Button
        variant="outline"
        disabled={readOnly || execution.pending || !draft.sql.trim()}
        onClick={() =>
          void execution.run(async () => {
            const generation = ++previewGeneration.current;
            // Discover columns before validating mappings left over from an earlier query.
            const result = await client.previewChart({ sql: draft.sql, config: {} });
            if (mounted.current && generation === previewGeneration.current) {
              setPreview(result);
              setPreviewSql(draft.sql);
              const names = new Set(result.columns.map((c) => c.name));
              setDraft((current) => {
                const config = {
                  ...current.config,
                  y: current.config.y?.filter((y) => names.has(y)),
                };
                for (const key of ['x', 'series', 'time_column'] as const)
                  if (config[key] && !names.has(config[key]!)) delete config[key];
                return { ...current, config };
              });
            }
          }, 'Preview updated')
        }
      >
        {execution.pending ? 'Running query…' : 'Run preview'}
      </Button>
      <p className="text-caption text-ink-2">
        Preview returns up to 5,000 rows. Run the SQL to populate column mapping choices.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Choice
          label="X column"
          value={draft.config.x ?? ''}
          options={options}
          onChange={(v) => mapping({ x: v })}
          disabled={!writable || readOnly}
        />
        <Choice
          label="Series column (optional)"
          value={draft.config.series ?? ''}
          options={options}
          onChange={(v) => mapping({ series: v })}
          disabled={!writable || readOnly}
        />
        <Choice
          label="Time column (optional)"
          value={draft.config.time_column ?? ''}
          options={options}
          onChange={(v) => mapping({ time_column: v })}
          disabled={!writable || readOnly}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">Y columns</legend>
        <div className="flex flex-wrap gap-4">
          {[
            ...new Set([
              ...columns.filter((c) => /int|float|double|decimal/i.test(c.type)).map((c) => c.name),
              ...(draft.config.y ?? []),
            ]),
          ].map((name) => (
            <label key={name} className="flex items-center gap-2">
              <Checkbox
                disabled={!writable || readOnly}
                checked={draft.config.y?.includes(name) ?? false}
                onCheckedChange={(v) =>
                  mapping({
                    y:
                      v === true
                        ? [...(draft.config.y ?? []), name]
                        : (draft.config.y ?? []).filter((k) => k !== name),
                  })
                }
              />
              {name}
            </label>
          ))}
          {!columns.length && !draft.config.y?.length && (
            <p className="text-ink-2">Run a preview to choose numeric columns.</p>
          )}
        </div>
      </fieldset>
      <section className="rounded-card border border-line p-4">
        <h3 className="mb-3 font-medium">Preview</h3>
        {execution.pending ? (
          <FeatureLoading label="Executing chart query" />
        ) : preview ? (
          <ChartPreview data={preview} kind={draft.kind} config={draft.config} scope={scope} />
        ) : (
          <p className="py-6 text-ink-2">Run preview to see your query results.</p>
        )}
      </section>
      {exit.dialog}
      {writable && (
        <PageActions>
          <Button variant="outline" disabled={action.pending} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={
              readOnly ||
              action.pending ||
              execution.pending ||
              !draft.name.trim() ||
              !draft.sql.trim()
            }
            onClick={() =>
              void action.run(async () => {
                const snapshot = snapshotSave(chart?.id, draft);
                const result = snapshot.target
                  ? await client.updateChart(snapshot.target, snapshot.value)
                  : await client.createChart(snapshot.value);
                clearDraft(key);
                const continuationKey = draftKey(scope, 'dashboard-continuation');
                const continuation = readDraft<DashboardContinuation>(continuationKey);
                if (continuation) {
                  writeDraft(continuationKey, { ...continuation, chartId: result.id });
                  exit.allow(() => {
                    onClose();
                    useRouteStore.getState().navigate('Dashboards');
                  });
                } else exit.allow(onClose);
              }, 'Chart saved')
            }
          >
            {action.pending ? 'Saving…' : 'Save chart'}
          </Button>
          {chart && (
            <Button
              variant="destructive"
              disabled={readOnly || action.pending}
              onClick={() => {
                if (!deleting) setDeleting(true);
                else
                  void action.run(async () => {
                    await client.deleteChart(chart.id);
                    clearDraft(key);
                    exit.allow(onClose);
                  }, 'Chart deleted');
              }}
            >
              {deleting ? 'Confirm delete' : 'Delete chart'}
            </Button>
          )}
        </PageActions>
      )}
      {preview && previewSql !== draft.sql && (
        <p className="text-ink-2">SQL changed. Run preview again.</p>
      )}
    </div>
  );
}

export default function Analytics(props: Parameters<typeof AnalyticsLibrary>[0]) {
  return <AnalyticsLibrary key={props.scope} {...props} />;
}
