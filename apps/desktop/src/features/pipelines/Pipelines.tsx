import { Plus } from 'lucide-react';
import { PageActions } from '@/components/workbench/primitives';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { ApiError } from '@/lib/api';
import type { Api, Job, Me, Model, Pipeline, PipelineGraph, PipelineInput } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  useFeatureAction,
} from '@/components/workbench/FeatureState';
import { Tabs, StatePill } from '@/components/workbench/primitives';
import { relativeTime } from '@/lib/view-model';
import { placeNodes } from './pipeline-model';
import { isDirty, saveSnapshot } from './draft-model';
import { useDraftGuard } from './useDraftGuard';
import { Editor } from './PipelineEditor';
import { RunActions, RunHistory } from './PipelineRuns';
import './styles.css';
import { PageIntro } from '@/components/workbench/page-layout';
const empty = (): PipelineInput => ({
  name: '',
  description: '',
  cron: null,
  enabled: true,
  nodes: [],
  edges: [],
});
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
  return (
    <section className="space-y-4">
      <FeatureError error={mutation.error} />
      {!draft && !id ? (
        <PipelineList
          client={client}
          pipelines={list}
          readOnly={readOnly}
          onNew={() => {
            setDraft(empty());
            setBaseline(empty());
            setTab('Editor');
            mutation.clear();
          }}
          onOpen={(pipelineId) => {
            setId(pipelineId);
            setTab('Editor');
            setRequestedRun('');
            setConfirmDelete(false);
            mutation.clear();
          }}
        />
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

function PipelineList({
  client,
  pipelines,
  readOnly,
  onNew,
  onOpen,
}: {
  client: Api;
  pipelines: UseQueryResult<Pipeline[]>;
  readOnly: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const visible = (pipelines.data ?? []).filter((pipeline) =>
    pipeline.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <>
      <PageIntro>Orchestrate syncs, transformations and quality checks.</PageIntro>
      <div className="contents">
        <PageActions>
          <Button disabled={readOnly} onClick={onNew}>
            <Plus size={16} aria-hidden="true" />
            New pipeline
          </Button>
        </PageActions>
      </div>
      <Field label="Search pipelines by name">
        <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
      </Field>
      {!!pipelines.data?.length && (
        <p role="status" className="text-caption text-ink-2">
          {visible.length} of {pipelines.data.length} pipelines
        </p>
      )}
      {!!pipelines.data?.length && !visible.length && (
        <FeatureEmpty
          title="No matching pipelines"
          action="Clear search"
          onAction={() => setSearch('')}
        >
          Try another pipeline name.
        </FeatureEmpty>
      )}
      {pipelines.isPending && <FeatureLoading label="Loading pipelines" />}
      {pipelines.isError && (
        <FeatureError error={pipelines.error} retry={() => void pipelines.refetch()} />
      )}
      {pipelines.data?.length === 0 && (
        <FeatureEmpty
          title="Build your first pipeline"
          action="New pipeline"
          disabled={readOnly}
          onAction={onNew}
        >
          Connect existing jobs, models and checks in the order they should run.
        </FeatureEmpty>
      )}
      {!!pipelines.data?.length && (
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
              <PipelineRow key={p.id} pipeline={p} client={client} onOpen={() => onOpen(p.id)} />
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
