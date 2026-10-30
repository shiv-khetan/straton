import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Api, Dataset, Me } from '@/lib/api';
import { can } from '@/features/access/access-model';
import { Button, Feedback, Tabs } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import { rankRecommendations } from './optimizer-model';
import { datasetLabel } from '@/lib/view-model';
import { ConfirmDialog, LakeDetails, RecommendationCard } from './OptimizerParts';
import type { Confirmation } from './OptimizerParts';
import './styles.css';
export default function Optimizer({
  client,
  me,
  datasets,
  readOnly,
}: {
  client: Api;
  me: Me;
  datasets: Dataset[];
  readOnly: boolean;
}) {
  const cache = useQueryClient();
  const [tab, setTab] = useState('Source advisor');
  const [source, setSource] = useState('');
  const [history, setHistory] = useState(false);
  const [dataset, setDataset] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const admin = can(me, 'admin');
  const advisor = useQuery({
    queryKey: ['engine', 'optimizer', 'view', 'advisor', source],
    queryFn: () => client.advisor(source),
    refetchInterval: 3000,
    enabled: tab === 'Source advisor',
  });
  const lake = useQuery({
    queryKey: ['engine', 'optimizer', 'view', 'layout', dataset],
    queryFn: () => client.datasetOptimization(dataset),
    enabled: tab === 'Lake layout' && !!dataset,
  });
  const mutation = useMutation({
    mutationFn: async (work: () => Promise<string>) => work(),
    onMutate: () => {
      setError('');
      setNotice('');
    },
    onSuccess: (message) => {
      setNotice(message);
      if (confirmation && confirmation.kind !== 'relayout') setHistory(true);
      setConfirmation(null);
    },
    onError: (e) => setError(String(e)),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ['engine'] });
    },
  });
  const busy = mutation.isPending;
  const run = (work: () => Promise<string>) => mutation.mutate(work);
  const rows = rankRecommendations(advisor.data?.recommendations ?? []).filter(
    (r) => history || ['open', 'applying', 'failed'].includes(r.status),
  );
  const selectedSource = advisor.data?.sources.find((s) => s.id === source);
  const selectedDataset = datasets.find((d) => d.id === dataset);

  function approve() {
    if (!confirmation) return;
    const c = confirmation;
    run(async () => {
      if (c.kind === 'relayout') {
        await client.relayoutDataset(c.id);
        return 'Lake relayout complete. The dataset is ready to query.';
      }
      if (c.kind === 'apply') {
        await client.applyAdvice(c.recommendation.id, c.recommendation.approval_token);
        return 'Recommendation applied and audited. Rollback is available in history.';
      }
      await client.rollbackAdvice(c.recommendation.id, c.recommendation.approval_token);
      return 'Rollback complete and audited. The source change has been reversed.';
    });
  }
  return (
    <div className="optimizer-page">
      <div className="page-heading">
        <div>
          <h1>Optimizer</h1>
          <p className="hint">Tune the lake first. Review and approve each source change.</p>
        </div>
      </div>
      {notice && <Feedback message={notice} onClose={() => setNotice('')} />}
      {error && (
        <p role="alert" className="message">
          {error} Review the current status before retrying.
        </p>
      )}
      <Tabs
        items={['Source advisor', 'Lake layout']}
        value={tab}
        onChange={setTab}
        id="optimizer"
      />
      <section
        role="tabpanel"
        id={'optimizer-panel-' + tab}
        aria-labelledby={'optimizer-tab-' + tab}
        className="optimizer-panel"
      >
        {tab === 'Source advisor' ? (
          <>
            <div className="optimizer-toolbar">
              <Field label="Source">
                <select value={source} onChange={(e) => setSource(e.target.value)} disabled={busy}>
                  <option value="">All sources</option>
                  {advisor.data?.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="optimizer-history">
                <input
                  type="checkbox"
                  checked={history}
                  onChange={(e) => setHistory(e.target.checked)}
                />
                Include history
              </label>
              <Button
                variant="outline"
                disabled={busy || readOnly || !admin || !source}
                onClick={() =>
                  run(async () => {
                    const result = await client.refreshAdvisor(source);
                    return (
                      'Recommendations refreshed. ' +
                      result.recommendations +
                      ' reviewed.' +
                      (result.warnings?.length ? ' ' + result.warnings.join(' ') : '')
                    );
                  })
                }
              >
                {busy ? 'Working…' : 'Refresh recommendations'}
              </Button>
            </div>
            {!source && <p className="hint">Choose a source to refresh its recommendations.</p>}
            {selectedSource && !selectedSource.advisor_may_write && (
              <p className="message">
                Advisor may write is off for {selectedSource.name}. Enable it in Connections before
                applying or rolling back a change. Recommendations remain available for review.
              </p>
            )}
            {advisor.isPending ? (
              <p role="status">Loading recommendations…</p>
            ) : advisor.isError ? (
              <p role="alert">
                Could not load recommendations.{' '}
                <Button variant="outline" onClick={() => void advisor.refetch()}>
                  Retry
                </Button>
              </p>
            ) : !rows.length ? (
              <p className="empty">
                {advisor.data?.sources.length
                  ? 'No recommendations in this view. Select a source and refresh to inspect its metadata and lake workload.'
                  : 'Connect a SQL Server or Postgres source to receive recommendations.'}
              </p>
            ) : (
              <>
                <p className="hint">
                  Ranked by relative estimated benefit. Scores compare workload evidence; they do
                  not predict latency savings.
                </p>
                <div className="optimizer-list">
                  {rows.map((r) => (
                    <RecommendationCard
                      key={r.id}
                      r={r}
                      s={advisor.data?.sources.find((s) => s.id === r.source_id)}
                      admin={admin}
                      readOnly={readOnly}
                      busy={busy}
                      run={run}
                      client={client}
                      onConfirm={setConfirmation}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="optimizer-toolbar">
              <Field label="Dataset">
                <select
                  value={dataset}
                  onChange={(e) => setDataset(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Choose a dataset</option>
                  {datasets
                    .filter((d) => d.last_synced_at)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {datasetLabel(d)}
                      </option>
                    ))}
                </select>
              </Field>
              <Button
                variant="outline"
                disabled={!dataset || busy || readOnly || !admin || !lake.data}
                onClick={() =>
                  setConfirmation({
                    kind: 'relayout',
                    id: dataset,
                    target: selectedDataset ? datasetLabel(selectedDataset) : dataset,
                  })
                }
              >
                {busy ? 'Relayout in progress…' : 'Relayout'}
              </Button>
            </div>
            {!dataset ? (
              <p className="empty">
                Select a synced dataset or table model to inspect its layout and workload.
              </p>
            ) : lake.isPending ? (
              <p role="status">Loading dataset workload…</p>
            ) : lake.isError ? (
              <p role="alert">
                Could not load this layout.{' '}
                <Button variant="outline" onClick={() => void lake.refetch()}>
                  Retry
                </Button>
              </p>
            ) : (
              lake.data && <LakeDetails data={lake.data} />
            )}
          </>
        )}
      </section>
      <ConfirmDialog
        confirmation={confirmation}
        sources={advisor.data?.sources ?? []}
        busy={busy}
        readOnly={readOnly}
        error={error}
        onCancel={() => setConfirmation(null)}
        onApprove={approve}
      />
    </div>
  );
}
