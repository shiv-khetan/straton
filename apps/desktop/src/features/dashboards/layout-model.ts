import type { DashboardInput, DashboardTile } from '../../lib/api.ts';
export function packLayout(tiles: DashboardTile[]): DashboardTile[] {
  let x = 0,
    y = 0,
    height = 0;
  return tiles.map((tile) => {
    const w = Math.max(1, Math.min(12, Math.round(tile.w))),
      h = Math.max(1, Math.round(tile.h));
    if (x + w > 12) {
      y += height;
      x = 0;
      height = 0;
    }
    const result = { ...tile, x, y, w, h };
    x += w;
    height = Math.max(height, h);
    return result;
  });
}
export function reorderLayout(tiles: DashboardTile[], id: string, delta: number): DashboardTile[] {
  const next = [...tiles];
  const index = next.findIndex((t) => t.chart_id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= next.length) return tiles;
  [next[index], next[target]] = [next[target], next[index]];
  return packLayout(next);
}

export function addDashboardChart(draft: DashboardInput, chartId: string): DashboardInput {
  if (draft.layout.some((tile) => tile.chart_id === chartId)) return draft;
  return {
    ...draft,
    layout: packLayout([...draft.layout, { chart_id: chartId, x: 0, y: 0, w: 6, h: 4 }]),
  };
}
