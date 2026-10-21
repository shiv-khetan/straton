import { create } from 'zustand';
import { navigateHistory, stepHistory } from './route-history.ts';
import type { Route, RouteHistory } from './route-history';
type RouteState = RouteHistory & {
  page: Route;
  navigate: (route: Route) => void;
  back: () => void;
  forward: () => void;
  reset: (route: Route) => void;
};
export const useRouteStore = create<RouteState>((set) => ({
  entries: ['Connect'],
  index: 0,
  page: 'Connect',
  navigate: (page) => set((state) => ({ ...navigateHistory(state, page), page })),
  back: () =>
    set((state) => {
      const next = stepHistory(state, -1);
      return { ...next, page: next.entries[next.index] };
    }),
  forward: () =>
    set((state) => {
      const next = stepHistory(state, 1);
      return { ...next, page: next.entries[next.index] };
    }),
  reset: (page) => set({ entries: [page], index: 0, page }),
}));
