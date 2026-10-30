import { useEffect, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { Api, Dataset, MaskKind, Policies, Role } from '@/lib/api';
import { Button, EmptyState, Table, Tray } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import { setMask } from './access-model';
import { datasetLabel } from '@/lib/view-model';
import { dirtyPredicates, savePredicate } from './predicate-model';
import type { Work } from './Access';

const emptyPolicies: Policies = { row_filters: [], masks: [] };

// Per-dataset row filters and column masks for every role. Switching datasets with unsaved
// predicates asks before discarding them.
export function PoliciesTab({
  client,
  datasets,
  roles,
  busy,
  work,
  onChanged,
}: {
  client: Api;
  datasets: Dataset[];
  roles: Role[];
  busy: boolean;
  work: Work;
  onChanged: () => void;
}) {
  const [dataset, setDataset] = useState('');
  const [policies, setPolicies] = useState<Policies>(emptyPolicies);
  const [policyState, setPolicyState] = useState<'loading' | 'error' | 'success'>('loading');
  const [policyError, setPolicyError] = useState('');
  const [policyRevision, setPolicyRevision] = useState(0);
  const [nextDataset, setNextDataset] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    setPolicyState('loading');
    setPolicyError('');
    setPolicies(emptyPolicies);
    setFilters({});
    setValidation({});
    if (dataset)
      void client
        .policies(dataset)
        .then((p) => {
          if (active) {
            setPolicies(p);
            setFilters(Object.fromEntries(p.row_filters.map((f) => [f.role_id, f.predicate])));
            setPolicyState('success');
          }
        })
        .catch((e) => {
          if (active) {
            setPolicyError(String(e));
            setPolicyState('error');
          }
        });
    return () => {
      active = false;
    };
  }, [client, dataset, policyRevision]);
  const currentDataset = datasets.find((d) => d.id === dataset);
  const roleLabel = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  return (
    <>
      <Tray title="Policies">
        <Field label="Dataset">
          <select
            value={dataset}
            disabled={busy}
            onChange={(e) => {
              if (dirtyPredicates(policies, filters)) setNextDataset(e.target.value);
              else setDataset(e.target.value);
            }}
          >
            <option value="">Choose dataset</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {datasetLabel(d)}
              </option>
            ))}
          </select>
        </Field>
        {!dataset ? (
          <EmptyState>Choose a dataset to edit its row filters and column masks.</EmptyState>
        ) : policyState === 'loading' ? (
          <p role="status">Loading policies…</p>
        ) : policyState === 'error' ? (
          <div role="alert">
            <p>Could not load policies. {policyError}</p>
            <Button variant="outline" onClick={() => setPolicyRevision((r) => r + 1)}>
              Retry policies
            </Button>
          </div>
        ) : (
          <>
            <h2>Row filters</h2>
            <p className="hint">
              Filters from read-granting roles combine with OR. A read-granting role without a
              filter allows all rows.
            </p>
            {roles.map((r) => (
              <div className="access-policy" key={r.id}>
                <Field label={r.name + ' row predicate'}>
                  <Textarea
                    rows={2}
                    disabled={busy}
                    className="mono"
                    placeholder="No filter — all rows"
                    value={filters[r.id] ?? ''}
                    onChange={(e) => {
                      setFilters((p) => ({ ...p, [r.id]: e.target.value }));
                      setValidation((v) => ({ ...v, [r.id]: '' }));
                    }}
                  />
                </Field>
                <div className="actions">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || !filters[r.id]?.trim()}
                    onClick={() =>
                      void work(
                        async () => {
                          const result = await client.validatePolicy(dataset, filters[r.id]);
                          setValidation((v) => ({
                            ...v,
                            [r.id]: result.ok
                              ? 'Valid predicate'
                              : (result.error ?? 'Invalid predicate'),
                          }));
                        },
                        '',
                        false,
                      )
                    }
                  >
                    Validate
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    disabled={busy}
                    onClick={() =>
                      void work(
                        async () => {
                          const predicate = filters[r.id]?.trim() ? filters[r.id] : null;
                          await client.rowFilter(dataset, r.id, predicate);
                          setPolicies((p) => savePredicate(p, r.id, predicate));
                          setFilters((p) => ({ ...p, [r.id]: predicate ?? '' }));
                          onChanged();
                        },
                        'Row filter saved',
                        false,
                      )
                    }
                  >
                    Save filter
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || !policies.row_filters.some((f) => f.role_id === r.id)}
                    onClick={() =>
                      void work(
                        async () => {
                          await client.rowFilter(dataset, r.id, null);
                          setPolicies((p) => savePredicate(p, r.id, null));
                          setFilters((p) => ({ ...p, [r.id]: '' }));
                          onChanged();
                        },
                        'Row filter removed',
                        false,
                      )
                    }
                  >
                    Remove filter
                  </Button>
                </div>
                {validation[r.id] && <p role="status">{validation[r.id]}</p>}
              </div>
            ))}
            <h2>Column masks</h2>
            <p className="hint">
              A column is masked only when every read-granting role masks it. If all do, the
              strictest kind wins: null, redact, hash, then last4.
            </p>
            <Table label="Column masks by role">
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  {currentDataset?.columns.map((c) => (
                    <TableHead key={c.name}>
                      <code>{c.name}</code>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((r) => (
                  <TableRow key={r.id}>
                    <TableHead scope="row">{roleLabel(r.id)}</TableHead>
                    {currentDataset?.columns.map((c) => (
                      <TableCell key={c.name}>
                        <select
                          aria-label={r.name + ' mask for ' + c.name}
                          disabled={busy}
                          value={
                            policies.masks.find((m) => m.role_id === r.id && m.column === c.name)
                              ?.kind ?? ''
                          }
                          onChange={(e) => {
                            const kind = e.target.value as MaskKind | '';
                            void work(
                              async () => {
                                await client.mask(dataset, r.id, c.name, kind || null);
                                setPolicies((p) => ({
                                  ...p,
                                  masks: setMask(p.masks, r.id, c.name, kind || null),
                                }));
                                onChanged();
                              },
                              'Mask saved',
                              false,
                            );
                          }}
                        >
                          <option value="">Visible</option>
                          {['null', 'redact', 'hash', 'last4'].map((k) => (
                            <option key={k}>{k}</option>
                          ))}
                        </select>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Tray>
      <Dialog
        open={nextDataset !== null}
        onOpenChange={(open) => {
          if (!open) setNextDataset(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard policy changes?</DialogTitle>
            <DialogDescription>
              Changing datasets discards unsaved row predicates.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button autoFocus variant="outline" onClick={() => setNextDataset(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDataset(nextDataset!);
                setNextDataset(null);
              }}
            >
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
