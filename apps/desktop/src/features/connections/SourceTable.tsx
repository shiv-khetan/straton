import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ui/button';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Action } from '@/components/workbench/Field';
import type { Api, Dataset, Job, Run, Source } from '@/lib/api';
import { relativeTime } from '@/lib/view-model';
import { lastSourceRun, sourceHealth } from './source-health';
import { RowMenu, StatePill, Tray, Table as UiTable } from '@/components/workbench/primitives';
import { sourceKinds } from './SourceFormSections';

// Connected systems with edit, discover, check and delete actions per row.
export function SourceTable({
  sources,
  client,
  action,
  busy,
  onEdit,
  onAddDataset,
  jobs,
  runs,
  datasets,
}: {
  sources: Source[];
  jobs: Job[];
  runs: Run[];
  datasets: Dataset[];
  client: Api;
  action: Action;
  busy: boolean;
  onEdit: (source: Source) => void;
  onAddDataset: (sourceId: string) => void;
}) {
  return (
    <Tray title="Connected systems">
      <UiTable label="Sources">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Kind</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Last sync</TableHead>
            <TableHead scope="col" className="text-end">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((source) => (
            <TableRow key={source.id} id={'source:' + source.id} tabIndex={-1}>
              <TableCell>{source.name}</TableCell>
              <TableCell>
                <code>{source.kind}</code>
              </TableCell>
              <TableCell>
                <StatePill
                  state={
                    source.kind === 'external'
                      ? 'External'
                      : ['parquet', 'models'].includes(source.kind)
                        ? 'Built-in'
                        : sourceHealth(source.id, jobs, runs, datasets)
                  }
                />
              </TableCell>
              <TableCell className="text-ink-2 tabular-nums">
                {(() => {
                  const last = lastSourceRun(source.id, jobs, runs);
                  return last ? relativeTime(last.available_at * 1000) : '—';
                })()}
              </TableCell>
              <TableCell>
                <div className="actions row-actions justify-end">
                  {sourceKinds.includes(source.kind) && (
                    <>
                      <Button variant="outline" disabled={busy} onClick={() => onEdit(source)}>
                        Edit
                      </Button>
                    </>
                  )}
                  {!['external', 'parquet', 'models'].includes(source.kind) && (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void action(() => client.discoverSource(source.id), 'Catalog discovered')
                        }
                      >
                        Discover
                      </Button>
                    </>
                  )}
                  {source.kind === 'external' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => onAddDataset(source.id)}
                    >
                      Add dataset
                    </Button>
                  )}
                  {!['parquet', 'models'].includes(source.kind) && (
                    <RowMenu label={'More actions for ' + source.name}>
                      {!['external', 'parquet', 'models'].includes(source.kind) && (
                        <>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                () => client.checkSource(source.id),
                                'Connection check passed',
                              )
                            }
                          >
                            Check
                          </Button>
                        </>
                      )}
                      {sourceKinds.includes(source.kind) && (
                        <>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={async () => {
                              if (await confirmDialog('Delete source “' + source.name + '”?'))
                                void action(() => client.deleteSource(source.id), 'Source deleted');
                            }}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </RowMenu>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </UiTable>
      {!sources.length && (
        <p className="empty">Add a source, then Discover to populate your Data Map.</p>
      )}
    </Tray>
  );
}
