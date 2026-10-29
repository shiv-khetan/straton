import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { clampSidebarWidth, defaultSidebar, parseSidebar } from './sidebar-state';
import type { NavGroup, SidebarPreferences } from './sidebar-state';
import { safeStorage } from './storage';
import { navigation } from '../app/navigation';
import { defaultImportant, parseImportant, togglePin } from '../app/sidebar-model';
import type { ImportantItems } from '../app/sidebar-model';
import type { Route } from './route-history';
type Preferences = SidebarPreferences & {
  importantItems: ImportantItems;
  togglePin: (group: NavGroup, route: Route) => void;
  setWidth: (width: number) => void;
  toggleCollapsed: () => void;
  toggleGroup: (group: NavGroup) => void;
};
export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      ...defaultSidebar,
      importantItems: defaultImportant(navigation),
      togglePin: (group, route) =>
        set((state) => ({ importantItems: togglePin(state.importantItems, group, route) })),
      setWidth: (width) => set({ width: clampSidebarWidth(width) }),
      toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
      toggleGroup: (group) =>
        set((state) => ({
          expandedGroups: { ...state.expandedGroups, [group]: !state.expandedGroups[group] },
        })),
    }),
    {
      name: 'straton:sidebar:v3',
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ width, collapsed, expandedGroups, importantItems }) => ({
        width,
        collapsed,
        expandedGroups,
        importantItems,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...parseSidebar(persisted),
        importantItems: parseImportant(
          persisted && typeof persisted === 'object' && 'importantItems' in persisted
            ? persisted.importantItems
            : undefined,
          navigation,
        ),
      }),
    },
  ),
);
