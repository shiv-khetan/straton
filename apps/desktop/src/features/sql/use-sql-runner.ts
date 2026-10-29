import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { toast } from 'sonner';
import type { Api } from '@/lib/api';
import { useSqlWorkspace } from '@/stores/sql-workspace';
import type { monaco } from './monaco';
import type { Execution } from './SqlOutput';

// Runs, explains and cancels the active tab's SQL (or the editor selection), one at a time.
// Outputs are kept per tab; history records every query run, not explains.
export function useSqlRunner(
  client: Api,
  readOnly: boolean,
  scope: string,
  editor: RefObject<monaco.editor.IStandaloneCodeEditor | null>,
) {
  const [outputs, setOutputs] = useState<Record<string, Execution>>({});
  const [running, setRunning] = useState<{ id: string; tab: string; explain: boolean } | null>(
    null,
  );
  const runningRef = useRef<typeof running>(null);
  const [resultTab, setResultTab] = useState('Results');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    [client, readOnly, scope, editor],
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
  return { outputs, running, runningRef, resultTab, setResultTab, run, cancel };
}
