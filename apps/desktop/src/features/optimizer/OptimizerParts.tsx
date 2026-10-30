import { ChevronRight } from 'lucide-react';
import type { AdvisorRecommendation, AdvisorSource, Api } from '@/lib/api';
import { Button, StatePill, Table } from '@/components/workbench/primitives';
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
import { applyReason, canRollback, evidenceSummary, indexColumns } from './optimizer-model';

export type Confirmation =
  | { kind: 'apply' | 'rollback'; recommendation: AdvisorRecommendation }
  | { kind: 'relayout'; id: string; target: string };

function Code({ text, label }: { text: string; label: string }) {
  return (
    <pre className="optimizer-code" tabIndex={0} aria-label={label}>
      <code>{text}</code>
    </pre>
  );
}

// One advisor recommendation: evidence, exact apply and rollback SQL, and the gated actions.
export function RecommendationCard({
  r,
  s,
  admin,
  readOnly,
  busy,
  run,
  client,
  onConfirm,
}: {
  r: AdvisorRecommendation;
  s?: AdvisorSource;
  admin: boolean;
  readOnly: boolean;
  busy: boolean;
  run: (work: () => Promise<string>) => void;
  client: Api;
  onConfirm: (confirmation: Confirmation) => void;
}) {
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
        <ChevronRight className="optimizer-chevron" size={16} aria-hidden="true" />
        <span className="optimizer-summary-main">
          <strong>
            {r.kind[0].toUpperCase() + r.kind.slice(1).replaceAll('_', ' ')}
            {indexColumns(r.ddl).length > 0 && ' on ' + indexColumns(r.ddl).join(', ')}
          </strong>
          <code>{r.target}</code>
          <span className="hint">
            {s?.name ?? r.source_id}
            {r.estimated_benefit > 0 &&
              ' · Benefit score ' + Math.round(r.estimated_benefit).toLocaleString()}
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
          <Code text={JSON.stringify(r.evidence, null, 2)} label="Recommendation evidence" />
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
            Applied by {r.applied_by} · {new Date(r.applied_at * 1000).toLocaleString()}
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
                onClick={() => onConfirm({ kind: 'apply', recommendation: r })}
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
              onClick={() => onConfirm({ kind: 'rollback', recommendation: r })}
            >
              Rollback
            </Button>
          )}
          {r.status === 'applying' && <span role="status">Source operation in progress…</span>}
        </div>
        {r.status === 'open' && reason && (
          <p id={'apply-reason-' + r.id} className="hint">
            {reason}
          </p>
        )}
        {canRollback(r) && rollbackReason && <p className="hint">{rollbackReason}</p>}
      </div>
    </details>
  );
}

type LakeOptimization = Awaited<ReturnType<Api['datasetOptimization']>>;

// Current and next lake layout, column workload counters and the hash lookup sidecar.
export function LakeDetails({ data }: { data: LakeOptimization }) {
  return (
    <>
      <h2>Current layout</h2>
      {data.layout ? (
        <>
          <dl>
            <dt>Sort key</dt>
            <dd>
              <code>{data.layout.sort_column ?? 'Unsorted'}</code>
            </dd>
            <dt>Bloom filters</dt>
            <dd>
              <code>{data.layout.bloom_columns.join(', ') || 'None'}</code>
            </dd>
            <dt>Rows per group</dt>
            <dd>{data.layout.row_group_size.toLocaleString()}</dd>
          </dl>
          <p>{data.layout.reason}</p>
        </>
      ) : (
        <p>No workload layout has been published yet.</p>
      )}
      <p className="hint">Next publish or relayout: {data.next_layout.reason}</p>
      <h2>Query workload</h2>
      {!data.stats.length ? (
        <p className="empty">
          No workload observations yet. Run queries, Explorer reads, charts, quality checks or model
          builds. Counters arrive within a few seconds.
        </p>
      ) : (
        <Table label="Dataset workload">
          <TableHeader>
            <TableRow>
              {['Column', 'Role', 'Operator', 'Count', 'Scanned', 'Returned', 'Elapsed (ms)'].map(
                (h) => (
                  <TableHead scope="col" key={h}>
                    {h}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.stats.map((s) => (
              <TableRow key={s.column + ':' + s.role + ':' + s.op}>
                <TableCell>
                  <code>{s.column || 'All columns'}</code>
                </TableCell>
                <TableCell>{s.role.replaceAll('_', ' ')}</TableCell>
                <TableCell>{s.op || '—'}</TableCell>
                {[s.count, s.rows_scanned, s.rows_returned, s.elapsed_ms].map((n, i) => (
                  <TableCell key={i} className="text-right">
                    {n.toLocaleString()}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="hint">{data.metrics_note}</p>
      <h2>Hash lookup index</h2>
      <dl>
        <dt>Status</dt>
        <dd>{data.hash_index.enabled ? 'Enabled' : 'Disabled'}</dd>
        <dt>Key column</dt>
        <dd>
          <code>{data.hash_index.key_column ?? 'None'}</code>
        </dd>
        <dt>Generation</dt>
        <dd>
          <code>{data.hash_index.generation ?? 'None'}</code>
        </dd>
        <dt>Size</dt>
        <dd>{data.hash_index.size_bytes.toLocaleString()} bytes</dd>
      </dl>
      <p className="hint">{data.hash_index.reason}</p>
    </>
  );
}

// Final review before anything runs: the exact SQL, its target and risk, and any failure.
export function ConfirmDialog({
  confirmation,
  sources,
  busy,
  readOnly,
  error,
  onCancel,
  onApprove,
}: {
  confirmation: Confirmation | null;
  sources: AdvisorSource[];
  busy: boolean;
  readOnly: boolean;
  error: string;
  onCancel: () => void;
  onApprove: () => void;
}) {
  const confirmTarget =
    confirmation?.kind === 'relayout' ? confirmation.target : confirmation?.recommendation.target;
  const confirmSource =
    confirmation && confirmation.kind !== 'relayout'
      ? sources.find((s) => s.id === confirmation.recommendation.source_id)
      : undefined;
  const confirmDDL =
    confirmation && confirmation.kind !== 'relayout'
      ? confirmation.kind === 'apply'
        ? confirmation.recommendation.ddl
        : confirmation.recommendation.rollback_ddl
      : '';
  return (
    <AlertDialog
      open={!!confirmation}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
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
        {/* Failures stay inside the dialog so the reviewed SQL and the result are seen together. */}
        {error && confirmation && (
          <p role="alert" className="message">
            {error} Check the recommendation's status before retrying.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || readOnly}
            onClick={(e) => {
              e.preventDefault();
              onApprove();
            }}
          >
            {busy
              ? 'Working…'
              : confirmation?.kind === 'relayout'
                ? 'Relayout'
                : confirmation?.kind === 'rollback'
                  ? 'Execute rollback'
                  : error
                    ? 'Retry apply'
                    : 'Approve and apply'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
