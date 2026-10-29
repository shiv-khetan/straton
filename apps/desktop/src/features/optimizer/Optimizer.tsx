import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Api, AdvisorRecommendation, Dataset, Me } from '@/lib/api';
import { can } from '@/features/access/access-model';
import { Button, Feedback, StatePill, Tabs, Table } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import { TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  applyReason,
  canRollback,
  evidenceSummary,
  indexColumns,
  rankRecommendations,
} from './optimizer-model';
import { datasetLabel } from '@/lib/view-model';
import './styles.css';
type Confirmation =
  | { kind: 'apply' | 'rollback'; recommendation: AdvisorRecommendation }
  | { kind: 'relayout'; id: string; target: string };
function Code({ text, label }: { text: string; label: string }) {
  return (
    <pre className="optimizer-code" tabIndex={0} aria-label={label}>
      <code>{text}</code>
    </pre>
  );
}
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
  const confirmTarget =
    confirmation?.kind === 'relayout' ? confirmation.target : confirmation?.recommendation.target;
  const confirmSource =
    confirmation && confirmation.kind !== 'relayout'
      ? advisor.data?.sources.find((s) => s.id === confirmation.recommendation.source_id)
      : undefined;
  const confirmDDL =
    confirmation && confirmation.kind !== 'relayout'
      ? confirmation.kind === 'apply'
        ? confirmation.recommendation.ddl
        : confirmation.recommendation.rollback_ddl
      : '';
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
                  {rows.map((r) => {
                    const s = advisor.data?.sources.find((s) => s.id === r.source_id);
                    const reason = applyReason(r, s, admin, readOnly);
                    const rollbackReason = !admin
                      ? 'Admin access is required.'
                      : readOnly
                        ? 'Reconnect the engine first.'
                        : !s?.advisor_may_write
                          ? 'Advisor may write is off in Connections.'
                          : '';
                    return (
                      <details key={r.id} className="optimizer-recommendation">
                        <summary>
                          <ChevronRight
                            className="optimizer-chevron"
                            size={16}
                            aria-hidden="true"
                          />
                          <span className="optimizer-summary-main">
                            <strong>
                              {r.kind[0].toUpperCase() + r.kind.slice(1).replaceAll('_', ' ')}
                              {indexColumns(r.ddl).length > 0 &&
                                ' on ' + indexColumns(r.ddl).join(', ')}
                            </strong>
                            <code>{r.target}</code>
                            <span className="hint">
                              {s?.name ?? r.source_id}
                              {r.estimated_benefit > 0 &&
                                ' · Benefit score ' +
                                  Math.round(r.estimated_benefit).toLocaleString()}
                            </span>
                          </span>
                          <StatePill state={r.status} />
                        </summary>
                        <div className="optimizer-detail">
                          <h2>Evidence</h2>
                          <ul className="optimizer-evidence">
                            {evidenceSummary(r.evidence).map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                          <details>
                            <summary className="hint">Raw evidence</summary>
                            <Code
                              text={JSON.stringify(r.evidence, null, 2)}
                              label="Recommendation evidence"
                            />
                          </details>
                          <h2>Apply SQL</h2>
                          <Code text={r.ddl} label="SQL to apply" />
                          <h2>Rollback SQL</h2>
                          <Code text={r.rollback_ddl} label="SQL to roll back" />
                          <dl>
                            <dt>Write and storage cost</dt>
                            <dd>{r.cost}</dd>
                            <dt>Risk</dt>
                            <dd>{r.risk}</dd>
                            <dt>Required permission</dt>
                            <dd>{r.required_permission}</dd>
                          </dl>
                          {r.applied_at && (
                            <p className="hint">
                              Applied by {r.applied_by} ·{' '}
                              {new Date(r.applied_at * 1000).toLocaleString()}
                            </p>
                          )}
                          {r.error && (
                            <p role="alert" className="message">
                              {r.error}
                            </p>
                          )}
                          <div className="actions">
                            {r.status === 'open' && (
                              <>
                                <Button
                                  disabled={busy || !!reason}
                                  aria-describedby={'apply-reason-' + r.id}
                                  onClick={() =>
                                    setConfirmation({ kind: 'apply', recommendation: r })
                                  }
                                >
                                  Apply
                                </Button>
                                <Button
                                  variant="outline"
                                  disabled={busy || readOnly || !admin}
                                  onClick={() =>
                                    run(async () => {
                                      await client.dismissAdvice(r.id);
                                      return 'Recommendation dismissed. It remains in history.';
                                    })
                                  }
                                >
                                  Dismiss
                                </Button>
                              </>
                            )}
                            {canRollback(r) && (
                              <Button
                                variant="outline"
                                disabled={busy || !!rollbackReason}
                                onClick={() =>
                                  setConfirmation({ kind: 'rollback', recommendation: r })
                                }
                              >
                                Rollback
                              </Button>
                            )}
                            {r.status === 'applying' && (
                              <span role="status">Source operation in progress…</span>
                            )}
                          </div>
                          {r.status === 'open' && reason && (
                            <p id={'apply-reason-' + r.id} className="hint">
                              {reason}
                            </p>
                          )}
                          {canRollback(r) && rollbackReason && (
                            <p className="hint">{rollbackReason}</p>
                          )}
                        </div>
                      </details>
                    );
                  })}
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
              lake.data && (
                <>
                  <h2>Current layout</h2>
                  {lake.data.layout ? (
                    <>
                      <dl>
                        <dt>Sort key</dt>
                        <dd>
                          <code>{lake.data.layout.sort_column ?? 'Unsorted'}</code>
                        </dd>
                        <dt>Bloom filters</dt>
                        <dd>
                          <code>{lake.data.layout.bloom_columns.join(', ') || 'None'}</code>
                        </dd>
                        <dt>Rows per group</dt>
                        <dd>{lake.data.layout.row_group_size.toLocaleString()}</dd>
                      </dl>
                      <p>{lake.data.layout.reason}</p>
                    </>
                  ) : (
                    <p>No workload layout has been published yet.</p>
                  )}
                  <p className="hint">Next publish or relayout: {lake.data.next_layout.reason}</p>
                  <h2>Query workload</h2>
                  {!lake.data.stats.length ? (
                    <p className="empty">
                      No workload observations yet. Run queries, Explorer reads, charts, quality
                      checks or model builds. Counters arrive within a few seconds.
                    </p>
                  ) : (
                    <Table label="Dataset workload">
                      <TableHeader>
                        <TableRow>
                          {[
                            'Column',
                            'Role',
                            'Operator',
                            'Count',
                            'Scanned',
                            'Returned',
                            'Elapsed (ms)',
                          ].map((h) => (
                            <TableHead scope="col" key={h}>
                              {h}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lake.data.stats.map((s) => (
                          <TableRow key={s.column + ':' + s.role + ':' + s.op}>
                            <TableCell>
                              <code>{s.column || 'All columns'}</code>
                            </TableCell>
                            <TableCell>{s.role.replaceAll('_', ' ')}</TableCell>
                            <TableCell>{s.op || '—'}</TableCell>
                            {[s.count, s.rows_scanned, s.rows_returned, s.elapsed_ms].map(
                              (n, i) => (
                                <TableCell key={i} className="text-right">
                                  {n.toLocaleString()}
                                </TableCell>
                              ),
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  <p className="hint">{lake.data.metrics_note}</p>
                  <p className="hint">Hash lookup index: {lake.data.hash_index.reason}</p>
                </>
              )
            )}
          </>
        )}
      </section>
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogContent className="optimizer-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.kind === 'relayout'
                ? 'Relayout lake dataset'
                : confirmation?.kind === 'rollback'
                  ? 'Roll back source change'
                  : 'Apply source recommendation'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.kind === 'relayout'
                ? 'Rewrites the current engine snapshot using the observed workload. Readers wait during publication. Source databases are unchanged.'
                : 'This executes the exact SQL below on the connected source database using its saved credential. The operation is audited. Review the target, locks and storage cost before continuing.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p>
            Target: <code>{confirmTarget}</code>
            {confirmSource && (
              <>
                {' '}
                · {confirmSource.name} ({confirmSource.connection_target})
              </>
            )}
          </p>
          {confirmation?.kind !== 'relayout' && (
            <>
              <Code text={confirmDDL} label="Exact approved SQL" />
              <p className="hint">{confirmation?.recommendation.risk}</p>
            </>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || readOnly}
              onClick={(e) => {
                e.preventDefault();
                approve();
              }}
            >
              {busy
                ? 'Working…'
                : confirmation?.kind === 'relayout'
                  ? 'Relayout'
                  : confirmation?.kind === 'rollback'
                    ? 'Execute rollback'
                    : 'Approve and apply'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
