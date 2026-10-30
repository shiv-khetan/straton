import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { isDirty, saveSnapshot } from '../pipelines/draft-model';
import { useDraftGuard } from '../pipelines/useDraftGuard';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Api,
  DataMap,
  Dataset,
  EngineEvent,
  Job,
  Me,
  Model,
  ModelExplain,
  ModelInput,
  ModelLineage,
  Run,
} from '@/lib/api';
import { Button, EmptyState } from '@/components/workbench/primitives';
import { normalizeModelLineage } from '@/features/transformations/model-model';
import { datasetLabel } from '@/lib/view-model';
import ModelCanvas from '@/features/transformations/ModelCanvas';
import type { ModelSelection } from '@/features/transformations/ModelCanvas';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { ModelList } from './ModelList';
import { ModelConsole, ModelInspector } from './ModelPanels';
import type { AsyncState } from './ModelPanels';
import { ModelSheet } from './ModelSheet';
import { PageTabs } from '@/components/workbench/page-layout';
const initial: ModelInput = {
  name: '',
  sql: 'SELECT id, name FROM app_db.users',
  materialization: 'table',
  trigger: 'manual',
  cron: null,
  optimize: true,
};
const idle = { pending: false, error: '', data: null };
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
  catalog: DataMap;
  cachedModels: Model[];
  jobs: Job[];
  runs: Run[];
  canCreateJob: (dataset: Dataset) => boolean;
  onCreateJob: (dataset: Dataset) => void;
  request: { id: string | null; nonce: number } | null;
  consoleCollapsed: boolean;
  onConsoleCollapsed: (value: boolean) => void;
  readOnly: boolean;
  onQuery: (model: Model) => void;
  onQueryDataset: (dataset: Dataset) => void;
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
    setExplainState(idle);
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
  const [baseline, setBaseline] = useState<ModelInput>(initial);
  const [explainState, setExplainState] = useState<AsyncState<ModelExplain>>(idle);
  const [lineageState, setLineageState] = useState<AsyncState<ModelLineage>>(idle);
  const [lineageAttempt, setLineageAttempt] = useState(0);
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
    setLineageState({ pending: true, error: '', data: null });
    client
      .modelLineage(selected.id)
      .then((result) => {
        if (active)
          setLineageState({
            pending: false,
            error: '',
            data: normalizeModelLineage(
              result,
              catalog.nodes.filter((node) => node.type === 'dataset'),
            ),
          });
      })
      .catch((e) => {
        if (active) setLineageState({ pending: false, error: String(e), data: null });
      });
    return () => {
      active = false;
    };
  }, [client, selected, open, revision, catalog.nodes, lineageAttempt]);
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
  function openEditor(model: Model | null) {
    explainEpoch.current++;
    setSelected(model);
    const next: ModelInput = model
      ? {
          name: model.name,
          sql: model.sql,
          materialization: model.materialization,
          trigger: model.trigger,
          cron: model.cron,
          optimize: model.optimize,
        }
      : { ...initial };
    setDraft(next);
    setBaseline(next);
    setTab('Definition');
    setExplainState(idle);
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
        (node): node is Dataset =>
          node.type === 'dataset' &&
          node.sql_schema === 'models' &&
          node.sql_table === inspectedModel.name,
      )
    : inspected?.dataset;
  const canEditInspected =
    !!inspectedModel &&
    !readOnly &&
    (me.privileges.admin || inspectedModel.owner_id === me.user.id);
  async function loadExplain(id: string) {
    const epoch = ++explainEpoch.current;
    setExplainState({ pending: true, error: '', data: null });
    try {
      if (readOnly) throw new Error('Reconnect the engine to load an explain plan.');
      const data = await client.explainModel(id);
      if (epoch === explainEpoch.current) setExplainState({ pending: false, error: '', data });
    } catch (error) {
      if (epoch === explainEpoch.current)
        setExplainState({ pending: false, error: String(error), data: null });
    }
  }
  async function saveDraft() {
    if (!editable) throw new Error('This model is read-only.');
    const target = saveSnapshot(selected?.id ?? null, draft);
    if (!/^[a-z_][a-z0-9_]*$/.test(target.draft.name) || !target.draft.sql.trim())
      throw new Error('Enter a valid model name and SQL before saving.');
    await client.validateModel(target.draft);
    if (target.id) await client.updateModel(target.id, target.draft);
    else await client.createModel(target.draft);
    setBaseline(target.draft);
    changed();
  }
  const guard = useDraftGuard(open && isDirty(draft, baseline), saveDraft, editable && !busy);
  function edit(model: Model | null) {
    guard.request(() => openEditor(model));
  }
  const runModel = (model: Model) => void action(() => client.runModel(model.id), 'Run queued');
  const explainInspected = () => {
    if (!inspectedModel) return;
    setConsoleTab('Explain');
    onConsoleCollapsed(false);
    setExplainState(idle);
    void loadExplain(inspectedModel.id);
  };
  return (
    <div className="models-workbench">
      {/* "New model" lives in the page title row, like every page's primary action. */}
      <PageTabs
        id="model-view"
        items={['Canvas', 'List']}
        value={view}
        onChange={setView}
        aside={models.length + ' models · lineage from engine catalog'}
      />
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
            <ModelList
              models={models}
              loading={loading}
              me={me}
              readOnly={readOnly}
              busy={busy}
              onEdit={edit}
              onInspect={(model) => inspect({ model })}
              onRun={runModel}
            />
          )}
          {!consoleCollapsed && (
            <ModelConsole
              tab={consoleTab}
              onTab={(value) => {
                setConsoleTab(value);
                if (value === 'Explain' && inspectedModel && canEditInspected) explainInspected();
              }}
              onCollapsed={onConsoleCollapsed}
              events={events}
              explainState={explainState}
              inspectedModel={inspectedModel}
              onRetryExplain={() => inspectedModel && void loadExplain(inspectedModel.id)}
            />
          )}
        </div>
        {inspected && (
          <ModelInspector
            inspected={inspected}
            inspectedModel={inspectedModel}
            inspectLineage={inspectedModel ? lineages[inspectedModel.id] : null}
            policyDataset={policyDataset}
            jobs={jobs}
            runs={runs}
            me={me}
            busy={busy}
            readOnly={readOnly}
            canEditInspected={canEditInspected}
            canCreateJob={canCreateJob}
            onClose={() => setInspected(null)}
            onQuery={onQuery}
            onQueryDataset={onQueryDataset}
            onCreateJob={onCreateJob}
            onEdit={edit}
            onRun={runModel}
            onExplain={explainInspected}
          />
        )}
      </div>
      <ModelSheet
        open={open}
        selected={selected}
        editable={editable}
        busy={busy}
        tab={tab}
        onTab={(next) => {
          setTab(next);
          if (next === 'Explain' && selected) void loadExplain(selected.id);
        }}
        error={error}
        notice={notice}
        lineageState={lineageState}
        onRetryLineage={() => setLineageAttempt((value) => value + 1)}
        explainState={explainState}
        onRetryExplain={() => selected && void loadExplain(selected.id)}
        onClose={() => guard.request(() => setOpen(false))}
        draft={draft}
        setDraft={setDraft}
        onSqlEdit={() => setNotice('')}
        onSave={() =>
          void action(
            async () => {
              await saveDraft();
              setOpen(false);
            },
            'Model saved',
            false,
          )
        }
        validate={() =>
          void action(() => client.validateModel(draft), 'SQL is valid for your access.', false)
        }
        onRun={() => selected && runModel(selected)}
        onDelete={async () => {
          if (
            selected &&
            (await confirmDialog('Delete ' + selected.name + '? Historical runs will be retained.'))
          )
            void action(async () => {
              await client.deleteModel(selected.id);
              setOpen(false);
            }, 'Model deleted');
        }}
      />
      {guard.dialog}
    </div>
  );
}
