// Every section stays open in its fixed category order. Nothing is pinned by default; a pinned
// item leaves its own section and appears once under Favorites, in pin order.
export function sidebarLayout<L extends string, T extends { route: string }>(
  sections: readonly { label: L; items: readonly T[] }[],
  pinned: readonly string[],
) {
  const all = sections.flatMap((section) => section.items);
  return {
    favorites: [...new Set(pinned)].flatMap((route) => all.filter((item) => item.route === route)),
    sections: sections.map((section) => ({
      label: section.label,
      items: section.items.filter((item) => !pinned.includes(item.route)),
    })),
  };
}
