import { create } from 'zustand';
import { isRoute, navigateHistory, stepHistory } from './route-history.ts';
import { safeStorage } from './storage.ts';
import type { Route, RouteHistory } from './route-history';
type RouteState = RouteHistory & {
  page: Route;
  navigate: (route: Route) => void;
  back: () => void;
  forward: () => void;
  reset: (route: Route) => void;
};
// The last working page survives a reload or restart, so the engineer lands where they were.
const lastPageKey = 'straton:last-page';
export function lastPage(): Route {
  const page = safeStorage.getItem(lastPageKey);
  return typeof page === 'string' && isRoute(page) && page !== 'Connect' ? page : 'Dashboard';
}
const remember = (page: Route) => {
  if (page !== 'Connect') safeStorage.setItem(lastPageKey, page);
};
export const useRouteStore = create<RouteState>((set) => ({
  entries: ['Connect'],
  index: 0,
  page: 'Connect',
  navigate: (page) => {
    remember(page);
    set((state) => ({ ...navigateHistory(state, page), page }));
  },
  back: () =>
    set((state) => {
      const next = stepHistory(state, -1);
      remember(next.entries[next.index]);
      return { ...next, page: next.entries[next.index] };
    }),
  forward: () =>
    set((state) => {
      const next = stepHistory(state, 1);
      remember(next.entries[next.index]);
      return { ...next, page: next.entries[next.index] };
    }),
  reset: (page) => set({ entries: [page], index: 0, page }),
}));
