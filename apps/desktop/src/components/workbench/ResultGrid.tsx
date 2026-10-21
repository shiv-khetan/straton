import { useEffect, useMemo, useRef, useState } from 'react';
import { useLegacyTable } from '@tanstack/react-table/legacy';
import type { SortingState, ColumnSizingState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Binary,
  Calendar,
  Hash,
  LetterText,
  ToggleLeft,
  Columns3,
  ArrowDown,
  ArrowUp,
} from 'lucide-react';
import type { SqlColumn, SqlCell } from '@/lib/api';
import { cellText } from '@/features/sql/sql-model';
import { parseWidths, widthKey } from '@/features/explorer/explorer-model';
import { safeStorage } from '@/stores/storage';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import { toast } from 'sonner';
export function TypeIcon({ type }: { type: string }) {
  const Icon = /int|float|decimal/i.test(type)
    ? Hash
    : /date|time/i.test(type)
      ? Calendar
      : /bool/i.test(type)
        ? ToggleLeft
        : /utf|string|text/i.test(type)
          ? LetterText
          : Binary;
  return <Icon size={14} aria-hidden="true" />;
}
export function ResultGrid({
  columns,
  rows,
  scope,
  tableKey,
  sorting = [],
  onSort,
  onFilter,
  onQuery,
}: {
  columns: SqlColumn[];
  rows: SqlCell[][];
  scope: string;
  tableKey: string;
  sorting?: SortingState;
  onSort?: (s: SortingState) => void;
  onFilter?: (column: string, value: SqlCell) => void;
  onQuery?: () => void;
}) {
  const key = widthKey(scope, tableKey);
  const [sizes, setSizes] = useState<ColumnSizingState>(() => {
    try {
      return parseWidths(JSON.parse(String(safeStorage.getItem(key) ?? '{}')));
    } catch {
      return {};
    }
  });
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  useEffect(() => {
    safeStorage.setItem(key, JSON.stringify(sizes));
  }, [key, sizes]);
  const defs = useMemo(
    () =>
      columns.map((c, i) => ({
        id: c.name,
        accessorFn: (r: SqlCell[]) => r[i],
        header: c.name,
        minSize: 64,
        maxSize: 1200,
        size: 180,
      })),
    [columns],
  );
  const table = useLegacyTable({
    data: rows,
    columns: defs,
    state: { columnSizing: sizes, columnVisibility: visibility, sorting },
    onColumnSizingChange: setSizes,
    onColumnVisibilityChange: setVisibility,
    onSortingChange: (updater) =>
      onSort?.(typeof updater === 'function' ? updater(sorting) : updater),
    manualSorting: true,
    columnResizeMode: 'onChange',
    enableSorting: !!onSort,
  });
  const parent = useRef<HTMLDivElement>(null);
  const model = table.getRowModel().rows;
  const virtual = useVirtualizer({
    count: model.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 36,
    overscan: 12,
  });
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Clipboard is unavailable');
    }
  }
  return (
    <div className="result-grid">
      <div className="grid-toolbar">
        <span className="hint">
          <code>{columns.length}</code> columns
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <Columns3 size={16} />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table.getAllLeafColumns().map((c) => (
              <DropdownMenuCheckboxItem
                key={c.id}
                checked={c.getIsVisible()}
                disabled={c.getIsVisible() && table.getVisibleLeafColumns().length === 1}
                onCheckedChange={(value) => c.toggleVisibility(!!value)}
              >
                {c.id}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        className="grid-scroll"
        ref={parent}
        tabIndex={0}
        aria-label="Query results, scroll to browse rows"
      >
        <table
          className="virtual-table"
          style={{ width: table.getTotalSize() }}
          aria-rowcount={rows.length + 1}
        >
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((h) => {
                  const type = columns.find((c) => c.name === h.column.id)?.type ?? '';
                  return (
                    <th
                      key={h.id}
                      style={{ width: h.getSize() }}
                      scope="col"
                      aria-sort={
                        h.column.getIsSorted() === 'asc'
                          ? 'ascending'
                          : h.column.getIsSorted() === 'desc'
                            ? 'descending'
                            : 'none'
                      }
                    >
                      <div className="grid-column">
                        <button
                          type="button"
                          disabled={!onSort}
                          onClick={h.column.getToggleSortingHandler()}
                        >
                          <TypeIcon type={type} />
                          <span>{h.column.id}</span>
                          {h.column.getIsSorted() === 'asc' ? (
                            <ArrowUp size={12} />
                          ) : h.column.getIsSorted() === 'desc' ? (
                            <ArrowDown size={12} />
                          ) : null}
                        </button>
                        <code>{type}</code>
                      </div>
                      <div
                        role="separator"
                        aria-label={'Resize ' + h.column.id}
                        aria-orientation="vertical"
                        aria-valuenow={h.getSize()}
                        aria-valuemin={64}
                        aria-valuemax={1200}
                        tabIndex={0}
                        className="column-resize"
                        onMouseDown={h.getResizeHandler()}
                        onTouchStart={h.getResizeHandler()}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                            e.preventDefault();
                            setSizes((s) => ({
                              ...s,
                              [h.column.id]: Math.min(
                                1200,
                                Math.max(64, h.getSize() + (e.key === 'ArrowRight' ? 16 : -16)),
                              ),
                            }));
                          }
                        }}
                      />
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            <tr aria-hidden="true" style={{ height: virtual.getVirtualItems()[0]?.start ?? 0 }}>
              <td colSpan={table.getVisibleLeafColumns().length} />
            </tr>
            {virtual.getVirtualItems().map((item) => {
              const row = model[item.index];
              return (
                <tr key={row.id} aria-rowindex={item.index + 2}>
                  {row.getVisibleCells().map((cell) => {
                    const value = cell.getValue() as SqlCell;
                    return (
                      <td
                        key={cell.id}
                        style={{ width: cell.column.getSize() }}
                        className={
                          typeof value === 'number' ? 'numeric' : value === null ? 'null-value' : ''
                        }
                      >
                        <ContextMenu>
                          <ContextMenuTrigger asChild>
                            <button
                              className="grid-cell"
                              type="button"
                              title={cellText(value)}
                              aria-label={cell.column.id + ': ' + cellText(value)}
                            >
                              {cellText(value)}
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onSelect={() => void copy(cellText(value))}>
                              Copy value
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() =>
                                void copy(
                                  JSON.stringify(
                                    Object.fromEntries(
                                      columns.map((c, i) => [c.name, row.original[i]]),
                                    ),
                                    null,
                                    2,
                                  ),
                                )
                              }
                            >
                              Copy row as JSON
                            </ContextMenuItem>
                            {onFilter && (
                              <ContextMenuItem onSelect={() => onFilter(cell.column.id, value)}>
                                Filter by value
                              </ContextMenuItem>
                            )}
                            {onQuery && (
                              <ContextMenuItem onSelect={onQuery}>Open in SQL</ContextMenuItem>
                            )}
                          </ContextMenuContent>
                        </ContextMenu>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr
              aria-hidden="true"
              style={{
                height: Math.max(
                  0,
                  virtual.getTotalSize() - (virtual.getVirtualItems().at(-1)?.end ?? 0),
                ),
              }}
            >
              <td colSpan={table.getVisibleLeafColumns().length} />
            </tr>
          </tbody>
        </table>
        {!rows.length && (
          <p className="grid-empty">No rows match. Adjust your filters or run another query.</p>
        )}
      </div>
    </div>
  );
}
