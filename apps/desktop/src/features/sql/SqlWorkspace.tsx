import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'sql-formatter';
import { Play, Square, Plus, X, Save, Braces, PanelLeft } from 'lucide-react';
import { toast } from 'sonner';
import { monaco, autocomplete, editorTheme } from './monaco';
import { useResolvedTheme } from '@/stores/theme';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import {
  shortcuts,
  shortcutAction,
  snapshotSaveTarget,
  completeQuerySave,
  workspaceShortcutAllowed,
} from './workspace-model';
import { PageActions } from '@/components/workbench/primitives';
import type { Api, Me, SavedQuery } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { SqlOutput } from './SqlOutput';
import { SaveQueryForm, SqlSidePanel } from './SqlSidePanel';
import { useSqlRunner } from './use-sql-runner';
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
  const workspace = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const initial = useRef<string | null>(null);
  const { outputs, running, runningRef, resultTab, setResultTab, run, cancel } = useSqlRunner(
    client,
    readOnly,
    scope,
    editor,
  );
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTargetId, setSaveTargetId] = useState<string | null>(null);
  const saveTarget = store.tabs.find((tab) => tab.id === saveTargetId);
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sideTab, setSideTab] = useState('Catalog');
  const [search, setSearch] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(true);
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
  const output = active ? outputs[active.id] : undefined;
  function formatSql() {
    if (!active) return;
    try {
      store.update(active.id, { sql: format(active.sql, { language: 'postgresql' }), dirty: true });
    } catch (e) {
      toast.error('Could not format SQL: ' + String(e));
    }
  }
  function beginSave() {
    if (!active || saving) return;
    setSaveTargetId(active.id);
    setError('');
    setCatalogOpen(true);
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
      if (e.defaultPrevented || !(e.target instanceof Element)) return;
      if (
        !workspaceShortcutAllowed({
          withinWorkspace: workspace.current?.contains(e.target) ?? false,
          inOverlay: !!e.target.closest(
            '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
          ),
          ordinaryField:
            !!e.target.closest('input,textarea,select,[contenteditable="true"]') &&
            !e.target.closest('.monaco-editor'),
        })
      )
        return;
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
    const submitted = snapshotSaveTarget(useSqlWorkspace.getState().tabs, saveTargetId);
    if (!submitted || saving || !name.trim() || readOnly) return;
    setSaving(true);
    setError('');
    try {
      const original = saved.data?.find((q) => q.id === submitted.savedId);
      const writable = original && (original.owner_id === me.user.id || me.privileges.admin);
      const body = { name: name.trim(), sql: submitted.sql, shared };
      const q = writable
        ? await client.updateSavedQuery(original.id, body)
        : await client.createSavedQuery(body);
      useSqlWorkspace.setState((state) => ({
        tabs: completeQuerySave(state.tabs, submitted, q),
      }));
      setSaveOpen(false);
      await cache.invalidateQueries({ queryKey: ['engine', 'saved-queries'] });
      toast.success('Query saved');
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  async function remove(q: SavedQuery) {
    if (
      !(await confirmDialog('Delete saved query “' + q.name + '”?', {
        title: 'Delete saved query',
        kind: 'warning',
      }))
    )
      return;
    try {
      await client.deleteSavedQuery(q.id);
      await cache.invalidateQueries({ queryKey: ['engine', 'saved-queries'] });
    } catch (e) {
      toast.error(String(e));
    }
  }
  return (
    <div className="sql-layout" ref={workspace}>
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
      <div className="catalog-toolbar">
        <Button
          variant="outline"
          size="sm"
          aria-expanded={catalogOpen}
          aria-controls="sql-catalog"
          onClick={() => setCatalogOpen((open) => !open)}
        >
          <PanelLeft size={16} />
          {catalogOpen ? 'Hide catalog' : 'Show catalog'}
        </Button>
        <span className="hint">Catalog and saved queries</span>
      </div>
      <div className="sql-workarea">
        <SqlSidePanel
          hidden={!catalogOpen}
          sideTab={sideTab}
          onSideTab={setSideTab}
          search={search}
          onSearch={setSearch}
          catalog={catalog}
          saved={saved}
          readOnly={readOnly}
          me={me}
          saveForm={
            saveOpen && (
              <SaveQueryForm
                saveTarget={saveTarget}
                name={name}
                setName={setName}
                shared={shared}
                setShared={setShared}
                saving={saving}
                readOnly={readOnly}
                error={error}
                onSubmit={() => void saveQuery()}
                onDismiss={() => setSaveOpen(false)}
              />
            )
          }
          onInsertTable={(reference) => {
            editor.current?.executeEdits('insert-table', [
              {
                range: editor.current.getSelection() ?? new monaco.Range(1, 1, 1, 1),
                text: reference,
              },
            ]);
            editor.current?.focus();
          }}
          onOpenSaved={(q) => store.add(q.sql, q.name, q.id)}
          onRemove={(q) => void remove(q)}
        />
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
              <PageActions>
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
              </PageActions>
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
                  <SqlOutput
                    tabId={active.id}
                    output={output}
                    running={running}
                    tab={resultTab}
                    onTab={setResultTab}
                    scope={scope}
                  />
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
    </div>
  );
}
