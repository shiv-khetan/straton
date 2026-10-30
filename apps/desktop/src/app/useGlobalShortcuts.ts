import { useEffect, useRef } from 'react';
import type { Me } from '@/lib/api';
import { useRouteStore } from '@/stores/route';
import { itemEntry, navigation } from './navigation';

// App-wide keys: ? for the shortcut list, Mod+K for search, Alt+digit for sections,
// Alt+arrows for history. Registered once; identity is read through a ref.
export function useGlobalShortcuts(
  me: Me | null,
  onShortcuts: () => void,
  onTogglePalette: () => void,
) {
  const latest = useRef({ me, onShortcuts, onTogglePalette });
  latest.current = { me, onShortcuts, onTogglePalette };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest(
        'input, textarea, select, [contenteditable="true"], .monaco-editor',
      );
      if (event.key === '?' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        latest.current.onShortcuts();
      }
      // Alt+1..5 jumps to a section's first page the user can open.
      if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {
        const group = navigation[Number(event.key) - 1];
        const route = group?.items
          .map((item) => itemEntry(latest.current.me, item))
          .find((entry) => entry !== undefined);
        if (route) {
          event.preventDefault();
          useRouteStore.getState().navigate(route);
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        latest.current.onTogglePalette();
      }
      if (
        event.altKey &&
        ['ArrowLeft', 'ArrowRight'].includes(event.key) &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        const routes = useRouteStore.getState();
        if (event.key === 'ArrowLeft') routes.back();
        else routes.forward();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
}
