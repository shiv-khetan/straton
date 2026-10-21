import { create } from 'zustand';
import { safeStorage } from './storage';
export type ThemePreference = 'system' | 'light' | 'dark';
const saved = safeStorage.getItem('straton:theme');
export const useThemeStore = create<{
  preference: ThemePreference;
  systemDark: boolean;
  setTheme: (theme: ThemePreference) => void;
  setSystemDark: (dark: boolean) => void;
}>((set) => ({
  preference: saved === 'light' || saved === 'dark' ? saved : 'system',
  systemDark:
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  setTheme: (preference) => {
    if (preference === 'system') safeStorage.removeItem('straton:theme');
    else safeStorage.setItem('straton:theme', preference);
    set({ preference });
  },
  setSystemDark: (systemDark) => set({ systemDark }),
}));
export function useResolvedTheme(): 'light' | 'dark' {
  return useThemeStore((state) =>
    state.preference === 'system' ? (state.systemDark ? 'dark' : 'light') : state.preference,
  );
}
export function applyTheme() {
  const { preference } = useThemeStore.getState();
  if (preference === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
}
