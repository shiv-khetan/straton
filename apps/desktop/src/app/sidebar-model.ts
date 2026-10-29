export type SidebarSection = {
  label: string;
  items: readonly { route: string }[];
};
export type ImportantItems = Record<string, string[]>;

export function orderSections<T extends { label: string }>(
  activeSection: string,
  sections: readonly T[],
): T[] {
  return [
    ...sections.filter((section) => section.label === activeSection),
    ...sections.filter((section) => section.label !== activeSection),
  ];
}

export function defaultImportant(sections: readonly SidebarSection[]): ImportantItems {
  return Object.fromEntries(
    sections.map((section) => [section.label, section.items.slice(0, 2).map((item) => item.route)]),
  );
}

export function visibleItems<T extends { route: string }>(
  section: { label: string; items: readonly T[] },
  important: Readonly<Record<string, readonly string[]>>,
  expanded: boolean,
  active: string,
): T[] {
  return section.items.filter(
    (item) =>
      expanded || section.label === active || important[section.label]?.includes(item.route),
  );
}

export function togglePin(
  important: ImportantItems,
  section: string,
  route: string,
): ImportantItems {
  const pinned = important[section] ?? [];
  return {
    ...important,
    [section]: pinned.includes(route)
      ? pinned.filter((item) => item !== route)
      : [...pinned, route],
  };
}

export function parseImportant(
  value: unknown,
  sections: readonly SidebarSection[],
): ImportantItems {
  if (typeof value === 'string') {
    try {
      return parseImportant(JSON.parse(value), sections);
    } catch {
      return defaultImportant(sections);
    }
  }
  const state = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const defaults = defaultImportant(sections);
  return Object.fromEntries(
    sections.map((section) => {
      const stored = state[section.label];
      return [
        section.label,
        Array.isArray(stored)
          ? section.items.filter((item) => stored.includes(item.route)).map((item) => item.route)
          : defaults[section.label],
      ];
    }),
  );
}
