import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { clampSidebarWidth, defaultSidebar, parseSidebar } from './sidebar-state';
import type { NavGroup, SidebarPreferences } from './sidebar-state';
import { safeStorage } from './storage';
type Preferences = SidebarPreferences & {
  setWidth: (width: number) => void;
  toggleCollapsed: () => void;
  toggleGroup: (group: NavGroup) => void;
};
// Sidebar pins live in the library as page favorites, so they follow the engine and account.
export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      ...defaultSidebar,
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
      partialize: ({ width, collapsed, expandedGroups }) => ({ width, collapsed, expandedGroups }),
      merge: (persisted, current) => ({ ...current, ...parseSidebar(persisted) }),
    },
  ),
);
