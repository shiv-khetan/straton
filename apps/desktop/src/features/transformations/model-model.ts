import type { Dataset, ExpectationResult, Model, ModelExplain, ModelLineage } from '@/lib/api';
import { modelGraph as buildModelGraph } from '../console/workbench-model.ts';
import type { Tone } from '@/components/workbench/primitives';
export function modelStatus(status: string, lastRun: string | null): { label: string; tone: Tone } {
  const label = status === 'broken' ? 'broken' : (lastRun ?? status);
  const tone: Tone = ['broken', 'failed', 'interrupted', 'error'].includes(label)
    ? 'danger'
    : ['queued', 'cancelled'].includes(label)
      ? 'warning'
      : label === 'running'
        ? 'info'
        : ['ready', 'succeeded'].includes(label)
          ? 'success'
          : 'neutral';
  return { label, tone };
}
export function ruleDiffRows(rules: ModelExplain['rules_fired']) {
  return rules.flatMap((rule, index) => [
    { id: index + '-before', rule: rule.rule, sign: '−', expression: rule.before, kind: 'before' },
    { id: index + '-after', rule: rule.rule, sign: '+', expression: rule.after, kind: 'after' },
  ]);
}

// The lineage API returns dataset references, without columns or runtime metadata.
type LineageDataset = Pick<Dataset, 'id' | 'name' | 'sql_schema' | 'sql_table' | 'source_id'> &
  Partial<Dataset>;
type LineageResponse = {
  upstream?: LineageDataset[] | null;
  downstream?: LineageDataset[] | null;
};
export function normalizeModelLineage(
  lineage: LineageResponse | null | undefined,
  datasets: Dataset[] = [],
): ModelLineage {
  const normalize = (references: LineageDataset[] | null | undefined): Dataset[] =>
    (references ?? []).map((reference) => {
      const dataset = datasets.find((item) => item.id === reference.id);
      return {
        type: 'dataset',
        stale: false,
        row_count: null,
        last_synced_at: null,
        ...dataset,
        ...reference,
        columns: reference.columns ?? dataset?.columns ?? [],
      };
    });
  return { upstream: normalize(lineage?.upstream), downstream: normalize(lineage?.downstream) };
}
export function modelGraph(
  models: Model[] = [],
  lineages: Record<string, LineageResponse | null | undefined> = {},
) {
  return buildModelGraph(
    models ?? [],
    Object.fromEntries(
      Object.entries(lineages ?? {}).map(([id, lineage]) => [id, normalizeModelLineage(lineage)]),
    ),
  );
}

/** How the last checked run went for one expectation: a state for StatePill plus counts. */
export function expectationOutcome(result: ExpectationResult | undefined): {
  state: string;
  label: string;
  detail: string;
} {
  if (!result) return { state: 'pending', label: 'Not run', detail: '' };
  const rows =
    result.failed_rows === null || result.total_rows === null
      ? ''
      : result.failed_rows +
        ' of ' +
        result.total_rows +
        (result.total_rows === 1 ? ' row' : ' rows');
  if (result.passed) return { state: 'passed', label: 'Passed', detail: '' };
  if (result.action === 'fail') return { state: 'failed', label: 'Failed run', detail: rows };
  if (result.action === 'drop') return { state: 'warning', label: 'Dropped', detail: rows };
  return { state: 'warning', label: 'Warned', detail: rows };
}
/** The engine's naming rule for expectations: lowercase letters, digits and _, up to 64. */
export function expectationNameValid(name: string): boolean {
  return /^[a-z0-9_]{1,64}$/.test(name);
}
