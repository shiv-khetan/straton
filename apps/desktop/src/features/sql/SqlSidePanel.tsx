import { Checkbox } from '@/components/ui/checkbox';
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { StatePill } from '@/components/workbench/primitives';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import type { Api, Me, SavedQuery } from '@/lib/api';
import { offlineMessage } from '@/lib/offline-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { tableReference } from './sql-model';
import { relativeTime } from '@/lib/view-model';

type Catalog = Awaited<ReturnType<Api['sqlTables']>>;

// Left rail of the SQL workspace: table catalog, saved queries and this device's query
// history, with the save form on top.
export function SqlSidePanel({
  hidden,
  sideTab,
  onSideTab,
  search,
  onSearch,
  catalog,
  saved,
  readOnly,
  me,
  saveForm,
  onInsertTable,
  onOpenSaved,
  onRemove,
  scope,
  onOpenHistory,
}: {
  hidden: boolean;
  sideTab: string;
  onSideTab: (tab: string) => void;
  search: string;
  onSearch: (value: string) => void;
  catalog: UseQueryResult<Catalog>;
  saved: UseQueryResult<SavedQuery[]>;
  readOnly: boolean;
  me: Me;
  saveForm: ReactNode;
  onInsertTable: (reference: string) => void;
  onOpenSaved: (query: SavedQuery) => void;
  onRemove: (query: SavedQuery) => void;
  scope: string;
  onOpenHistory: (sql: string) => void;
}) {
  return (
    <aside id="sql-catalog" className="sql-tables" hidden={hidden}>
      <Tabs value={sideTab} onValueChange={onSideTab} className="sql-side-panel gap-0">
        <TabsList variant="line" className="tabs sql-side-tabs" aria-label="Side panel">
          <TabsTrigger className="sql-panel-tab" value="Catalog">
            Catalog
          </TabsTrigger>
          <TabsTrigger className="sql-panel-tab" value="Saved" title="Saved queries">
            Saved
          </TabsTrigger>
          <TabsTrigger className="sql-panel-tab" value="History">
            History
          </TabsTrigger>
        </TabsList>
        <label>
          Find {sideTab === 'Catalog' ? 'a table' : 'a query'}
          <Input value={search} onChange={(e) => onSearch(e.target.value)} />
        </label>
        {saveForm}
        <TabsContent value="Catalog">
          {catalog.isLoading && <Skeleton label="Loading catalog…" />}
          {readOnly && (
            <p className="hint" role="status">
              {offlineMessage(readOnly, catalog.data, 'the catalog')}
            </p>
          )}
          {!readOnly && catalog.isError && <p role="alert">{String(catalog.error)}</p>}
          {catalog.data?.tables
            .filter((t) => (t.schema + '.' + t.name).toLowerCase().includes(search.toLowerCase()))
            .map((t) => (
              <details key={t.schema + '.' + t.name}>
                <summary title={t.schema + '.' + t.name}>
                  <code>
                    {t.schema}.{t.name}
                  </code>
                </summary>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onInsertTable(tableReference(t.schema, t.name))}
                >
                  Insert table name
                </Button>
                {t.columns.map((c) => (
                  <div className="catalog-column" key={c.name}>
                    <code>{c.name}</code>
                    <code className="hint">{c.type}</code>
                  </div>
                ))}
              </details>
            ))}
        </TabsContent>
        <TabsContent value="Saved">
          {saved.isLoading && <Skeleton label="Loading saved queries…" />}
          {readOnly && (
            <p className="hint" role="status">
              {offlineMessage(readOnly, saved.data, 'saved queries')}
            </p>
          )}
          {!readOnly && saved.isError && <p role="alert">{String(saved.error)}</p>}
          {saved.data
            ?.filter((q) => q.name.toLowerCase().includes(search.toLowerCase()))
            .map((q) => (
              <div className="saved-query" key={q.id}>
                <Button variant="ghost" onClick={() => onOpenSaved(q)}>
                  <span>{q.name}</span>
                  <small>{q.shared ? 'Shared' : 'Private'}</small>
                </Button>
                {(q.owner_id === me.user.id || me.privileges.admin) && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={'Delete ' + q.name}
                    disabled={readOnly}
                    onClick={() => onRemove(q)}
                  >
                    <X size={14} />
                  </Button>
                )}
              </div>
            ))}
          {saved.data?.length === 0 && (
            <p className="hint">Save a query to reuse it here or share it with your team.</p>
          )}
        </TabsContent>
        <TabsContent value="History">
          <HistoryList scope={scope} search={search} onOpen={onOpenHistory} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

export function SaveQueryForm({
  saveTarget,
  name,
  setName,
  shared,
  setShared,
  saving,
  readOnly,
  error,
  onSubmit,
  onDismiss,
}: {
  saveTarget?: { name: string };
  name: string;
  setName: (name: string) => void;
  shared: boolean;
  setShared: (shared: boolean) => void;
  saving: boolean;
  readOnly: boolean;
  error: string;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  return (
    <form
      className="save-query"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="hint" role="status">
        {saveTarget
          ? `Saving “${saveTarget.name}”`
          : 'This query tab was closed. Dismiss and choose another tab to save.'}
      </p>
      <label>
        Query name
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
      </label>
      <label className="checkbox-label">
        <Checkbox checked={shared} onCheckedChange={(checked) => setShared(checked === true)} />
        Share with readers
      </label>
      <div className="actions">
        <Button type="submit" disabled={saving || readOnly || !saveTarget || !name.trim()}>
          {saving ? 'Saving…' : 'Save query'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

// Executions run on this device, newest first. Opening one starts a new tab with its SQL.
function HistoryList({
  scope,
  search,
  onOpen,
}: {
  scope: string;
  search: string;
  onOpen: (sql: string) => void;
}) {
  const entries = useSqlWorkspace((s) => s.history);
  const clear = useSqlWorkspace((s) => s.clear);
  const restore = useSqlWorkspace((s) => s.restore);
  const mine = entries.filter((e) => e.scope === scope);
  const shown = mine.filter((e) => e.sql.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      {shown.map((e) => (
        <div className="saved-query" key={e.id}>
          <Button
            variant="ghost"
            className="h-auto min-w-0 flex-1 flex-col items-start gap-1 px-2 py-2.5 text-left"
            title={
              e.sql +
              '\n\n' +
              new Date(e.at).toLocaleString() +
              ' · ' +
              e.elapsed_ms.toLocaleString() +
              ' ms · ' +
              e.row_count.toLocaleString() +
              ' rows'
            }
            onClick={() => onOpen(e.sql)}
          >
            <span className="mono max-w-full truncate font-normal">
              {e.sql.trim().split('\n')[0]}
            </span>
            <small className="flex items-center gap-2">
              <StatePill state={e.status} />
              {relativeTime(e.at)}
            </small>
          </Button>
        </div>
      ))}
      {!shown.length && (
        <p className="hint">
          {search ? 'No queries match your search.' : 'Queries you run appear here.'}
        </p>
      )}
      {mine.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => {
            clear(scope);
            toast('Query history cleared', {
              description:
                mine.length +
                (mine.length === 1 ? ' query' : ' queries') +
                ' removed from this device.',
              action: { label: 'Undo', onClick: () => restore(mine) },
            });
          }}
        >
          Clear history
        </Button>
      )}
      <p className="hint">Up to 500 executions are kept on this device.</p>
    </>
  );
}
