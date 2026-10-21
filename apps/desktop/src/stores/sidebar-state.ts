export const sidebarBounds = { min: 208, max: 336, rail: 56, default: 248 } as const;
export const navGroups = [
  'Workspace',
  'Data',
  'Engineering',
  'Intelligence',
  'Administration',
] as const;
export type NavGroup = (typeof navGroups)[number];
export type SidebarPreferences = {
  width: number;
  collapsed: boolean;
  expandedGroups: Record<NavGroup, boolean>;
};
export const defaultSidebar: SidebarPreferences = {
  width: sidebarBounds.default,
  collapsed: false,
  expandedGroups: {
    Workspace: true,
    Data: true,
    Engineering: true,
    Intelligence: true,
    Administration: true,
  },
};
export function clampSidebarWidth(value: number): number {
  return Math.round(
    Math.max(
      sidebarBounds.min,
      Math.min(sidebarBounds.max, Number.isFinite(value) ? value : sidebarBounds.default),
    ),
  );
}
export function parseSidebar(value: unknown): SidebarPreferences {
  if (typeof value === 'string') {
    try {
      return parseSidebar(JSON.parse(value));
    } catch {
      return { ...defaultSidebar, expandedGroups: { ...defaultSidebar.expandedGroups } };
    }
  }
  const state = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const expanded =
    state.expandedGroups && typeof state.expandedGroups === 'object'
      ? (state.expandedGroups as Record<string, unknown>)
      : {};
  return {
    width: clampSidebarWidth(typeof state.width === 'number' ? state.width : sidebarBounds.default),
    collapsed: state.collapsed === true,
    expandedGroups: Object.fromEntries(
      navGroups.map((group) => [
        group,
        typeof expanded[group] === 'boolean' ? expanded[group] : true,
      ]),
    ) as Record<NavGroup, boolean>,
  };
}
export function navKeyboardIndex(index: number, key: string, length: number): number {
  if (length <= 0) return -1;
  const current = Math.max(0, Math.min(length - 1, index));
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowDown') return (current + 1) % length;
  if (key === 'ArrowUp') return (current - 1 + length) % length;
  return current;
}
