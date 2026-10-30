import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ui/button';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Action } from '@/components/workbench/Field';
import type { Api, Source } from '@/lib/api';
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
}: {
  sources: Source[];
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
            <TableHead scope="col">Actions</TableHead>
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
                <StatePill state={source.kind === 'external' ? 'External' : 'Configured'} />
              </TableCell>
              <TableCell>
                <div className="actions row-actions">
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
                          {' '}
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
                          {' '}
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
