import { Play, Plus } from 'lucide-react';
import { PageActions } from '@/components/workbench/primitives';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
} from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { ApiError } from '@/lib/api';
import type {
  Api,
  Job,
  Me,
  Model,
  Pipeline,
  PipelineGraph,
  PipelineInput,
  PipelineKind,
  PipelineRunDetail,
  PipelineValidation,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
  Choice,
  useFeatureAction,
} from '@/components/workbench/FeatureState';
import { Tabs, StatePill } from '@/components/workbench/primitives';
import { relativeTime } from '@/lib/view-model';
import {
  dependencyError,
  selectionChange,
  graphValidation,
  placeNodes,
  validationDisplay,
} from './pipeline-model';
import { edgeTypes } from './FlowEdge';
import type { FlowEdgeType } from './FlowEdge';
import { isDirty, saveSnapshot } from './draft-model';
import { useDraftGuard } from './useDraftGuard';
import { SearchableChoice } from './SearchableChoice';
import { historyPage, historyPageSize } from './history-model';
import './styles.css';
const empty = (): PipelineInput => ({
  name: '',
  description: '',
  cron: null,
  enabled: true,
  nodes: [],
  edges: [],
});
type TaskNode = Node<
  { label: string; kind: PipelineKind; state: string; errors: string[] },
  'task'
