import { useCallback, useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'sql-formatter';
import { Play, Square, Plus, X, Save, Braces } from 'lucide-react';
import { toast } from 'sonner';
import { monaco, autocomplete, editorTheme } from './monaco';
import { useResolvedTheme } from '@/stores/theme';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import { shortcuts, shortcutAction } from './workspace-model';
import type { Api, Me, SavedQuery, SqlExplain, SqlResult } from '@/lib/api';
import { tableReference } from './sql-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { ResultGrid } from '@/components/workbench/ResultGrid';
import { Skeleton } from '@/features/console/ConsoleDrawer';
interface Execution {
  result?: SqlResult;
  plans?: SqlExplain;
  error?: string;
}
export default function SqlView({
  client,
  initialQuery,
  readOnly,
  scope,
  me,
}: {
  client: Api;
  initialQuery: string;
  readOnly: boolean;
  scope: string;
  me: Me;
  revision: number;
  consoleCollapsed: boolean;
  onConsoleCollapsed: (v: boolean) => void;
}) {
  const store = useSqlWorkspace();
  const active = store.tabs.find((t) => t.id === store.active);
  const cache = useQueryClient();
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const initial = useRef<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, Execution>>({});
  const [running, setRunning] = useState<{ id: string; tab: string; explain: boolean } | null>(
    null,
  );
  const runningRef = useRef<typeof running>(null);
  const [resultTab, setResultTab] = useState<'Results' | 'Explain'>('Results');
  const [saveOpen, setSaveOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sideTab, setSideTab] = useState<'Catalog' | 'Saved'>('Catalog');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const catalog = useQuery({
    // Distinct from the client proxy's own cache key, or fetchQuery would await itself.
    queryKey: ['engine', 'catalog', 'sql-workspace-tables'],
    queryFn: () => client.sqlTables(),
    enabled: !readOnly,
  });
  const saved = useQuery({
    queryKey: ['engine', 'saved-queries', 'list'],
    queryFn: () => client.savedQueries(),
    enabled: !readOnly,
  });
  const dark = useResolvedTheme() === 'dark';
  const [theme, setTheme] = useState(dark ? 'vs-dark' : 'vs');
  useEffect(() => {
    setTheme(editorTheme(dark));
  }, [dark]);
  useEffect(() => {
    const provider = autocomplete(catalog.data?.tables ?? []);
    return () => provider.dispose();
  }, [catalog.data]);
  useEffect(() => {
    if (initial.current === initialQuery) return;
    initial.current = initialQuery;
    const state = useSqlWorkspace.getState();
    if (initialQuery === 'SELECT 1;' && state.tabs.length) return;
    state.add(initialQuery);
  }, [initialQuery]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const output = active ? outputs[active.id] : undefined;
  const run = useCallback(
    async (selection = false, explain = false) => {
      const state = useSqlWorkspace.getState();
      const tab = state.tabs.find((t) => t.id === state.active);
      if (!tab || runningRef.current || readOnly) return;
      const selected = editor.current?.getSelection();
      const sql = selection
        ? selected
          ? (editor.current?.getModel()?.getValueInRange(selected) ?? '')
          : ''
        : tab.sql;
      if (!sql.trim()) {
        toast.info(selection ? 'Select SQL in the editor first.' : 'Write a query first.');
        return;
      }
      const execution = { id: crypto.randomUUID(), tab: tab.id, explain };
      runningRef.current = execution;
      setRunning(execution);
      setOutputs((s) => ({
        ...s,
        [tab.id]: explain ? { result: s[tab.id]?.result } : { plans: s[tab.id]?.plans },
      }));
      setResultTab(explain ? 'Explain' : 'Results');
      const at = Date.now();
      try {
        if (explain) {
          const plans = await client.sqlExplain(sql);
          if (mounted.current) setOutputs((s) => ({ ...s, [tab.id]: { ...s[tab.id], plans } }));
        } else {
          const result = await client.sqlQuery(sql, 1000, execution.id);
          state.record({
            id: execution.id,
            scope,
            sql,
            at,
            elapsed_ms: result.elapsed_ms,
            row_count: result.row_count,
            status: 'succeeded',
          });
          if (mounted.current) setOutputs((s) => ({ ...s, [tab.id]: { ...s[tab.id], result } }));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!explain)
          state.record({
            id: execution.id,
            scope,
            sql,
            at,
            elapsed_ms: Date.now() - at,
            row_count: 0,
            status: message === 'cancelled' ? 'cancelled' : 'failed',
          });
        if (mounted.current) setOutputs((s) => ({ ...s, [tab.id]: { error: message } }));
      } finally {
        runningRef.current = null;
        if (mounted.current) setRunning(null);
      }
    },
    [client, readOnly, scope],
  );
  const cancel = useCallback(async () => {
    const q = runningRef.current;
    if (!q || q.explain) return;
    try {
      await client.cancelSql(q.id);
    } catch (e) {
      toast.error(String(e));
    }
  }, [client]);
  function formatSql() {
    if (!active) return;
    try {
      store.update(active.id, { sql: format(active.sql, { language: 'postgresql' }), dirty: true });
    } catch (e) {
      toast.error('Could not format SQL: ' + String(e));
    }
  }
  function beginSave() {
    if (!active) return;
    setSideTab('Saved');
    setName(active.name === 'Untitled query' ? '' : active.name);
    setShared(saved.data?.find((q) => q.id === active.savedId)?.shared ?? false);
    setSaveOpen(true);
  }
  function close(id: string) {
    const tab = store.tabs.find((t) => t.id === id);
    if (tab?.dirty) {
      setCloseTarget(id);
      return;
    }
    store.close(id);
  }
  const handler = useRef<(action: string) => void>(() => {});
  handler.current = (action) => {
    if (action === 'Run') void run();
    else if (action === 'Run selection') void run(true);
    else if (action === 'Cancel') void cancel();
    else if (action === 'Format') formatSql();
    else if (action === 'Save') beginSave();
    else if (action === 'New tab') store.add();
    else if (action === 'Close tab' && active) close(active.id);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const action = shortcutAction(e);
      if (action) {
        if (action === 'Cancel' && (!runningRef.current || runningRef.current.explain)) return;
        e.preventDefault();
        e.stopPropagation();
        handler.current(action);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  async function saveQuery() {
    if (!active || saving || !name.trim() || readOnly) return;
    setSaving(true);
    setError('');
    try {
      const original = saved.data?.find((q) => q.id === active.savedId);
      const writable = original && (original.owner_id === me.user.id || me.privileges.admin);
      const body = { name: name.trim(), sql: active.sql, shared };
      const q = writable
        ? await client.updateSavedQuery(original.id, body)
        : await client.createSavedQuery(body);
      store.update(active.id, { name: q.name, savedId: q.id, dirty: false });
      setSaveOpen(false);
      await cache.invalidateQueries({ queryKey: ['engine', 'saved-queries'] });
      toast.success('Query saved');
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  function openSaved(q: SavedQuery) {
    store.add(q.sql, q.name, q.id);
  }
  async function remove(q: SavedQuery) {
    try {
      await client.deleteSavedQuery(q.id);
      await cache.invalidateQueries({ queryKey: ['engine', 'saved-queries'] });
    } catch (e) {
      toast.error(String(e));
    }
  }
  return (
    <div className="sql-layout">
      <AlertDialog
        open={closeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCloseTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close unsaved query?</AlertDialogTitle>
            <AlertDialogDescription>
              The changes in this tab have not been saved as a query.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (closeTarget) store.close(closeTarget);
                setCloseTarget(null);
              }}
            >
              Close tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <aside className="sql-tables">
        <div className="tabs sql-side-tabs" role="tablist" aria-label="Side panel">
          <button
            type="button"
            role="tab"
            aria-selected={sideTab === 'Catalog'}
            onClick={() => setSideTab('Catalog')}
          >
            Catalog
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sideTab === 'Saved'}
            onClick={() => setSideTab('Saved')}
          >
            Saved queries
          </button>
        </div>
        <label>
          Find {sideTab === 'Catalog' ? 'a table' : 'a query'}
          <Input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {saveOpen && (
          <form
            className="save-query"
            onSubmit={(e) => {
              e.preventDefault();
              void saveQuery();
            }}
          >
            <label>
              Query name
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              Share with readers
            </label>
            <div className="actions">
              <Button type="submit" disabled={saving || readOnly || !name.trim()}>
                {saving ? 'Saving…' : 'Save query'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSaveOpen(false)}>
                Dismiss
              </Button>
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
          </form>
        )}
        {sideTab === 'Catalog' ? (
          <>
            {catalog.isPending && <Skeleton label="Loading catalog…" />}
            {catalog.isError && <p role="alert">{String(catalog.error)}</p>}
            {catalog.data?.tables
              .filter((t) => (t.schema + '.' + t.name).toLowerCase().includes(search.toLowerCase()))
              .map((t) => (
                <details key={t.schema + '.' + t.name}>
                  <summary>
                    <code>
                      {t.schema}.{t.name}
                    </code>
                  </summary>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      editor.current?.executeEdits('insert-table', [
                        {
                          range: editor.current.getSelection() ?? new monaco.Range(1, 1, 1, 1),
                          text: tableReference(t.schema, t.name),
                        },
                      ]);
                      editor.current?.focus();
                    }}
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
          </>
        ) : (
          <>
            {saved.isPending && <Skeleton label="Loading saved queries…" />}
            {saved.isError && <p role="alert">{String(saved.error)}</p>}
            {saved.data
              ?.filter((q) => q.name.toLowerCase().includes(search.toLowerCase()))
              .map((q) => (
                <div className="saved-query" key={q.id}>
                  <Button variant="ghost" onClick={() => openSaved(q)}>
                    <span>{q.name}</span>
                    <small>{q.shared ? 'Shared' : 'Private'}</small>
                  </Button>
                  {(q.owner_id === me.user.id || me.privileges.admin) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={'Delete ' + q.name}
                      disabled={readOnly}
                      onClick={() => void remove(q)}
                    >
                      <X size={14} />
                    </Button>
                  )}
                </div>
              ))}
            {saved.data?.length === 0 && (
              <p className="hint">Save a query to reuse it here or share it with your team.</p>
            )}
          </>
        )}
      </aside>
      <section className="sql-workspace">
        <div className="query-tabs" aria-label="SQL tabs">
          {store.tabs.map((t) => (
            <div key={t.id} className={t.id === store.active ? 'active' : ''}>
              <Button
                variant="ghost"
                aria-pressed={t.id === store.active}
                onClick={() => store.select(t.id)}
              >
                {t.dirty ? '● ' : ''}
                {t.name}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={'Close ' + t.name}
                onClick={() => close(t.id)}
              >
                <X size={14} />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New query tab"
            onClick={() => store.add()}
          >
            <Plus size={16} />
          </Button>
        </div>
        {active ? (
          <>
            <div className="sql-toolbar">
              <Button
                disabled={readOnly || !!running || !active.sql.trim()}
                onClick={() => void run()}
              >
                <Play size={16} />
                Run
              </Button>
              <Button
                variant="outline"
                disabled={readOnly || !!running}
                onClick={() => void run(true)}
              >
                Run selection
              </Button>
              <Button
                variant="outline"
                disabled={!running || running.explain}
                onClick={() => void cancel()}
              >
                <Square size={14} />
                Cancel
              </Button>
              <Button
                variant="ghost"
                disabled={readOnly || !!running}
                onClick={() => void run(false, true)}
              >
                Explain
              </Button>
              <Button variant="ghost" onClick={formatSql}>
                <Braces size={16} />
                Format
              </Button>
              <Button variant="ghost" onClick={beginSave} disabled={readOnly}>
                <Save size={16} />
                Save
              </Button>
            </div>
            <ResizablePanelGroup orientation="vertical">
              <ResizablePanel defaultSize="48%" minSize="120px">
                <Editor
                  key={active.id}
                  path={'straton://query/' + active.id + '.sql'}
                  language="sql"
                  value={active.sql}
                  theme={theme}
                  onChange={(sql) => store.update(active.id, { sql: sql ?? '', dirty: true })}
                  onMount={(value) => {
                    editor.current = value;
                  }}
                  loading={<Skeleton label="Loading SQL editor…" />}
                  options={{
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontFamily: 'JetBrains Mono Variable',
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    padding: { top: 16 },
                    tabSize: 2,
                    readOnly: false,
                  }}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel minSize="100px">
                <div className="sql-output">
                  <div className="results-toolbar">
                    <div className="tabs result-tabs" role="tablist" aria-label="Output">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={resultTab === 'Results'}
                        onClick={() => setResultTab('Results')}
                      >
                        Results
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={resultTab === 'Explain'}
                        onClick={() => setResultTab('Explain')}
                      >
                        Explain
                      </button>
                    </div>
                    <span role="status">
                      <code>
                        {running?.tab === active.id
                          ? 'Running…'
                          : output?.result
                            ? output.result.elapsed_ms.toLocaleString() +
                              ' ms · ' +
                              output.result.row_count.toLocaleString() +
                              ' rows'
                            : ''}
                      </code>
                    </span>
                  </div>
                  {output?.error && (
                    <div className="sql-error" role="alert">
                      <h3>Query could not finish</h3>
                      <pre>{output.error}</pre>
                      {/line|position/i.test(output.error) && (
                        <p className="hint">
                          Use the line or position above to locate the statement in the editor.
                        </p>
                      )}
                    </div>
                  )}
                  {running?.tab === active.id && <Skeleton label="Executing query…" />}
                  {resultTab === 'Results' && output?.result && (
                    <>
                      {output.result.truncated_preview && (
                        <p className="truncated-notice" role="status">
                          Showing the first 1,000 rows of {output.result.row_count.toLocaleString()}
                          . Use Explorer to export a larger result.
                        </p>
                      )}
                      <ResultGrid
                        key={active.id}
                        columns={output.result.columns}
                        rows={output.result.rows}
                        scope={scope}
                        tableKey={'sql:' + active.id}
                      />
                    </>
                  )}
                  {resultTab === 'Explain' && output?.plans && (
                    <div className="sql-plans">
                      <h3>Logical plan</h3>
                      <pre>{output.plans.logical}</pre>
                      <h3>Physical plan</h3>
                      <pre>{output.plans.physical}</pre>
                    </div>
                  )}
                  {!output && !running && (
                    <p className="empty-copy">
                      Run your SQL to inspect its results, or choose Explain to review the plan.
                    </p>
                  )}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </>
        ) : (
          <div className="empty-copy">
            <p>Open a saved query or create a tab to start.</p>
            <Button onClick={() => store.add()}>New query</Button>
          </div>
        )}
        <details className="shortcut-hint">
          <summary>Keyboard shortcuts</summary>
          <div>
            {shortcuts.map(([key, action]) => (
              <span key={key}>
                <kbd>{key}</kbd> {action}
              </span>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}
