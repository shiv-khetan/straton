import { useEffect, useRef, useState } from 'react';
import type { Api, SqlExplain, SqlResult, SqlTable } from './api';
import { cellText, tableReference } from './sql-model';
import { Button, Card, EmptyState, Icon, SchemaTree } from './ui';
import { ConsoleDrawer, Skeleton } from './Workbench';

export default function SqlView({
  client,
  revision,
  initialQuery,
  consoleCollapsed,
  onConsoleCollapsed,
  readOnly,
}: {
  client: Api;
  revision: number;
  initialQuery: string;
  consoleCollapsed: boolean;
  onConsoleCollapsed: (value: boolean) => void;
  readOnly: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState('Results');
  const [search, setSearch] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(false);
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);
  const [tables, setTables] = useState<SqlTable[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [plans, setPlans] = useState<SqlExplain | null>(null);
  const [busy, setBusy] = useState(false);
  const gutter = useRef<HTMLPreElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const current = useRef(0);
  useEffect(() => {
    let active = true;
    setCatalogError('');
    void client
      .sqlTables()
      .then(({ tables }) => {
        if (active) setTables(tables);
      })
      .catch((e: unknown) => {
        if (active) setCatalogError(String(e));
      });
    return () => {
      active = false;
    };
  }, [client, revision]);
  useEffect(
    () => () => {
      current.current += 1;
    },
    [client],
  );
  async function run(explain = false) {
    if (busy || readOnly || !query.trim()) return;
    onConsoleCollapsed(false);
    const request = ++current.current;
    setBusy(true);
    setError('');
    setTab(explain ? 'Explain' : 'Results');
    if (explain) setPlans(null);
    else setResult(null);
    try {
      if (explain) {
        const value = await client.sqlExplain(query);
        if (current.current === request) setPlans(value);
      } else {
        const value = await client.sqlQuery(query, 1000);
        if (current.current === request) setResult(value);
      }
    } catch (e) {
      if (current.current === request) setError(String(e));
    } finally {
      if (current.current === request) setBusy(false);
    }
  }
  function insert(table: SqlTable) {
    const input = editor.current;
    const start = input?.selectionStart ?? query.length;
    const end = input?.selectionEnd ?? start;
    const text = tableReference(table.schema, table.name);
    setQuery(query.slice(0, start) + text + query.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + text.length, start + text.length);
    });
  }
  return (
    <div className="sql-layout">
      <div className="sql-workspace" aria-label="SQL workspace" aria-busy={busy}>
        <Card>
          <h2>SQL editor</h2>
          <label className="field" htmlFor="sql-query">
            <span>Query</span>
            <div className="editor-with-gutter">
              <pre ref={gutter} className="line-numbers" aria-hidden="true">
                {query
                  .split('\n')
                  .map((_, i) => i + 1)
                  .join('\n')}
              </pre>
              <textarea
                id="sql-query"
                ref={editor}
                onScroll={(e) => {
                  if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
                }}
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void run();
                  }
                }}
              />
            </div>
          </label>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || readOnly || !query.trim()}
              onClick={() => void run()}
            >
              {busy ? 'Running…' : 'Run'}
            </button>
            <button disabled={busy || readOnly || !query.trim()} onClick={() => void run(true)}>
              Explain
            </button>
            <span className="hint">
              Ctrl / Cmd + Enter to run · Read-only · Preview up to 1,000 rows
            </span>
          </div>
          {error && (
            <p className="message error" role="alert">
              {error}
            </p>
          )}
        </Card>
        <ConsoleDrawer
          tabs={['Results', 'Explain']}
          tab={tab}
          onTab={setTab}
          collapsed={consoleCollapsed}
          onCollapsed={onConsoleCollapsed}
        >
          {busy && <Skeleton label={tab === 'Explain' ? 'Planning query…' : 'Running query…'} />}
          {tab === 'Results' && result && (
            <>
              <p role="status">
                {result.row_count.toLocaleString()} rows · {result.elapsed_ms.toLocaleString()} ms
                {result.truncated_preview && ' · Showing the first 1,000 rows'}
              </p>
              {result.columns.length > 0 && (
                <div className="sql-results" tabIndex={0} role="region" aria-label="Query results">
                  <table>
                    <thead>
                      <tr>
                        {result.columns.map((column, i) => (
                          <th key={i} scope="col">
                            {column.name}
                            <small>{column.type}</small>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, r) => (
                        <tr key={r}>
                          {row.map((value, c) => (
                            <td key={c} className={value === null ? 'sql-null' : undefined}>
                              {cellText(value)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {result.row_count === 0 && <p className="empty">Query returned no rows.</p>}
            </>
          )}
          {tab === 'Explain' && plans && (
            <div className="sql-plans">
              <h2>Logical plan</h2>
              <pre tabIndex={0}>{plans.logical}</pre>
              <h2>Physical plan</h2>
              <pre tabIndex={0}>{plans.physical}</pre>
            </div>
          )}
          {tab === 'Results' && !result && !busy && (
            <EmptyState icon="sql">Run a query to explore your published data.</EmptyState>
          )}
          {tab === 'Explain' && !plans && !busy && (
            <EmptyState icon="map">Choose Explain to inspect the query plan.</EmptyState>
          )}
        </ConsoleDrawer>
      </div>
      <section className="sql-tables" data-open={catalogOpen} aria-label="Available tables">
        <Button
          className="schema-toggle"
          aria-label={catalogOpen ? 'Close schema browser' : 'Open schema browser'}
          aria-expanded={catalogOpen}
          onClick={() => setCatalogOpen(!catalogOpen)}
        >
          <Icon name={catalogOpen ? 'close' : 'source'} />
        </Button>
        <h2>Available tables</h2>
        <p className="hint">Click a table to insert its name at the cursor.</p>
        {catalogError && <p role="alert">{catalogError}</p>}
        {!catalogError && tables.length === 0 && (
          <p className="empty">No published datasets yet. Sync a dataset to query it here.</p>
        )}
        <label className="field">
          <span>Find table</span>
          <input
            type="search"
            placeholder="Search tables…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <SchemaTree
          groups={[...new Set(tables.map((t) => t.schema))].map((schema) => ({
            id: schema,
            label: schema,
            items: tables
              .filter(
                (t) => t.schema === schema && t.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((t) => ({
                id: tableReference(t.schema, t.name),
                label: t.name,
                columns: t.columns,
              })),
          }))}
          onSelect={(id) => {
            const table = tables.find((t) => tableReference(t.schema, t.name) === id);
            if (table) insert(table);
          }}
        />
      </section>
    </div>
  );
}
