import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { Database, Table2, Download, ChevronLeft, ChevronRight, PanelRight } from 'lucide-react';
import { toast } from 'sonner';
import type { Api, Dataset, ExplorerFilter, FilterOp } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ResultGrid, TypeIcon } from '@/components/workbench/ResultGrid';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { explorerRequest, filterOps, parseFilter } from './explorer-model';
import { tableReference } from '@/features/sql/sql-model';
function FilterBar({
  table,
  filters,
  onChange,
}: {
  table: Dataset;
  filters: ExplorerFilter[];
  onChange: (v: ExplorerFilter[]) => void;
}) {
  const [column, setColumn] = useState(table.columns[0]?.name ?? '');
  const [op, setOp] = useState<FilterOp>('eq');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="filter-bar">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            onChange([...filters, parseFilter(column, op, value)]);
            setError('');
            setValue('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <label>
          Column
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
            {table.columns.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          Operator
          <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)}>
            {filterOps.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        {!['is_null', 'not_null'].includes(op) && (
          <label>
            Value
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={op === 'in' ? '["one", "two"]' : 'Filter value'}
            />
          </label>
        )}
        <Button variant="outline" type="submit">
          Add filter
        </Button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="filter-chips">
        {filters.map((f, i) => (
          <Button
            variant="secondary"
            size="sm"
            key={i}
            aria-label={'Remove filter ' + f.column + ' ' + f.op}
            onClick={() => onChange(filters.filter((_, n) => n !== i))}
          >
            <code>
              {f.column} {f.op} {f.value === undefined ? '' : JSON.stringify(f.value)}
            </code>
            <span aria-hidden="true">×</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
function TableView({
  client,
  table,
  scope,
  readOnly,
  onQuery,
}: {
  client: Api;
  table: Dataset;
  scope: string;
  readOnly: boolean;
  onQuery: (sql: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filters, setFilters] = useState<ExplorerFilter[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [pageIndex, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [meta, setMeta] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  const request = explorerRequest(table.sql_schema, table.sql_table, {
    sorting,
    filters,
    search: debounced,
    pageIndex,
    pageSize,
  });
  const result = useQuery({
    queryKey: ['engine', 'explorer', 'rows', scope, request],
    queryFn: () => client.explorerRows(request),
    placeholderData: keepPreviousData,
    enabled: !readOnly,
  });
  const data = result.data;
  const query = () =>
    onQuery('SELECT * FROM ' + tableReference(table.sql_schema, table.sql_table) + ' LIMIT 100;');
  async function exportFile(format: 'csv' | 'parquet') {
    setExporting(true);
    try {
      const path = await save({
        title: 'Export ' + table.name,
        defaultPath: table.sql_table.replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + format,
        filters: [{ name: format === 'csv' ? 'CSV' : 'Parquet', extensions: [format] }],
      });
      if (!path) return;
      const buffer = await client.explorerExport({
        ...request,
        offset: 0,
        format,
        max_rows: 1_000_000,
      });
      await invoke('save_export', { path, bytes: Array.from(new Uint8Array(buffer)) });
      toast.success('Export saved');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="explorer-table" aria-label={table.name}>
      <div className="explorer-toolbar">
        <div className="min-w-0">
          <h2>{table.display_name ?? table.name}</h2>
          <code className="hint">{tableReference(table.sql_schema, table.sql_table)}</code>
        </div>
        <div className="actions">
          <Button variant="outline" onClick={query}>
            Open in SQL
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={readOnly || exporting}>
                <Download size={16} />
                {exporting ? 'Exporting…' : 'Export'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => void exportFile('csv')}>CSV</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportFile('parquet')}>
                Parquet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Table metadata"
            aria-expanded={meta}
            onClick={() => setMeta(!meta)}
          >
            <PanelRight size={18} />
          </Button>
        </div>
      </div>
      <label className="record-search">
        Search records
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search text columns…"
        />
      </label>
      <FilterBar
        table={table}
        filters={filters}
        onChange={(f) => {
          setFilters(f);
          setPage(0);
        }}
      />
      <div className="explorer-data">
        <div className="explorer-grid-area" aria-busy={result.isFetching}>
          {result.isError && (
            <div role="alert" className="inline-error">
              {String(result.error)}{' '}
              <Button variant="outline" onClick={() => void result.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {result.isPending ? (
            <Skeleton label="Loading table rows…" />
          ) : (
            data && (
              <ResultGrid
                key={table.id}
                columns={data.columns}
                rows={data.rows}
                scope={scope}
                tableKey={table.id}
                sorting={sorting}
                onSort={(s) => {
                  setSorting(s);
                  setPage(0);
                }}
                onFilter={(column, value) => {
                  setFilters((f) => [
                    ...f,
                    value === null ? { column, op: 'is_null' } : { column, op: 'eq', value },
                  ]);
                  setPage(0);
                }}
                onQuery={query}
              />
            )
          )}
          <div className="pagination" role="status">
            <span>
              <code>
                {data?.total_exact ? '' : '≈ '}
                {data?.total.toLocaleString() ?? '—'}
              </code>{' '}
              rows {result.isFetching ? '· Updating…' : ''}
            </span>
            <label className="flex items-center gap-2 whitespace-nowrap">
              Rows per page
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(0);
                }}
              >
                {[50, 100, 250, 500].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={pageIndex === 0 || result.isFetching}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={16} />
            </Button>
            <code>Page {pageIndex + 1}</code>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={
                !data ||
                result.isFetching ||
                data.rows.length < pageSize ||
                (data.total_exact && (pageIndex + 1) * pageSize >= data.total)
              }
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        </div>
        {meta && (
          <aside className="table-metadata">
            <h3>Table details</h3>
            <dl>
              <dt>SQL name</dt>
              <dd>
                <code>{tableReference(table.sql_schema, table.sql_table)}</code>
              </dd>
              <dt>Rows</dt>
              <dd>
                <code>{table.row_count?.toLocaleString() ?? 'Policy filtered / unknown'}</code>
              </dd>
              <dt>Last sync</dt>
              <dd>
                <code>{table.last_synced_at ?? 'Never synced'}</code>
              </dd>
              <dt>Policies</dt>
              <dd>
                {table.row_filtered ? 'Row filter applied' : 'No row filter'} ·{' '}
                {table.columns.filter((c) => c.masked).length} masked columns
              </dd>
            </dl>
            <h3>Columns</h3>
            {table.columns.map((c) => (
              <div key={c.name} className="metadata-column">
                <TypeIcon type={c.type} />
                <code>{c.name}</code>
                <code className="hint">{c.type}</code>
                {c.pk && <span className="policy-badge">PK</span>}
                {c.masked && <span className="policy-badge">Masked</span>}
              </div>
            ))}
          </aside>
        )}
      </div>
    </section>
  );
}
export default function Explorer({
  client,
  scope,
  readOnly,
  onQuery,
}: {
  client: Api;
  scope: string;
  readOnly: boolean;
  onQuery: (sql: string) => void;
}) {
  const tree = useQuery({
    queryKey: ['engine', 'explorer', 'tree', scope],
    queryFn: () => client.explorerTree(),
    enabled: !readOnly,
  });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);
  const sources = tree.data?.sources ?? [];
  const tables = sources.flatMap((s) => s.schemas.flatMap((s) => s.tables));
  const table = tables.find((t) => t.id === selected);
  return (
    <div className="explorer-layout">
      <aside className="explorer-tree">
        <label>
          Find a table
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Source, schema, table…"
          />
        </label>
        <div
          ref={treeRef}
          aria-label="Sources and tables"
          onKeyDown={(e) => {
            const items = Array.from(
              treeRef.current?.querySelectorAll<HTMLElement>('summary,button') ?? [],
            ).filter((el) => el.offsetParent !== null);
            const at = items.indexOf(document.activeElement as HTMLElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              items[
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? items.length - 1
                    : Math.min(items.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
              ]?.focus();
            }
            if (
              (e.key === 'ArrowRight' || e.key === 'ArrowLeft') &&
              e.target instanceof HTMLElement &&
              e.target.tagName === 'SUMMARY'
            ) {
              e.preventDefault();
              (e.target.parentElement as HTMLDetailsElement).open = e.key === 'ArrowRight';
            }
          }}
        >
          {tree.isPending && <Skeleton label="Loading sources…" />}
          {tree.isError && (
            <div role="alert">
              {String(tree.error)}
              <Button variant="outline" onClick={() => void tree.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {sources.map((source) => {
            const groups = source.schemas
              .map((schema) => ({
                ...schema,
                tables: schema.tables.filter((t) =>
                  (source.name + ' ' + schema.name + ' ' + t.name)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                ),
              }))
              .filter((s) => s.tables.length);
            return (
              groups.length > 0 && (
                <details key={source.source_id} open={search ? true : undefined}>
                  <summary>
                    <Database size={16} />
                    {source.name}
                  </summary>
                  {groups.map((schema) => (
                    <details key={schema.name} open={search ? true : undefined}>
                      <summary>{schema.name}</summary>
                      {schema.tables.map((t) => (
                        <button
                          type="button"
                          key={t.id}
                          className={selected === t.id ? 'selected' : ''}
                          aria-pressed={selected === t.id}
                          onClick={() => setSelected(t.id)}
                        >
                          <Table2 size={14} />
                          <span>{t.display_name ?? t.name}</span>
                        </button>
                      ))}
                    </details>
                  ))}
                </details>
              )
            );
          })}
          {!tree.isPending && !tables.length && (
            <p className="hint">Discover a source, then sync a dataset to browse its rows.</p>
          )}
        </div>
      </aside>
      {table ? (
        <TableView
          key={table.id}
          client={client}
          table={table}
          scope={scope}
          readOnly={readOnly}
          onQuery={onQuery}
        />
      ) : (
        <div className="explorer-empty">
          <Table2 size={32} />
          <h2>Explore your data</h2>
          <p>Select a table to inspect records, apply filters, or export a snapshot.</p>
        </div>
      )}
    </div>
  );
}
