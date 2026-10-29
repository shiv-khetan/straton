import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button, Icon, SchemaTree } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import type { DataMap, Dataset, EdgeKind, MapSource } from '@/lib/api';
import { datasetLabel } from '@/lib/view-model';
import { edgeKinds } from './map-model';

// Collapsible left rail on the Data Map: dataset search, source filter, visibility tree and
// relationship-kind toggles. Filter state lives in the canvas, which applies it.
export function CatalogPanel({
  map,
  search,
  onSearch,
  onSearchEnter,
  sourceFilter,
  onSourceFilter,
  excluded,
  onToggleExcluded,
  selectedId,
  onSelect,
  enabledKinds,
  onEnabledKinds,
  canManage,
}: {
  map: DataMap;
  search: string;
  onSearch: (value: string) => void;
  onSearchEnter: () => void;
  sourceFilter: string;
  onSourceFilter: (id: string) => void;
  excluded: string[];
  onToggleExcluded: (id: string) => void;
  selectedId?: string;
  onSelect: (id: string) => void;
  enabledKinds: EdgeKind[];
  onEnabledKinds: (kinds: EdgeKind[]) => void;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = search.trim().toLowerCase();
  const sources = map.nodes.filter((n): n is MapSource => n.type === 'source');
  return (
    <div className="map-library" data-collapsed={!open}>
      <div className="panel-heading">
        {open && <h2>Catalog</h2>}
        <Button
          type="button"
          variant="ghost"
          aria-label={open ? 'Collapse catalog' : 'Expand catalog'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name="collapse" />
        </Button>
      </div>
      {open && (
        <>
          <div className="library-content">
            <Field label="Find dataset">
              <Input
                type="search"
                value={search}
                placeholder="Search datasets…"
                aria-describedby="dataset-search-help"
                onChange={(e) => onSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSearchEnter();
                }}
              />
            </Field>
            <p id="dataset-search-help" className="hint">
              Filters the catalog and highlights canvas matches. Press Enter to select the first
              match.
            </p>
            <Field label="Source">
              <select value={sourceFilter} onChange={(e) => onSourceFilter(e.target.value)}>
                <option value="">All sources</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <SchemaTree
            groups={sources
              .filter((source) => !sourceFilter || source.id === sourceFilter)
              .map((source) => ({
                id: source.id,
                label: source.name,
                items: map.nodes
                  .filter((n): n is Dataset => n.type === 'dataset' && n.source_id === source.id)
                  .filter((d) => datasetLabel(d).toLowerCase().includes(query))
                  .map((d) => ({ id: d.id, label: datasetLabel(d) })),
              }))}
            hidden={excluded}
            onToggle={onToggleExcluded}
            onSelect={onSelect}
            selected={selectedId}
          />
          <fieldset className="edge-filters">
            <legend>Relationships</legend>
            {edgeKinds.map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={enabledKinds.includes(kind)}
                  onChange={(e) =>
                    onEnabledKinds(
                      e.target.checked
                        ? [...enabledKinds, kind]
                        : enabledKinds.filter((k) => k !== kind),
                    )
                  }
                />
                <span className={'edge-sample ' + kind} />
                {kind.replaceAll('_', ' ')}
              </label>
            ))}
          </fieldset>
          {canManage && (
            <p className="hint library-content">
              Drag between column handles to create a manual relationship.
            </p>
          )}
        </>
      )}
    </div>
  );
}
