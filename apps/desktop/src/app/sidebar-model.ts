export function orderSections<T extends { label: string }>(
  activeSection: string,
  sections: readonly T[],
): T[] {
  return [
    ...sections.filter((section) => section.label === activeSection),
    ...sections.filter((section) => section.label !== activeSection),
  ];
}

// Nothing is pinned by default. A pinned item leaves its own section and appears once under
// Favorites, in pin order. The active section is open and first; others open on request.
export function sidebarLayout<L extends string, T extends { route: string }>(
  active: L,
  sections: readonly { label: L; items: readonly T[] }[],
  pinned: readonly string[],
  expanded: readonly L[],
) {
  const all = sections.flatMap((section) => section.items);
  const favorites = [...new Set(pinned)].flatMap((route) =>
    all.filter((item) => item.route === route),
  );
  return {
    favorites,
    sections: orderSections(active, sections).map((section) => ({
      label: section.label,
      items: section.items.filter((item) => !pinned.includes(item.route)),
      open: section.label === active || expanded.includes(section.label),
    })),
  };
}
