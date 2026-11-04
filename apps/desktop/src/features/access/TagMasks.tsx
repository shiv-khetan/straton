import { useEffect, useId, useState } from 'react';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import type { Api, MaskKind, Role, TagSummary } from '@/lib/api';
import { Button, EmptyState, Table, Tray } from '@/components/workbench/primitives';
import { normalizeTag, tagProblem } from './access-model';
import type { Work } from './Access';

// One mask per role per tag, applied to every column carrying the tag in every dataset
// (Snowflake-style tag-based masking). Global admins only; the engine enforces it.
export function TagMasks({
  client,
  roles,
  busy,
  work,
  revision,
  onChanged,
}: {
  client: Api;
  roles: Role[];
  busy: boolean;
  work: Work;
  revision: number;
  onChanged: () => void;
}) {
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'success'>('loading');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    let active = true;
    void client
      .tags()
      .then((t) => {
        if (active) {
          setTags(t);
          setState('success');
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e));
          setState('error');
        }
      });
    return () => {
      active = false;
    };
  }, [client, revision, reload]);
  const help = useId();
  const newTag = normalizeTag(draft);
  const exists = tags.some((t) => t.tag === newTag);
  const kindFor = (t: TagSummary, role: string) =>
    t.masks.find((m) => m.role_id === role)?.kind ?? '';
  return (
    <Tray title="Tag masks">
      <p className="hint">
        Choose how each role sees columns with a tag. Tag columns in the dataset policies above.
      </p>
      <form
        className="access-tag-form mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newTag || exists) return;
          setTags((t) =>
            [...t, { tag: newTag, columns: 0, datasets: 0, masks: [] }].sort((a, b) =>
              a.tag.localeCompare(b.tag),
            ),
          );
          setDraft('');
        }}
      >
        <Input
          aria-label="New tag"
          aria-invalid={tagProblem(draft, exists) !== ''}
          aria-describedby={help}
          placeholder="New tag, e.g. pii"
          maxLength={64}
          disabled={busy}
          value={draft}
          className="w-48"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy || !newTag || exists}>
          Add tag
        </Button>
        <span id={help} className="text-caption text-ink-2" aria-live="polite">
          {tagProblem(draft, exists)}
        </span>
      </form>
      {state === 'loading' ? (
        <p role="status">Loading tags…</p>
      ) : state === 'error' ? (
        <div role="alert">
          <p>Could not load tags. {error}</p>
          <Button variant="outline" onClick={() => setReload((r) => r + 1)}>
            Retry tags
          </Button>
        </div>
      ) : tags.length === 0 ? (
        <EmptyState>
          No tags yet. Add one here, or tag a column in a dataset&rsquo;s policies.
        </EmptyState>
      ) : (
        <div className="access-matrix">
          <Table label="Tag masks by role">
            <TableHeader>
              <TableRow>
                <TableHead>Tag</TableHead>
                <TableHead>Used on</TableHead>
                {roles.map((r) => (
                  <TableHead key={r.id}>{r.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tags.map((t) => (
                <TableRow key={t.tag}>
                  <TableHead scope="row">
                    <code>{t.tag}</code>
                  </TableHead>
                  <TableCell className="tabular-nums whitespace-nowrap">
                    {t.columns === 0
                      ? 'No columns'
                      : t.columns +
                        (t.columns === 1 ? ' column' : ' columns') +
                        ' in ' +
                        t.datasets +
                        (t.datasets === 1 ? ' dataset' : ' datasets')}
                  </TableCell>
                  {roles.map((r) => (
                    <TableCell key={r.id}>
                      <select
                        aria-label={r.name + ' mask for tag ' + t.tag}
                        disabled={busy}
                        value={kindFor(t, r.id)}
                        onChange={(e) => {
                          const kind = (e.target.value || null) as MaskKind | null;
                          void work(
                            async () => {
                              await client.tagMask(t.tag, r.id, kind);
                              setTags((all) =>
                                all.map((x) =>
                                  x.tag !== t.tag
                                    ? x
                                    : {
                                        ...x,
                                        masks: [
                                          ...x.masks.filter((m) => m.role_id !== r.id),
                                          ...(kind ? [{ role_id: r.id, kind }] : []),
                                        ],
                                      },
                                ),
                              );
                              onChanged();
                            },
                            kind ? 'Tag mask saved' : 'Tag mask removed',
                            false,
                          );
                        }}
                      >
                        <option value="">No mask</option>
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
        </div>
      )}
    </Tray>
  );
}
