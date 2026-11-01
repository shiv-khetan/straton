import type { SqlTable } from '@/lib/api';
import { explainSqlError } from './sql-error';
import type { SqlExplain, SqlResult } from '@/lib/api';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ResultGrid } from '@/components/workbench/ResultGrid';
import { Skeleton } from '@/features/console/ConsoleDrawer';

export interface Execution {
  result?: SqlResult;
  plans?: SqlExplain;
  error?: string;
}

// Lower pane of the SQL workspace: result grid, explain plans, timing and errors for one tab.
export function SqlOutput({
  tabId,
  output,
  running,
  tab,
  onTab,
  scope,
  tables = [],
}: {
  tabId: string;
  output?: Execution;
  running: { tab: string } | null;
  tab: string;
  onTab: (tab: string) => void;
  scope: string;
  /** Catalog tables, used to suggest the closest table or column name. */
  tables?: SqlTable[];
}) {
  return (
    <Tabs value={tab} onValueChange={onTab} className="sql-output gap-0">
      <div className="results-toolbar">
        <TabsList variant="line" className="tabs result-tabs" aria-label="Output">
          <TabsTrigger className="sql-panel-tab" value="Results">
            Results
          </TabsTrigger>
          <TabsTrigger className="sql-panel-tab" value="Explain">
            Explain
          </TabsTrigger>
        </TabsList>
        <span role="status">
          <code>
            {running?.tab === tabId
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
          {(() => {
            const view = explainSqlError(output.error, tables);
            return (
              <>
                <h3>{view.title}</h3>
                {view.hint && <p>{view.hint}</p>}
                <details>
                  <summary>Engine message</summary>
                  <pre>{view.detail}</pre>
                </details>
              </>
            );
          })()}
        </div>
      )}
      {running?.tab === tabId && <Skeleton label="Executing query…" />}
      <TabsContent value="Results" className="flex min-h-0 flex-col">
        {output?.result && (
          <>
            {output.result.truncated_preview && (
              <p className="truncated-notice" role="status">
                Showing the first 1,000 rows of {output.result.row_count.toLocaleString()}. Use
                Explorer to export a larger result.
              </p>
            )}
            <ResultGrid
              key={tabId}
              columns={output.result.columns}
              rows={output.result.rows}
              scope={scope}
              tableKey={'sql:' + tabId}
            />
          </>
        )}
      </TabsContent>
      <TabsContent value="Explain" className="min-h-0 overflow-auto">
        {output?.plans && (
          <div className="sql-plans">
            <h3>Logical plan</h3>
            <pre>{output.plans.logical}</pre>
            <h3>Physical plan</h3>
            <pre>{output.plans.physical}</pre>
          </div>
        )}
      </TabsContent>
      {!output && !running && (
        <p className="empty-copy">
          Run your SQL to inspect its results, or choose Explain to review the plan.
        </p>
      )}
    </Tabs>
  );
}
