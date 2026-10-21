import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeStorage } from './storage';
import { addHistory, closeTab, updateTab } from '../features/sql/workspace-model.ts';
import type { SqlTab, HistoryEntry } from '../features/sql/workspace-model.ts';
interface State {
  tabs: SqlTab[];
  active: string;
  history: HistoryEntry[];
  add: (sql?: string, name?: string, savedId?: string) => void;
  select: (id: string) => void;
  update: (id: string, patch: Partial<Omit<SqlTab, 'id'>>) => void;
  close: (id: string) => void;
  record: (entry: HistoryEntry) => void;
  clear: (scope: string) => void;
}
export const useSqlWorkspace = create<State>()(
  persist(
    (set) => ({
      tabs: [],
      active: '',
      history: [],
      add: (sql = 'SELECT 1;', name = 'Untitled query', savedId) =>
        set((s) => {
          const id = crypto.randomUUID();
          return { tabs: [...s.tabs, { id, name, sql, dirty: false, savedId }], active: id };
        }),
      select: (active) => set({ active }),
      update: (id, patch) => set((s) => ({ tabs: updateTab(s.tabs, id, patch) })),
      close: (id) => set((s) => closeTab(s.tabs, s.active, id)),
      record: (entry) => set((s) => ({ history: addHistory(s.history, entry) })),
      clear: (scope) => set((s) => ({ history: s.history.filter((e) => e.scope !== scope) })),
    }),
    {
      name: 'straton:sql:v3',
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ tabs, active, history }) => ({ tabs, active, history }),
      merge: (persisted, current) => {
        const p = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<State>;
        const tabs = Array.isArray(p.tabs)
          ? p.tabs
              .filter(
                (t) =>
                  t &&
                  typeof t.id === 'string' &&
                  typeof t.name === 'string' &&
                  typeof t.sql === 'string' &&
                  typeof t.dirty === 'boolean',
              )
              .slice(-100)
          : [];
        const history = Array.isArray(p.history)
          ? p.history
              .filter(
                (e) =>
                  e &&
                  typeof e.id === 'string' &&
                  typeof e.scope === 'string' &&
                  typeof e.sql === 'string' &&
                  Number.isFinite(e.at) &&
                  Number.isFinite(e.elapsed_ms) &&
                  Number.isFinite(e.row_count) &&
                  ['succeeded', 'failed', 'cancelled'].includes(e.status),
              )
              .slice(0, 500)
          : [];
        return {
          ...current,
          tabs,
          active: tabs.some((t) => t.id === p.active) ? p.active! : (tabs[0]?.id ?? ''),
          history,
        };
      },
    },
  ),
);
