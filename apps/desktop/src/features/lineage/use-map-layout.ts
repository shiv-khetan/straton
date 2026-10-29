import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { DataMap } from '@/lib/api';
import { buildEdges, layout, loadPositions, persist, restorePositions } from './map-model';
import type { MapEdge, MapNode } from './map-model';

const keepSelection = <T extends { id: string; selected?: boolean }>(next: T[], previous: T[]) =>
  next.map((item) => ({
    ...item,
    selected: previous.find((existing) => existing.id === item.id)?.selected ?? false,
  }));

// ELK layout for the catalog. Saved positions win on load; Re-layout replaces and saves them.
// A generation counter drops results from layouts superseded by a newer catalog.
export function useMapLayout(
  map: DataMap,
  engineUrl: string,
  setNodes: Dispatch<SetStateAction<MapNode[]>>,
  setEdges: Dispatch<SetStateAction<MapEdge[]>>,
) {
  const { fitView } = useReactFlow<MapNode, MapEdge>();
  const [layoutError, setLayoutError] = useState('');
  const [layingOut, setLayingOut] = useState(false);
  const generation = useRef(0);
  const arrange = useCallback(
    async (restore: boolean) => {
      const current = ++generation.current;
      setLayingOut(true);
      setLayoutError('');
      try {
        const next = await layout(map);
        if (generation.current !== current) return;
        const positioned = restore
          ? restorePositions(next.nodes, loadPositions(engineUrl))
          : next.nodes;
        setNodes((previous) => keepSelection(positioned, previous));
        setEdges((previous) => keepSelection(next.edges, previous));
        if (!restore) persist(engineUrl, positioned);
        requestAnimationFrame(() => {
          void fitView({ padding: 0.15 });
        });
      } catch {
        if (generation.current === current)
          setLayoutError('Layout failed. Try Re-layout or refresh the catalog.');
      } finally {
        if (generation.current === current) setLayingOut(false);
      }
    },
    [map, engineUrl, setNodes, setEdges, fitView],
  );
  useEffect(() => {
    void arrange(true);
    return () => {
      generation.current++;
    };
  }, [arrange]);
  useEffect(() => {
    setEdges((previous) => keepSelection(buildEdges(map), previous));
  }, [map, setEdges]);
  return { arrange, layingOut, layoutError };
}
