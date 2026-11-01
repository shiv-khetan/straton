import { CronField } from '@/features/schedules/CronField';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReactFlow, Background, Controls, Handle, MarkerType, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type {
  Api,
  Job,
  Me,
  Model,
  PipelineInput,
  PipelineKind,
  PipelineValidation,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/workbench/Field';
import { FeatureError, Choice, useFeatureAction } from '@/components/workbench/FeatureState';
import { PageActions, StatePill } from '@/components/workbench/primitives';
import {
  dependencyError,
  selectionChange,
  graphValidation,
  validationDisplay,
} from './pipeline-model';
import { edgeTypes } from './FlowEdge';
import type { FlowEdgeType } from './FlowEdge';
import { SearchableChoice } from './SearchableChoice';

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

// Local graph checks run on every edit; reference checks go to the engine, debounced.
function usePipelineValidation(draft: PipelineInput, client: Api) {
  const [server, setServer] = useState<PipelineValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const local = useMemo(() => graphValidation(draft), [draft]);
  useEffect(() => {
    let active = true;
    setServer(null);
    setError(null);
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
          if (active) setError(e);
        })
        .finally(() => {
          if (active) setValidating(false);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft, client, local.valid, revision]);
  return {
    local,
    server,
    setServer,
    validating,
    error,
    retry: () => setRevision((v) => v + 1),
    validation: local.valid ? (server ?? local) : local,
  };
}

export function Editor({
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
  const [selected, setSelected] = useState('');
  const [selectedEdge, setSelectedEdge] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const check = usePipelineValidation(draft, client);
  const display = validationDisplay(draft, check.validation);
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
  return (
    <div
      id="pipeline-panel-Editor"
      role="tabpanel"
      aria-labelledby="pipeline-tab-Editor"
      className="space-y-4"
    >
      <DraftFields draft={draft} patch={patch} readOnly={readOnly} />
      <NodeToolbar
        me={me}
        client={client}
        draft={draft}
        patch={patch}
        jobs={jobs}
        models={models}
        readOnly={readOnly}
        selected={selected}
        onRemoved={() => setSelected('')}
      />
      <DependencyToolbar
        draft={draft}
        readOnly={readOnly}
        selectedEdge={selectedEdge}
        onAdd={addDependency}
        onRemoveSelected={() => {
          patch({ edges: draft.edges.filter((_, index) => String(index) !== selectedEdge) });
          setSelectedEdge('');
        }}
      />
      <FeatureError error={connectionError} />
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
        {check.validating ? (
          <p role="status">Validating references…</p>
        ) : (
          <p>
            {check.validation.valid && check.server
              ? 'Graph and references are valid.'
              : 'Resolve the errors before saving.'}
          </p>
        )}
        <ul className="space-y-1">
          {check.validation.errors.map((e, i) => (
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
        <FeatureError error={check.error} retry={check.retry} />
      </section>
      <PageActions>
        <Button
          disabled={
            readOnly ||
            saving ||
            check.validating ||
            !check.server?.valid ||
            !check.local.valid ||
            !!check.error
          }
          onClick={() => save(check.setServer)}
        >
          {saving ? 'Saving…' : 'Save pipeline'}
        </Button>
      </PageActions>
    </div>
  );
}

type Patch = (v: Partial<PipelineInput>) => void;

function DraftFields({
  draft,
  patch,
  readOnly,
}: {
  draft: PipelineInput;
  patch: Patch;
  readOnly: boolean;
}) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            value={draft.name}
            maxLength={200}
            disabled={readOnly}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <CronField
          value={draft.cron ?? ''}
          disabled={readOnly}
          onChange={(cron) => patch({ cron: cron || null })}
        />
        <label className="flex items-center gap-2">
          <Checkbox
            // Only meaningful with a schedule; the stored value is kept for when one is set.
            checked={!!draft.cron && draft.enabled}
            disabled={readOnly || !draft.cron}
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
    </>
  );
}

// Adds existing jobs, models or checks as nodes; also auto layout and node removal.
function NodeToolbar({
  me,
  client,
  draft,
  patch,
  jobs,
  models,
  readOnly,
  selected,
  onRemoved,
}: {
  me: Me;
  client: Api;
  draft: PipelineInput;
  patch: Patch;
  jobs: Job[];
  models: Model[];
  readOnly: boolean;
  selected: string;
  onRemoved: () => void;
}) {
  const [kind, setKind] = useState<PipelineKind>('sync');
  const [refId, setRefId] = useState('');
  const action = useFeatureAction();
  const checks = useQuery({
    queryKey: [...queryKeys.quality, 'view', 'palette'],
    queryFn: () => client.qualityChecks(),
  });
  const owns = (owner: string | null | undefined) => me.privileges.admin || owner === me.user.id;
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
            .filter((m) => m.materialization === 'table' && owns(m.owner_id))
            .map((m) => ({ value: m.id, label: m.name }))
        : (checks.data ?? [])
            .filter((q) => owns(q.owner_id))
            .map((q) => ({ value: q.id, label: q.name }));
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
      edges: draft.edges.map((e, i) => ({
        id: String(i),
        sources: [e.from_node],
        targets: [e.to_node],
      })),
    });
    patch({
      nodes: draft.nodes.map((n) => {
        const placed = result.children?.find((c) => c.id === n.node_id);
        return { ...n, x: placed?.x ?? n.x, y: placed?.y ?? n.y };
      }),
    });
  }
  return (
    <>
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
            onRemoved();
          }}
        >
          Remove selected node
        </Button>
      </div>
      <FeatureError error={checks.error} retry={() => void checks.refetch()} />
      <FeatureError error={action.error} />
    </>
  );
}

function DependencyToolbar({
  draft,
  readOnly,
  selectedEdge,
  onAdd,
  onRemoveSelected,
}: {
  draft: PipelineInput;
  readOnly: boolean;
  selectedEdge: string;
  onAdd: (from: string, to: string) => void;
  onRemoveSelected: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const options = draft.nodes.map((node) => ({ value: node.node_id, label: node.label }));
  return (
    <div className="flex flex-wrap items-end gap-3">
      <SearchableChoice
        label="From node"
        value={from}
        onChange={setFrom}
        disabled={readOnly}
        options={options}
      />
      <SearchableChoice
        label="To node"
        value={to}
        onChange={setTo}
        disabled={readOnly}
        options={options}
      />
      <Button variant="outline" disabled={readOnly || !from || !to} onClick={() => onAdd(from, to)}>
        Add dependency
      </Button>
      <Button variant="outline" disabled={readOnly || !selectedEdge} onClick={onRemoveSelected}>
        Remove selected dependency
      </Button>
    </div>
  );
}
