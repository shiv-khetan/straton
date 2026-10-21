import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeStorage } from './storage.ts';
import { isRoute } from './route-history.ts';
import type { Route } from './route-history';
export type LibraryEntry = {
  id: string;
  label: string;
  kind: 'page' | 'dataset' | 'model' | 'source';
  route: Route;
  entityId?: string;
  detail?: string;
  scope: string;
  visitedAt: number;
};
type LibraryState = {
  favorites: LibraryEntry[];
  recent: LibraryEntry[];
  visit: (entry: LibraryEntry) => void;
  toggle: (entry: LibraryEntry) => void;
};
export function parseEntries(value: unknown): LibraryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is LibraryEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        typeof entry.label === 'string' &&
        typeof entry.scope === 'string' &&
        isRoute(entry.route) &&
        ['page', 'dataset', 'model', 'source'].includes(entry.kind) &&
        (entry.kind === 'page' ||
          (typeof entry.entityId === 'string' &&
            entry.entityId.length > 0 &&
            entry.route ===
              (
                { dataset: 'Data Map', model: 'Models', source: 'Sources' } as Record<string, Route>
              )[entry.kind])) &&
        Number.isFinite(entry.visitedAt) &&
        (entry.entityId === undefined || typeof entry.entityId === 'string') &&
        (entry.detail === undefined || typeof entry.detail === 'string'),
    )
    .slice(0, 100);
}
export const useLibrary = create<LibraryState>()(
  persist(
    (set) => ({
      favorites: [],
      recent: [],
      visit: (entry) =>
        set((state) => ({
          recent: [
            entry,
            ...state.recent.filter((item) => item.scope !== entry.scope || item.id !== entry.id),
          ].slice(0, 100),
        })),
      toggle: (entry) =>
        set((state) => ({
          favorites: state.favorites.some(
            (item) => item.scope === entry.scope && item.id === entry.id,
          )
            ? state.favorites.filter((item) => item.scope !== entry.scope || item.id !== entry.id)
            : [...state.favorites, entry].slice(-100),
        })),
    }),
    {
      name: 'straton:library:v3',
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ favorites, recent }) => ({ favorites, recent }),
      merge: (persisted, current) => {
        const saved =
          persisted && typeof persisted === 'object' ? (persisted as Record<string, unknown>) : {};
        return {
          ...current,
          favorites: parseEntries(saved.favorites),
          recent: parseEntries(saved.recent),
        };
      },
    },
  ),
);
