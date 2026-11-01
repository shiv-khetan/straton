import { StatePill } from '@/components/workbench/primitives';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
} from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { Api, DataMap, Dataset, ImpactDirection, ImpactGraph } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Pill } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import {
  Choice,
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
} from '@/components/workbench/FeatureState';
import { impactPaths } from './impact-model';
type EntityNode = Node<
  { name: string; kind: string; status: string | null; root: boolean; highlighted: boolean },
  'impact'
>;
function Entity({ data }: NodeProps<EntityNode>) {
  return (
    <article
      className={
        'rounded-card border bg-surface p-3 ' + (data.root ? 'border-primary' : 'border-line')
      }
      style={{ width: 220, opacity: data.highlighted ? 1 : 0.35 }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="text-caption text-ink-2">
        {data.kind}
        {data.root ? ' · selected root' : ''}
      </span>
      <strong className="my-2 block break-words">{data.name}</strong>
      <StatePill state={data.status ?? 'No runs'} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}
const nodeTypes = { impact: Entity };
export function Impact({
  client,
  map,
  initialRoot,
}: {
  client: Api;
  map: DataMap;
  initialRoot?: string;
}) {
  const datasets = map.nodes.filter((n): n is Dataset => n.type === 'dataset');
  const models = useQuery({
    queryKey: [...queryKeys.models, 'view', 'impact-roots'],
    queryFn: () => client.models(),
  });
  const [root, setRoot] = useState(initialRoot ? 'dataset:' + initialRoot : '');
  const [direction, setDirection] = useState<ImpactDirection>('both');
  const [depth, setDepth] = useState(50);
  const query = useQuery({
    queryKey: [...queryKeys.impact, 'view', root, direction, depth],
    queryFn: () => client.lineageImpact({ node: root, direction, depth }),
    enabled: !!root,
  });
  const paths = useMemo(
    () => (query.data ? impactPaths(query.data, root, direction, depth) : null),
    [query.data, root, direction, depth],
  );
  const summary = useMemo(
    () =>
      query.data
        ? ['model', 'pipeline', 'check', 'chart', 'dashboard'].map((kind) => ({
            kind,
            count: query.data!.nodes.filter((n) => n.kind === kind && paths?.nodes.has(n.id))
              .length,
          }))
        : [],
    [query.data, paths],
  );
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label="Dataset or model"
          value={root}
          options={[
            { value: '', label: 'Choose an impact root' },
            ...datasets
              .map((d) => ({
                value: 'dataset:' + d.id,
                label: d.sql_schema && d.sql_table ? d.sql_schema + '.' + d.sql_table : d.name,
              }))
              .sort((a, b) => a.label.localeCompare(b.label)),
            ...(models.data ?? []).map((m) => ({
              value: 'model:' + m.id,
              label: 'Model · ' + m.name,
            })),
          ]}
          onChange={setRoot}
        />
        <Choice
          label="Direction"
          value={direction}
          options={['both', 'upstream', 'downstream'].map((v) => ({ value: v, label: v }))}
          onChange={(v) => setDirection(v as ImpactDirection)}
        />
        <Field label="Maximum depth (0–50)">
          <Input
            className="w-28"
            type="number"
            min={0}
            max={50}
            value={depth}
            onChange={(e) => setDepth(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
          />
        </Field>
      </div>
      <FeatureError error={models.error} retry={() => void models.refetch()} />
      {!root && (
        <FeatureEmpty
          title="Trace the impact of a change"
          action={datasets.length ? 'Inspect first dataset' : undefined}
          onAction={() => setRoot('dataset:' + datasets[0].id)}
        >
          Choose a dataset or model to inspect upstream inputs and downstream models, pipelines,
          checks, charts and dashboards.
        </FeatureEmpty>
      )}
      {root && query.isPending && <FeatureLoading label="Tracing impact" />}
      <FeatureError error={query.error} retry={() => void query.refetch()} />
      {query.data && paths && (
        <>
          <aside
            className="flex flex-wrap items-center gap-5 rounded-card border border-line bg-panel p-3"
            aria-label="Impact summary"
          >
            <h2 className="font-medium">Impact summary</h2>
            {summary.map((s) => (
              <span key={s.kind}>
                <code>{s.count}</code> {s.kind === 'check' ? 'checks' : s.kind + 's'}
              </span>
            ))}
          </aside>
          <ReactFlowProvider>
            <ImpactCanvas
              graph={query.data}
              root={root}
              direction={direction}
              depth={depth}
              onRoot={setRoot}
            />
          </ReactFlowProvider>
          <details>
            <summary>Impacted entities and paths</summary>
            <ul className="divide-y divide-line">
              {query.data.nodes
                .filter((n) => paths.nodes.has(n.id))
                .map((n) => (
                  <li key={n.id} className="flex items-center gap-3 py-2">
                    <Pill>{n.kind}</Pill>
                    <span>{n.name}</span>
                    <span className="text-ink-2">{n.status ?? 'No runs'}</span>
                    {['model', 'dataset'].includes(n.kind) && (
                      <Button variant="link" onClick={() => setRoot(n.id)}>
                        Use as root
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
function ImpactCanvas({
  graph,
  root,
  direction,
  depth,
  onRoot,
}: {
  graph: ImpactGraph;
  root: string;
  direction: ImpactDirection;
  depth: number;
  onRoot: (id: string) => void;
}) {
  const [nodes, setNodes] = useState<EntityNode[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const paths = useMemo(
    () => impactPaths(graph, root, direction, depth),
    [graph, root, direction, depth],
  );
  useEffect(() => {
    let active = true;
    setError(null);
    setNodes([]);
    void import('elkjs/lib/elk.bundled.js')
      .then(async ({ default: ELK }) => {
        const placed = await new ELK().layout({
          id: 'root',
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.spacing.nodeNode': '40',
            'elk.layered.spacing.nodeNodeBetweenLayers': '80',
          },
          children: graph.nodes.map((n) => ({ id: n.id, width: 220, height: 128 })),
          edges: graph.edges.map((e, i) => ({ id: String(i), sources: [e.from], targets: [e.to] })),
        });
        if (active)
          setNodes(
            graph.nodes.map((n) => {
              const pos = placed.children?.find((c) => c.id === n.id);
              return {
                id: n.id,
                type: 'impact',
                position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
                data: { ...n, root: n.id === root, highlighted: paths.nodes.has(n.id) },
              };
            }),
          );
      })
      .catch((e) => {
        if (active) setError(e);
      });
    return () => {
      active = false;
    };
  }, [graph, root, paths, revision]);
  return (
    <>
      <FeatureError error={error} retry={() => setRevision((v) => v + 1)} />
      <div
        // Fixed height: a flex-1 basis here is indefinite, so React Flow would measure 0.
        className="h-[440px] shrink-0 rounded-card border border-line bg-surface"
      >
        {!nodes.length && !error ? (
          <FeatureLoading label="Arranging impact graph" />
        ) : (
          <ReactFlow<EntityNode>
            key={root + direction + depth + revision}
            nodes={nodes}
            edges={graph.edges.map((e, i) => ({
              id: String(i),
              source: e.from,
              target: e.to,
              label: e.kind,
              style: {
                stroke: paths.edges.has(i) ? 'var(--primary)' : 'var(--line)',
                opacity: paths.edges.has(i) ? 1 : 0.35,
              },
              type: 'smoothstep',
            }))}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            onNodeDoubleClick={(_, n) => {
              if (['dataset', 'model'].includes(n.data.kind)) onRoot(n.id);
            }}
            fitView
          >
            <Background color="var(--line)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </>
  );
}
