import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Api,
  Me,
  Model,
  ModelInput,
  ModelExplain,
  ModelLineage,
  EngineEvent,
} from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Inspector,
  Pill,
  Sheet,
  Table,
  Tabs,
} from '@/components/workbench/primitives';
import { modelStatus, normalizeModelLineage } from '@/features/transformations/model-model';
import { datasetState } from '@/features/console/workbench-model';
import { can } from '@/features/access/access-model';
import { datasetLabel, relativeTime } from '@/lib/view-model';
import ModelCanvas from '@/features/transformations/ModelCanvas';
import type { ModelSelection } from '@/features/transformations/ModelCanvas';
import {
  ConsoleDrawer,
  CopyButton,
  ExplainPlan,
  Skeleton,
  StatusChip,
} from '@/features/console/ConsoleDrawer';
const initial: ModelInput = {
  name: '',
  sql: 'SELECT id, name FROM app_db.users',
  materialization: 'table',
  trigger: 'manual',
  cron: null,
  optimize: true,
};
export default function Models({
  client,
  me,
  revision,
  changed,
  events,
  request,
  consoleCollapsed,
  onConsoleCollapsed,
  readOnly,
  onQuery,
  onQueryDataset,
  onSelection,
  jobs,
  runs,
  canCreateJob,
  onCreateJob,
  catalog,
  cachedModels,
}: {
  client: Api;
  me: Me;
  revision: number;
  changed: () => void;
  events: EngineEvent[];
  catalog: import('@/lib/api').DataMap;
  cachedModels: Model[];
  jobs: import('@/lib/api').Job[];
  runs: import('@/lib/api').Run[];
  canCreateJob: (dataset: import('@/lib/api').Dataset) => boolean;
  onCreateJob: (dataset: import('@/lib/api').Dataset) => void;
  request: { id: string | null; nonce: number } | null;
  consoleCollapsed: boolean;
  onConsoleCollapsed: (value: boolean) => void;
  readOnly: boolean;
  onQuery: (model: Model) => void;
  onQueryDataset: (dataset: import('@/lib/api').Dataset) => void;
  onSelection: (name: string, id?: string) => void;
}) {
  const [view, setView] = useState('Canvas');
  const [consoleTab, setConsoleTab] = useState('Live events');
  const [lineages, setLineages] = useState<Record<string, ModelLineage>>({});
  const [graphError, setGraphError] = useState('');
  const [inspected, setInspected] = useState<ModelSelection | null>(null);
  const inspect = useCallback((selection: ModelSelection | null) => {
    explainEpoch.current++;
    setInspected(selection);
    setPlans(null);
  }, []);
  useEffect(() => {
    onSelection(
      inspected?.model?.name ?? datasetLabel(inspected?.dataset),
      inspected?.model?.id ?? inspected?.dataset?.id,
    );
    return () => onSelection('');
  }, [inspected, onSelection]);
  const handledRequest = useRef(0);
  const explainEpoch = useRef(0);
  const [models, setModels] = useState<Model[]>(cachedModels);
  const [loading, setLoading] = useState(!cachedModels.length && !readOnly);
  const [selected, setSelected] = useState<Model | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ModelInput>(initial);
  const [tab, setTab] = useState('Definition');
  const [plans, setPlans] = useState<ModelExplain | null>(null);
  const [lineage, setLineage] = useState<ModelLineage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editable =
    !readOnly && (!selected || me.privileges.admin || selected.owner_id === me.user.id);
  useEffect(() => {
    if (readOnly) {
      setModels(cachedModels);
      setLoading(false);
      return;
    }
    let active = true;
    client
      .models()
      .then((rows) => {
        if (active) {
          setModels(rows);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, revision, readOnly, cachedModels]);
  useEffect(() => {
    if (!selected || !open) return;
    let active = true;
    setLineage(null);
    client
      .modelLineage(selected.id)
      .then((result) => {
        if (active)
          setLineage(
            normalizeModelLineage(
              result,
              catalog.nodes.filter((node) => node.type === 'dataset'),
            ),
          );
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [client, selected, open, revision, catalog.nodes]);
  async function action(work: () => Promise<unknown>, message: string, refresh = true) {
    if (readOnly) {
      setError('Reconnect the engine before continuing.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
      if (refresh) changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(model: Model | null) {
    explainEpoch.current++;
    setSelected(model);
    setDraft(
      model
        ? {
            name: model.name,
            sql: model.sql,
            materialization: model.materialization,
            trigger: model.trigger,
            cron: model.cron,
            optimize: model.optimize,
          }
        : { ...initial },
    );
    setTab('Definition');
    setPlans(null);
    setError('');
    setNotice('');
    setOpen(true);
  }
  useEffect(() => {
    let active = true;
    if (readOnly) return;
    setGraphError('');
    void Promise.allSettled(
      models.map(
        async (model) =>
          [
            model.id,
            normalizeModelLineage(
              await client.modelLineage(model.id),
              catalog.nodes.filter((node) => node.type === 'dataset'),
            ),
          ] as const,
      ),
    ).then((results) => {
      if (!active) return;
      setLineages(
        Object.fromEntries(
          results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
        ),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected')
        setGraphError('Some lineage could not be loaded: ' + String(failure.reason));
    });
    return () => {
      active = false;
    };
  }, [client, models, readOnly, catalog.nodes]);
  useEffect(() => {
    if (!request || handledRequest.current === request.nonce || loading) return;
    const model = request.id ? models.find((m) => m.id === request.id) : null;
    if (request.id && !model) return;
    handledRequest.current = request.nonce;
    edit(model ?? null);
  }, [request, models, loading]);
  const inspectedModel = inspected?.model
    ? models.find((m) => m.id === inspected.model?.id)
    : undefined;
  const policyDataset = inspectedModel
    ? catalog.nodes.find(
        (node): node is import('@/lib/api').Dataset =>
          node.type === 'dataset' &&
          node.sql_schema === 'models' &&
          node.sql_table === inspectedModel.name,
      )
    : inspected?.dataset;
  const inspectLineage = inspectedModel ? lineages[inspectedModel.id] : null;
  const canEditInspected =
    !!inspectedModel &&
    !readOnly &&
    (me.privileges.admin || inspectedModel.owner_id === me.user.id);
  async function loadExplain(id: string) {
    const epoch = ++explainEpoch.current;
    const next = await client.explainModel(id);
    if (epoch === explainEpoch.current) setPlans(next);
  }
  const explainInspected = () => {
    if (!inspectedModel) return;
    setConsoleTab('Explain');
    onConsoleCollapsed(false);
    setPlans(null);
    void action(() => loadExplain(inspectedModel.id), 'Explain ready', false);
  };
  const validate = () =>
    void action(() => client.validateModel(draft), 'SQL is valid for your access.', false);
  return (
    <div className="models-workbench">
      <div className="models-toolbar">
        <Tabs id="model-view" items={['Canvas', 'List']} value={view} onChange={setView} />
        <span className="hint">{models.length} models · lineage from engine catalog</span>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || readOnly}
          onClick={() => edit(null)}
        >
          <Icon name="plus" />
          New model
        </Button>
      </div>
      <div className="models-body">
        <div className="map-center">
          {graphError && (
            <p role="alert" className="message">
              {graphError}
            </p>
          )}
          {view === 'Canvas' &&
            (loading ? (
              <Skeleton label="Loading models…" />
            ) : models.length ? (
              <ModelCanvas
                models={models}
                lineages={lineages}
                jobs={jobs}
                runs={runs}
                relationships={catalog.edges}
                onSelect={inspect}
              />
            ) : (
              <EmptyState
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={readOnly}
                    onClick={() => edit(null)}
                  >
                    New model
                  </Button>
                }
              >
                {readOnly
                  ? 'Models will load when the engine reconnects.'
                  : 'Write your first model'}
              </EmptyState>
            ))}
          {!open && error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!open && notice && <p role="status">{notice}</p>}
          {view === 'List' && (
            <Card className="model-list table-surface" aria-busy={loading}>
              {loading ? (
                <Skeleton label="Loading models…" />
              ) : models.length ? (
                <Table label="SQL models">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Name</TableHead>
                      <TableHead scope="col">Materialization</TableHead>
                      <TableHead scope="col">Trigger</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col">Last run</TableHead>
                      <TableHead scope="col">Rows</TableHead>
                      <TableHead scope="col">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {models.map((m) => {
                      const status = modelStatus(m.status, m.last_run_status);
                      const canEdit =
                        !readOnly && (me.privileges.admin || m.owner_id === me.user.id);
                      return (
                        <TableRow key={m.id} onFocus={() => setInspected({ model: m })}>
                          <TableCell>
                            <Button
                              variant="ghost"
                              className="model-name"
                              disabled={busy}
                              onClick={() => edit(m)}
                            >
                              <code>models.{m.name}</code>
                            </Button>
                            {m.error && <small className="error">{m.error}</small>}
                          </TableCell>
                          <TableCell>
                            <Pill>{m.materialization}</Pill>
                          </TableCell>
                          <TableCell>{m.trigger}</TableCell>
                          <TableCell>
                            <Pill tone={status.tone}>{status.label}</Pill>
                          </TableCell>
                          <TableCell>
                            {m.last_run ? relativeTime(m.last_run * 1000) : 'Never'}
                          </TableCell>
                          <TableCell>
                            {m.materialization === 'view'
                              ? 'On query'
                              : (m.row_count?.toLocaleString() ?? '—')}
                          </TableCell>
                          <TableCell>
                            <div className="actions">
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => edit(m)}
                              >
                                {canEdit ? 'Edit / Explain' : 'Lineage'}
                              </Button>
                              {canEdit && m.materialization === 'table' && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  disabled={busy || m.status === 'broken'}
                                  onClick={() =>
                                    void action(() => client.runModel(m.id), 'Run queued')
                                  }
                                >
                                  Run now
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  action={
                    <Button type="button" variant="default" onClick={() => edit(null)}>
                      New model
                    </Button>
                  }
                >
                  Create a model from a synced dataset. Table models publish snapshots; views run
                  when queried.
                </EmptyState>
              )}
            </Card>
          )}
          <ConsoleDrawer
            tabs={['Live events', 'Run history', 'Explain']}
            tab={consoleTab}
            onTab={(value) => {
              setConsoleTab(value);
              if (value === 'Explain' && inspectedModel && canEditInspected) explainInspected();
            }}
            collapsed={consoleCollapsed}
            onCollapsed={onConsoleCollapsed}
            events={events}
          >
            {consoleTab === 'Explain' ? (
              busy && !plans ? (
                <Skeleton label="Planning…" />
              ) : (
                <ExplainPlan plans={plans} />
              )
            ) : inspectedModel ? (
              <>
                <Table label="Selected model last run">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last run</TableHead>
                      <TableHead>Rows</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>
                        <code>{inspectedModel.name}</code>
                      </TableCell>
                      <TableCell>
                        <StatusChip state={inspectedModel.last_run_status} />
                      </TableCell>
                      <TableCell>
                        {relativeTime(
                          inspectedModel.last_run ? inspectedModel.last_run * 1000 : null,
                        )}
                      </TableCell>
                      <TableCell>{inspectedModel.row_count ?? '—'}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <p className="hint">
                  The engine exposes the latest model run; a model history endpoint is not
                  available.
                </p>
              </>
            ) : (
              <p className="empty">Select a model to see its latest run.</p>
            )}
          </ConsoleDrawer>
        </div>
        {inspected && (
          <Inspector
            entityId={inspectedModel?.id ?? inspected.dataset!.id}
            label="Model selection inspector"
            title={inspectedModel?.name ?? datasetLabel(inspected.dataset)}
            onClose={() => setInspected(null)}
          >
            <div className="inspector-content">
              <Pill>
                <code>{inspectedModel?.id ?? inspected.dataset?.id}</code>
              </Pill>
              <StatusChip
                state={
                  inspectedModel
                    ? inspectedModel.status === 'broken'
                      ? 'failed'
                      : (inspectedModel.last_run_status ?? inspectedModel.status)
                    : inspected.dataset
                      ? datasetState(inspected.dataset, jobs, runs)
                      : null
                }
              />
              <h3>Target</h3>
              <div className="target-path">
                <code>
                  {inspectedModel
                    ? 'models.' + inspectedModel.name
                    : inspected.dataset?.sql_schema + '.' + inspected.dataset?.sql_table}
                </code>
                <CopyButton
                  text={
                    inspectedModel
                      ? 'models.' + inspectedModel.name
                      : inspected.dataset?.sql_schema + '.' + inspected.dataset?.sql_table
                  }
                  label="Copy target"
                />
              </div>
              <h3>Runtime</h3>
              <dl className="runtime-grid">
                <div>
                  <dt>Duration</dt>
                  <dd>—</dd>
                </div>
                <div>
                  <dt>Rows</dt>
                  <dd>
                    {(
                      inspectedModel?.row_count ?? inspected.dataset?.row_count
                    )?.toLocaleString() ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt>Last sync</dt>
                  <dd>
                    {relativeTime(
                      inspectedModel?.last_run
                        ? inspectedModel.last_run * 1000
                        : inspected.dataset?.last_synced_at,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Materialization</dt>
                  <dd>{inspectedModel?.materialization ?? 'dataset'}</dd>
                </div>
              </dl>
              {(['upstream', 'downstream'] as const).map((direction) => (
                <section key={direction}>
                  <h3>{direction}</h3>
                  {inspectLineage?.[direction]?.map((dataset) => (
                    <div className="relationship-item" key={dataset.id}>
                      <StatusChip
                        state={
                          dataset.stale ? 'stale' : dataset.last_synced_at ? 'succeeded' : null
                        }
                      />
                      <code>{datasetLabel(dataset)}</code>
                    </div>
                  ))}
                  {!inspectLineage?.[direction]?.length && (
                    <p className="hint">No visible {direction} datasets.</p>
                  )}
                </section>
              ))}
              {me.privileges.admin && policyDataset && (
                <>
                  <h3>Policies</h3>
                  <Pill>{policyDataset.row_filtered ? 'Row filtered' : 'No row filter'}</Pill>
                  <Pill>{policyDataset.columns.filter((c) => c.masked).length} masks</Pill>
                </>
              )}
              {inspected.dataset && (
                <div className="inspector-actions">
                  <Button
                    type="button"
                    variant="default"
                    disabled={!can(me, 'read')}
                    onClick={() => onQueryDataset(inspected.dataset!)}
                  >
                    Query in SQL
                  </Button>
                  {canCreateJob(inspected.dataset) && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || inspected.dataset.stale || readOnly}
                      onClick={() => onCreateJob(inspected.dataset!)}
                    >
                      Create sync job
                    </Button>
                  )}
                </div>
              )}
              {inspectedModel && (
                <div className="inspector-actions">
                  <Button
                    type="button"
                    variant="default"
                    disabled={!can(me, 'read')}
                    onClick={() => onQuery(inspectedModel)}
                  >
                    Query in SQL
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => edit(inspectedModel)}>
                    Open definition
                  </Button>
                  {canEditInspected && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={
                          busy ||
                          inspectedModel.status === 'broken' ||
                          inspectedModel.materialization === 'view'
                        }
                        onClick={() =>
                          void action(() => client.runModel(inspectedModel.id), 'Run queued')
                        }
                      >
                        Run now
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={explainInspected}
                      >
                        Explain
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </Inspector>
        )}
      </div>
      <Sheet
        open={open}
        title={selected ? 'Model · ' + selected.name : 'New SQL model'}
        onClose={() => setOpen(false)}
      >
        <Tabs
          id="model"
          items={
            selected
              ? editable
                ? ['Definition', 'Lineage', 'Explain']
                : ['Definition', 'Lineage']
              : ['Definition']
          }
          value={tab}
          onChange={(next) => {
            setTab(next);
            if (next === 'Explain' && selected)
              void action(() => loadExplain(selected.id), 'Explain ready', false);
          }}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <section role="tabpanel" id={'model-panel-' + tab} aria-labelledby={'model-tab-' + tab}>
          {tab === 'Definition' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  if (selected) await client.updateModel(selected.id, draft);
                  else await client.createModel(draft);
                  setOpen(false);
                }, 'Model saved');
              }}
            >
              <label className="field">
                <span>Name</span>
                <Input
                  required
                  pattern="[a-z_][a-z0-9_]*"
                  maxLength={128}
                  disabled={!editable}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>SQL · one SELECT</span>
                <Textarea
                  className="model-sql"
                  rows={14}
                  required
                  spellCheck={false}
                  disabled={!editable}
                  value={draft.sql}
                  onChange={(e) => {
                    setDraft({ ...draft, sql: e.target.value });
                    setNotice('');
                  }}
                  onKeyDown={(e) => {
                    if (editable && !busy && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      validate();
                    }
                  }}
                />
              </label>
              <p className="hint">
                Ctrl / Cmd + Enter validates. Table runs use the owner's access. Views use the
                querying user's access.
              </p>
              <div className="form-grid">
                <label className="field">
                  <span>Materialization</span>
                  <select
                    disabled={!editable}
                    value={draft.materialization}
                    onChange={(e) => {
                      const materialization = e.target.value as ModelInput['materialization'];
                      setDraft({
                        ...draft,
                        materialization,
                        ...(materialization === 'view' ? { trigger: 'manual', cron: null } : {}),
                      });
                    }}
                  >
                    <option value="table">Table · published snapshot</option>
                    <option value="view">View · evaluated on query</option>
                  </select>
                </label>
                <label className="field">
                  <span>Trigger</span>
                  <select
                    disabled={!editable || draft.materialization === 'view'}
                    value={draft.trigger}
                    onChange={(e) => {
                      const trigger = e.target.value as ModelInput['trigger'];
                      setDraft({
                        ...draft,
                        trigger,
                        cron: trigger === 'cron' ? '0 */5 * * * *' : null,
                      });
                    }}
                  >
                    <option value="manual">Manual</option>
                    <option value="cron">Cron</option>
                    <option value="upstream">Upstream publish</option>
                  </select>
                </label>
                {draft.trigger === 'cron' && (
                  <label className="field">
                    <span>Cron · UTC, seconds first</span>
                    <Input
                      required
                      disabled={!editable}
                      value={draft.cron ?? ''}
                      onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                    />
                  </label>
                )}
              </div>
              <label>
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={draft.optimize}
                  onChange={(e) => setDraft({ ...draft, optimize: e.target.checked })}
                />{' '}
                Enable Straton optimizer rules
              </label>
              {editable && (
                <div className="actions model-actions">
                  <Button type="button" variant="ghost" disabled={busy} onClick={validate}>
                    Validate SQL
                  </Button>
                  <Button type="submit" variant="default" disabled={busy}>
                    Save model
                  </Button>
                  {selected && selected.materialization === 'table' && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || selected.status === 'broken'}
                      onClick={() => void action(() => client.runModel(selected.id), 'Run queued')}
                    >
                      Run now
                    </Button>
                  )}
                  {selected && (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Delete ' + selected.name + '? Historical runs will be retained.',
                          )
                        )
                          void action(async () => {
                            await client.deleteModel(selected.id);
                            setOpen(false);
                          }, 'Model deleted');
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </form>
          )}
          {tab === 'Lineage' &&
            (lineage ? (
              <div className="model-lineage">
                {(['upstream', 'downstream'] as const).map((direction) => (
                  <section key={direction}>
                    <h3>{direction === 'upstream' ? 'Upstream inputs' : 'Downstream consumers'}</h3>
                    {lineage[direction]?.length ? (
                      <ul>
                        {lineage[direction]?.map((d) => (
                          <li key={d.id}>
                            <code>
                              {d.sql_schema}.{d.sql_table}
                            </code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="hint">No visible {direction} datasets.</p>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <Skeleton label="Loading lineage…" />
            ))}
          {tab === 'Explain' &&
            (plans ? <ExplainPlan plans={plans} /> : <Skeleton label="Planning…" />)}
        </section>
      </Sheet>
    </div>
  );
}
