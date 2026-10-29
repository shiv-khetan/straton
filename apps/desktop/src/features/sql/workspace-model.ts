export interface SqlTab {
  id: string;
  name: string;
  sql: string;
  dirty: boolean;
  savedId?: string;
}
export interface HistoryEntry {
  id: string;
  scope: string;
  sql: string;
  at: number;
  elapsed_ms: number;
  row_count: number;
  status: 'succeeded' | 'failed' | 'cancelled';
}
export function updateTab(tabs: SqlTab[], id: string, patch: Partial<Omit<SqlTab, 'id'>>) {
  return tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
}
export function closeTab(tabs: SqlTab[], active: string, id: string) {
  const next = tabs.filter((t) => t.id !== id);
  return {
    tabs: next,
    active:
      active === id
        ? (next[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]?.id ?? '')
        : active,
  };
}
export function addHistory(entries: HistoryEntry[], entry: HistoryEntry) {
  return [entry, ...entries.filter((e) => e.id !== entry.id)].slice(0, 500);
}
export const shortcuts = [
  ['Ctrl+Enter', 'Run'],
  ['Ctrl+Shift+Enter', 'Run selection'],
  ['Esc', 'Cancel'],
  ['Ctrl+S', 'Save'],
  ['Ctrl+Shift+F', 'Format'],
  ['Ctrl+T', 'New tab'],
  ['Ctrl+W', 'Close tab'],
] as const;
export function shortcutAction(e: {
  key: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}) {
  if (e.altKey) return null;
  if (e.key === 'Escape') return 'Cancel';
  if (!e.ctrlKey && !e.metaKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'enter') return e.shiftKey ? 'Run selection' : 'Run';
  if (k === 'f' && e.shiftKey) return 'Format';
  if (!e.shiftKey)
    return ({ s: 'Save', t: 'New tab', w: 'Close tab' } as Record<string, string>)[k] ?? null;
  return null;
}

// Copy the target before the request so tab switches and edits cannot retarget a save.
export function snapshotSaveTarget(tabs: SqlTab[], id: string | null) {
  const tab = tabs.find((tab) => tab.id === id);
  return tab ? { ...tab } : undefined;
}
export function completeQuerySave(
  tabs: SqlTab[],
  submitted: SqlTab,
  saved: { id: string; name: string },
) {
  return tabs.map((tab) =>
    tab.id === submitted.id
      ? { ...tab, name: saved.name, savedId: saved.id, dirty: tab.sql !== submitted.sql }
      : tab,
  );
}
export function workspaceShortcutAllowed({
  withinWorkspace,
  inOverlay,
  ordinaryField,
}: {
  withinWorkspace: boolean;
  inOverlay: boolean;
  ordinaryField: boolean;
}) {
  return withinWorkspace && !inOverlay && !ordinaryField;
}