>;
function Task({ data }: NodeProps<TaskNode>) {
  return (
    <article className={'pipeline-node' + (data.errors.length ? ' invalid' : '')}>
      <Handle type="target" position={Position.Left} />
      <span className="text-caption text-ink-2">{data.kind}</span>
      <strong>{data.label}</strong>
      {data.state && <StatePill state={data.state} />}
      {data.errors.map((e, i) => (
        <span className="text-caption text-danger" key={i}>
          {e}
        </span>
      ))}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
const nodeTypes = { task: Task };
export default function Pipelines({
  client,
  me,
  jobs,
  models,
  readOnly,
  request,
}: {
  client: Api;
  me: Me;
  jobs: Job[];
  models: Model[];
  readOnly: boolean;
  request?: { id: string; runId?: string; nonce: number } | null;
}) {
  const [id, setId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PipelineInput | null>(null);
  const [baseline, setBaseline] = useState<PipelineInput | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('Editor');
  const [requestedRun, setRequestedRun] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (request) {
      guard.request(() => {
        setId(request.id);
        setDraft(null);
        setTab(request.runId ? 'Run history' : 'Editor');
        setRequestedRun(request.runId ?? '');
      });
    }
  }, [request?.nonce]);
  const list = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', 'list'],
    queryFn: () => client.pipelines(),
  });
  const detail = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', 'detail', id],
    queryFn: () => client.pipeline(id!),
    enabled: !!id,
  });
  const mutation = useFeatureAction();
  function open(graph: PipelineGraph) {
    setId(graph.id);
    const next: PipelineInput = {
      name: graph.name,
      description: graph.description,
      cron: graph.cron,
      enabled: graph.enabled,
      ...placeNodes({ nodes: graph.nodes, edges: graph.edges }),
    };
    setDraft(next);
    setBaseline(next);
  }
  const selected = list.data?.find((p) => p.id === id);
  const writable =
    !!draft && (!id || (!!selected && (me.privileges.admin || selected.owner_id === me.user.id)));
  async function saveDraft() {
    if (!draft || readOnly || !writable) throw new Error('This pipeline is read-only.');
    const target = saveSnapshot(id, draft);
    const validation = await client.validatePipeline(target.draft);
    if (!validation.valid)
      throw new Error(validation.errors.map((error) => error.message).join(' '));
    open(
      target.id
        ? await client.updatePipeline(target.id, target.draft)
        : await client.createPipeline(target.draft),
    );
  }
  const guard = useDraftGuard(
    !!draft && isDirty(draft, baseline),
    saveDraft,
    !readOnly && writable && !mutation.pending,
  );
  const visible = (list.data ?? []).filter((pipeline) =>
    pipeline.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <section className="space-y-4">
      <FeatureError error={mutation.error} />
      {!draft && !id ? (
        <>
          <div className="section-toolbar">
            <p className="text-ink-2">Orchestrate syncs, transformations and quality checks.</p>
            <PageActions>
              <Button
                disabled={readOnly}
                onClick={() => {
                  setDraft(empty());
                  setBaseline(empty());
                  setTab('Editor');
                  mutation.clear();
                }}
              >
                <Plus size={16} aria-hidden="true" />
                New pipeline
              </Button>
            </PageActions>
          </div>
          <Field label="Search pipelines by name">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          {!!list.data?.length && (
            <p role="status" className="text-caption text-ink-2">
              {visible.length} of {list.data.length} pipelines
            </p>
          )}
          {!!list.data?.length && !visible.length && (
            <FeatureEmpty
              title="No matching pipelines"
              action="Clear search"
              onAction={() => setSearch('')}
            >
              Try another pipeline name.
            </FeatureEmpty>
          )}
          {list.isPending && <FeatureLoading label="Loading pipelines" />}
          {list.isError && <FeatureError error={list.error} retry={() => void list.refetch()} />}
          {list.data?.length === 0 && (
            <FeatureEmpty
              title="Build your first pipeline"
              action="New pipeline"
              disabled={readOnly}
              onAction={() => {
                setDraft(empty());
                setBaseline(empty());
                setTab('Editor');
              }}
            >
              Connect existing jobs, models and checks in the order they should run.
            </FeatureEmpty>
          )}
          {!!list.data?.length && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pipeline</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Schedule (UTC)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((p) => (
                  <PipelineRow
                    key={p.id}
                    pipeline={p}
                    client={client}
                    onOpen={() => {
                      setId(p.id);
                      setTab('Editor');
                      setRequestedRun('');
                      setConfirmDelete(false);
                      mutation.clear();
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </>
      ) : (
        <>
          <div className="section-toolbar">
            <Button
              variant="ghost"
              onClick={() =>
                guard.request(() => {
                  setDraft(null);
                  setId(null);
                })
              }
            >
              ← Pipelines
            </Button>
            <h2>{draft?.name || selected?.name || 'New pipeline'}</h2>
            {id && writable && (
              <Button
                variant="destructive"
                disabled={readOnly || mutation.pending}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  void mutation.run(async () => {
                    await client.deletePipeline(id);
                    setDraft(null);
                    setId(null);
                    setConfirmDelete(false);
                  }, 'Pipeline deleted');
                }}
              >
                {confirmDelete ? 'Confirm delete' : 'Delete pipeline'}
              </Button>
            )}
          </div>
          {id && !draft && detail.isPending && <FeatureLoading />}
          {id && !draft && detail.isError && (
            <FeatureError error={detail.error} retry={() => void detail.refetch()} />
          )}
          {id && !draft && detail.data && (
            <Button onClick={() => open(detail.data!)}>Open editor</Button>
          )}
          <PipelineDetailLoader graph={detail.data} active={!!id && !draft} onLoad={open} />
          {draft && (
            <>
              <Tabs id="pipeline" items={['Editor', 'Run history']} value={tab} onChange={setTab} />
              {tab === 'Editor' ? (
                <ReactFlowProvider>
                  <Editor
                    me={me}
                    client={client}
                    draft={draft}
                    onChange={setDraft}
                    jobs={jobs}
                    models={models}
                    readOnly={readOnly || !writable || mutation.pending}
                    saving={mutation.pending}
                    save={(validation) =>
                      void mutation.run(async () => {
                        try {
                          await saveDraft();
                        } catch (e) {
                          if (e instanceof ApiError && e.validation) validation(e.validation);
                          throw e;
                        }
                      }, 'Pipeline saved')
                    }
                  />
                </ReactFlowProvider>
              ) : id ? (
                <RunHistory
                  key={id}
                  client={client}
                  id={id}
                  readOnly={readOnly || !writable}
                  initialRunId={requestedRun || undefined}
                />
              ) : (
                <FeatureEmpty title="Save before running">
                  Save the graph in the Editor tab to start its first run.
                </FeatureEmpty>
              )}
            </>
          )}
          {id && (
            <RunActions
              client={client}
              id={id}
              disabled={readOnly || !writable || mutation.pending}
              onRun={() => setTab('Run history')}
            />
          )}
        </>
      )}
      {guard.dialog}
    </section>
  );
}
function PipelineDetailLoader({
  graph,
  active,
  onLoad,
}: {
  graph?: PipelineGraph;
  active: boolean;
  onLoad: (g: PipelineGraph) => void;
}) {
  useEffect(() => {
    if (active && graph) onLoad(graph);
  }, [active, graph]);
  return null;
}
function PipelineRow({
  pipeline: p,
  client,
  onOpen,
}: {
  pipeline: Pipeline;
  client: Api;
  onOpen: () => void;
}) {
  const runs = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', p.id, 'latest'],
    queryFn: () => client.pipelineRuns(p.id, 1),
  });
  const last = runs.data?.[0];
  return (
    <TableRow>
      <TableCell>
        <Button variant="link" onClick={onOpen}>
          {p.name}
        </Button>
        <p className="text-caption text-ink-2">{p.description}</p>
      </TableCell>
      <TableCell>
        {runs.isPending ? (
          <span>Loading…</span>
        ) : runs.isError ? (
          <Button variant="ghost" onClick={() => void runs.refetch()}>
            Retry status
          </Button>
        ) : (
          <StatePill state={last?.state ?? ''} label={last?.state ?? 'Never run'} />
        )}
      </TableCell>
      <TableCell>{last?.started_at ? relativeTime(last.started_at * 1000) : '—'}</TableCell>
      <TableCell>
        <code>{p.cron ?? 'Manual'}</code>
        {!p.enabled && <StatePill state="disabled" />}
      </TableCell>
    </TableRow>
  );
}
function Editor({
  me,
  client,
  draft,
  onChange,
  jobs,
  models,
  readOnly,
  saving,
  save,
}: {
  me: Me;
  client: Api;
  draft: PipelineInput;
  onChange: (v: PipelineInput) => void;
  jobs: Job[];
  models: Model[];
  readOnly: boolean;
  saving: boolean;
  save: (validation: (v: PipelineValidation) => void) => void;
}) {
  const [kind, setKind] = useState<PipelineKind>('sync');
  const [refId, setRefId] = useState('');
  const [selected, setSelected] = useState('');
  const [selectedEdge, setSelectedEdge] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [server, setServer] = useState<PipelineValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<unknown>(null);
  const [validationRevision, setValidationRevision] = useState(0);
  const action = useFeatureAction();
  const checks = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'palette'],
    queryFn: () => client.qualityChecks(),
  });
  const local = useMemo(() => graphValidation(draft), [draft]);
  useEffect(() => {
    let active = true;
    setServer(null);
    setValidationError(null);
    if (!local.valid) {
      setValidating(false);
      return;
    }
    setValidating(true);
    const timer = setTimeout(() => {
      void client
        .validatePipeline(draft)
        .then((v) => {
          if (active) setServer(v);
        })
        .catch((e) => {
          if (active) setValidationError(e);
        })
        .finally(() => {
          if (active) setValidating(false);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft, client, local.valid, validationRevision]);
  const validation = local.valid ? (server ?? local) : local;
  const display = validationDisplay(draft, validation);
  const options =
    kind === 'sync'
      ? jobs
          .filter(
            (j) =>
              !j.builtin &&
              j.source_id &&
              !['straton-models', 'straton-local-lake'].includes(j.source_id),
          )
          .map((j) => ({ value: j.id, label: j.name }))
      : kind === 'transform'
        ? models
            .filter(
              (m) =>
                m.materialization === 'table' && (me.privileges.admin || m.owner_id === me.user.id),
            )
            .map((m) => ({ value: m.id, label: m.name }))
        : (checks.data ?? [])
            .filter((q) => me.privileges.admin || q.owner_id === me.user.id)
            .map((q) => ({ value: q.id, label: q.name }));
  const nodes: TaskNode[] = draft.nodes.map((n) => ({
    id: n.node_id,
    type: 'task',
    position: { x: n.x, y: n.y },
    selected: selected === n.node_id,
    data: {
      label: n.label,
      kind: n.kind,
      state: '',
      errors: display.nodes[n.node_id] ?? [],
    },
  }));
  const edges: FlowEdgeType[] = draft.edges.map((e, i) => ({
    id: String(i),
    source: e.from_node,
    target: e.to_node,
    type: 'flow',
    data: { flow: 'idle' },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    selected: selectedEdge === String(i),
  }));
  const patch = (v: Partial<PipelineInput>) => onChange({ ...draft, ...v });
  function addDependency(source: string, target: string) {
    if (readOnly) return;
    const error = dependencyError(draft, source, target);
    setConnectionError(error);
    if (!error) patch({ edges: [...draft.edges, { from_node: source, to_node: target }] });
  }
  async function arrange() {
    const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
    const result = await new ELK().layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': '40',
        'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      },
      children: draft.nodes.map((n) => ({ id: n.node_id, width: 224, height: 132 })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    });
    patch({
      nodes: draft.nodes.map((n) => {
        const placed = result.children?.find((c) => c.id === n.node_id);
        return { ...n, x: placed?.x ?? n.x, y: placed?.y ?? n.y };
      }),
    });
  }
  return (
    <div
      id="pipeline-panel-Editor"
      role="tabpanel"
      aria-labelledby="pipeline-tab-Editor"
      className="space-y-4"
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            value={draft.name}
            maxLength={200}
            disabled={readOnly}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label="Cron (seconds first, UTC)">
          <Input
            value={draft.cron ?? ''}
            placeholder="0 0 * * * *"
            disabled={readOnly}
            onChange={(e) => patch({ cron: e.target.value || null })}
          />
        </Field>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={draft.enabled}
            disabled={readOnly}
            onCheckedChange={(v) => patch({ enabled: v === true })}
          />
          Schedule enabled
        </label>
      </div>
      <Field label="Description">
        <Textarea
          value={draft.description}
          disabled={readOnly}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label="Node kind"
          value={kind}
          options={['sync', 'transform', 'validate'].map((v) => ({ value: v, label: v }))}
          disabled={readOnly}
          onChange={(v) => {
            setKind(v as PipelineKind);
            setRefId('');
          }}
        />
        <SearchableChoice
          label="Existing reference"
          value={refId}
          options={[{ value: '', label: 'Choose a ' + kind }, ...options]}
          onChange={setRefId}
          disabled={readOnly}
        />
        <Button
          disabled={readOnly || !refId}
          onClick={() => {
            const ref = options.find((o) => o.value === refId);
            if (ref)
              patch({
                nodes: [
                  ...draft.nodes,
                  {
                    node_id: crypto.randomUUID(),
                    kind,
                    ref_id: refId,
                    label: ref.label,
                    x: draft.nodes.length * 260,
                    y: 40,
                  },
                ],
              });
          }}
        >
          Add node
        </Button>
        <Button
          variant="outline"
          disabled={readOnly || !draft.nodes.length || action.pending}
          onClick={() => void action.run(arrange)}
        >
          Auto layout
        </Button>
        <Button
          variant="outline"
          disabled={readOnly || !selected}
          onClick={() => {
            patch({
              nodes: draft.nodes.filter((n) => n.node_id !== selected),
              edges: draft.edges.filter((e) => e.from_node !== selected && e.to_node !== selected),
            });
            setSelected('');
          }}
        >
          Remove selected node
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SearchableChoice
          label="From node"
          value={from}
          onChange={setFrom}
          disabled={readOnly}
          options={draft.nodes.map((node) => ({ value: node.node_id, label: node.label }))}
        />
        <SearchableChoice
          label="To node"
          value={to}
          onChange={setTo}
          disabled={readOnly}
          options={draft.nodes.map((node) => ({ value: node.node_id, label: node.label }))}
        />
        <Button
          variant="outline"
          disabled={readOnly || !from || !to}
          onClick={() => addDependency(from, to)}
        >
          Add dependency
        </Button>
        <Button
          variant="outline"
          disabled={readOnly || !selectedEdge}
          onClick={() => {
            patch({ edges: draft.edges.filter((_, index) => String(index) !== selectedEdge) });
            setSelectedEdge('');
          }}
        >
          Remove selected dependency
        </Button>
      </div>
      <FeatureError error={connectionError} />
      <FeatureError error={checks.error} retry={() => void checks.refetch()} />
      <FeatureError error={action.error} />
      <p className="text-caption text-ink-2">
        Choose From and To nodes, then Add dependency, or connect the canvas handles. Use Tab and
        Enter to select a node or dependency; Delete removes the selection.
      </p>
      <div className="pipeline-canvas">
        <ReactFlow<TaskNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          multiSelectionKeyCode={null}
          selectionKeyCode={null}
          onNodeClick={(_, n) => {
            setSelected(n.id);
            setSelectedEdge('');
          }}
          onEdgeClick={(_, e) => {
            setSelectedEdge(e.id);
            setSelected('');
          }}
          onPaneClick={() => {
            setSelected('');
            setSelectedEdge('');
          }}
          onNodesChange={(changes) => {
            setSelected((current) => selectionChange(current, changes));
            if (changes.some((change) => change.type === 'select' && change.selected))
              setSelectedEdge('');
            if (readOnly) return;
            const moved = changes.filter((c) => c.type === 'position' && c.position !== undefined);
            if (!moved.length) return;
            patch({
              nodes: draft.nodes.map((n) => {
                const change = moved.find((c) => c.type === 'position' && c.id === n.node_id);
                return change?.type === 'position' && change.position
                  ? { ...n, x: change.position.x, y: change.position.y }
                  : n;
              }),
            });
          }}
          onEdgesChange={(changes) => {
            setSelectedEdge((current) => selectionChange(current, changes));
            if (changes.some((change) => change.type === 'select' && change.selected))
              setSelected('');
          }}
          onConnect={(connection) => addDependency(connection.source, connection.target)}
          onEdgesDelete={(removed) => {
            if (!readOnly)
              patch({
                edges: draft.edges.filter((_, i) => !removed.some((e) => e.id === String(i))),
              });
          }}
          onNodesDelete={(removed) => {
            if (!readOnly) {
              const ids = new Set(removed.map((n) => n.id));
              patch({
                nodes: draft.nodes.filter((n) => !ids.has(n.node_id)),
                edges: draft.edges.filter((e) => !ids.has(e.from_node) && !ids.has(e.to_node)),
              });
            }
          }}
          deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          minZoom={0.1}
        >
          <Background color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <section aria-label="Pipeline validation" className="rounded-card border border-line p-4">
        <h3 className="font-medium">Validation</h3>
        {validating ? (
          <p role="status">Validating references…</p>
        ) : (
          <p>
            {validation.valid && server
              ? 'Graph and references are valid.'
              : 'Resolve the errors before saving.'}
          </p>
        )}
        <ul className="space-y-1">
          {validation.errors.map((e, i) => (
            <li key={i} className="text-danger">
              {e.node_id && (
                <Button variant="link" onClick={() => setSelected(e.node_id!)}>
                  {draft.nodes.find((n) => n.node_id === e.node_id)?.label ?? e.node_id}
                </Button>
              )}{' '}
              {e.message}
            </li>
          ))}
        </ul>
        <FeatureError error={validationError} retry={() => setValidationRevision((v) => v + 1)} />
      </section>
      <PageActions>
        <Button
          disabled={
            readOnly || saving || validating || !server?.valid || !local.valid || !!validationError
          }
          onClick={() => save(setServer)}
        >
          {saving ? 'Saving…' : 'Save pipeline'}
        </Button>
      </PageActions>
    </div>
  );
}
function RunActions({
  client,
  id,
  disabled,
  onRun,
}: {
  client: Api;
  id: string;
  disabled: boolean;
  onRun: () => void;
}) {
  const action = useFeatureAction();
  return (
    <div className="space-y-2">
      <FeatureError error={action.error} />
      <PageActions>
        <Button
          variant="outline"
          title="Runs the last saved version of this pipeline"
          disabled={disabled || action.pending}
          onClick={() =>
            void action.run(async () => {
              await client.runPipeline(id);
              onRun();
            }, 'Pipeline queued')
          }
        >
          <Play size={16} aria-hidden="true" />
          {action.pending ? 'Queuing…' : 'Run saved version'}
        </Button>
      </PageActions>
    </div>
  );
}
function RunHistory({
  client,
  id,
  readOnly,
  initialRunId,
}: {
  client: Api;
  id: string;
  readOnly: boolean;
  initialRunId?: string;
}) {
  const [runId, setRunId] = useState(initialRunId ?? '');
  const [page, setPage] = useState(0);
  useEffect(() => setRunId(initialRunId ?? ''), [initialRunId]);
  const runs = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', id, 'history', page],
    queryFn: () => client.pipelineRuns(id, (page + 1) * historyPageSize + 1),
    refetchInterval: 5000,
  });
  const loaded = historyPage(runs.data ?? [], page);
  const current = runId || loaded.rows[0]?.id;
  const run = useQuery({
    queryKey: [...queryKeys.pipelines, 'view', 'run', current],
    queryFn: () => client.pipelineRun(current!),
    enabled: !!current,
    refetchInterval: (q) =>
      ['running', 'queued'].includes(q.state.data?.state ?? '') ? 1000 : false,
  });
  const action = useFeatureAction();
  return (
    <div
      id="pipeline-panel-Run history"
      role="tabpanel"
      aria-labelledby="pipeline-tab-Run history"
      className="space-y-4"
    >
      <FeatureError error={action.error} />
      {runs.isPending && <FeatureLoading />}
      <FeatureError error={runs.error} retry={() => void runs.refetch()} />
      {runs.data?.length === 0 && (
        <FeatureEmpty title="No pipeline runs yet">
          Run the saved pipeline to track each node as it executes.
        </FeatureEmpty>
      )}
      {!!runs.data?.length && (
        <SearchableChoice
          label="Run"
          value={current ?? ''}
          onChange={setRunId}
          options={loaded.rows.map((r) => ({
            value: r.id,
            label:
              (r.started_at ? new Date(r.started_at * 1000).toLocaleString() : 'Queued') +
              ' · ' +
              r.state +
              ' · ' +
              r.id.slice(0, 8),
          }))}
        />
      )}
      {runs.data && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-caption text-ink-2">
            Showing {loaded.first}–{loaded.last} · {runs.data.length} runs loaded, newest first
          </p>
          <Button
            variant="outline"
            disabled={page === 0 || runs.isFetching}
            onClick={() => {
              setPage((value) => value - 1);
              setRunId('');
            }}
          >
            Previous runs
          </Button>
          <Button
            variant="outline"
            disabled={runs.isFetching || runs.data.length <= (page + 1) * historyPageSize}
            onClick={() => {
              setPage((value) => value + 1);
              setRunId('');
            }}
          >
            Next runs
          </Button>
        </div>
      )}
      {current && run.isPending && <FeatureLoading />}
      <FeatureError error={run.error} retry={() => void run.refetch()} />
      {run.data && (
        <>
          <div className="section-toolbar">
            <StatePill state={run.data.state} />
            <span>{run.data.trigger}</span>
            {['queued', 'running'].includes(run.data.state) && (
              <Button
                variant="outline"
                disabled={readOnly || action.pending}
                onClick={() =>
                  void action.run(
                    () => client.cancelPipelineRun(run.data!.id),
                    'Cancellation requested',
                  )
                }
              >
                Cancel run
              </Button>
            )}
          </div>
          {run.data.error && <FeatureError error={run.data.error} />}
          <p className="text-caption text-ink-2">
            These are the actual run-node records. The engine does not provide the executed graph
            snapshot, so historical topology and labels are unavailable.
          </p>
          <RunNodes run={run.data} />
        </>
      )}
    </div>
  );
}
function RunNodes({ run }: { run: PipelineRunDetail }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Child run</TableHead>
          <TableHead>Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {run.nodes.map((n) => (
          <TableRow key={n.node_id}>
            <TableCell>
              <code>{n.node_id}</code>
            </TableCell>
            <TableCell>
              <StatePill state={n.state} />
            </TableCell>
            <TableCell>
              <code>{n.child_run_id ?? '—'}</code>
            </TableCell>
            <TableCell>
              {n.error ??
                (n.started_at ? relativeTime(n.started_at * 1000) : 'Start time unavailable')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
