import { StatePill } from '@/components/workbench/primitives';
import { useState } from 'react';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export default function QueryHistory({
  scope,
  onOpen,
}: {
  scope: string;
  onOpen: (sql: string) => void;
}) {
  const entries = useSqlWorkspace((s) => s.history);
  const clear = useSqlWorkspace((s) => s.clear);
  const [search, setSearch] = useState('');
  const history = entries.filter(
    (e) => e.scope === scope && e.sql.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="query-history">
      <div className="history-toolbar">
        <label>
          Search history
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a query…"
          />
        </label>
        <Button
          variant="outline"
          disabled={!entries.some((e) => e.scope === scope)}
          onClick={() => clear(scope)}
        >
          Clear history
        </Button>
      </div>
      <p className="hint">
        Up to 500 executions are stored on this device. Query text stays local to your workspace.
      </p>
      <div className="history-list">
        {history.map((e) => (
          <article key={e.id}>
            <div>
              <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString()}</time>
              <StatePill state={e.status} />
              <code>
                {e.elapsed_ms.toLocaleString()} ms · {e.row_count.toLocaleString()} rows
              </code>
              <Button variant="outline" size="sm" onClick={() => onOpen(e.sql)}>
                Reopen in SQL
              </Button>
            </div>
            <pre>{e.sql}</pre>
          </article>
        ))}
      </div>
      {!history.length && (
        <p className="empty-copy">
          {search
            ? 'No queries match your search.'
            : 'Run a query in SQL Workspace to start your history.'}
        </p>
      )}
    </section>
  );
}
