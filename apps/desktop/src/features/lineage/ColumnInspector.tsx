import { ArrowRight, Home, X } from 'lucide-react';
import type { ColumnGraph, ColumnRef } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { columnHops, fieldKey } from './column-model';
export type UsageEntity = ColumnGraph['usage'][number]['in'];
export function ColumnInspector({
  focus,
  graph,
  loading,
  error,
  retry,
  onClose,
  onFocus,
  onNavigate,
}: {
  focus: ColumnRef | null;
  graph?: ColumnGraph;
  loading: boolean;
  error: Error | null;
  retry: () => void;
  onClose: () => void;
  onFocus: (dataset_id: string, column: string) => void;
  onNavigate: (entity: UsageEntity) => void;
}) {
  const label = (field: ColumnRef) => {
    const node = graph?.nodes.find((n) => fieldKey(n) === fieldKey(field));
    return (node?.dataset_name ?? field.dataset_id) + '.' + field.column;
  };
  return (
    <aside
      className="map-inspector column-inspector"
      aria-label="Field lineage inspector"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="panel-heading">
        <h2>Field lineage</h2>
        {focus && (
          <Button variant="ghost" size="icon-sm" aria-label="Exit field focus" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="inspector-content">
        {!focus ? (
          <p className="hint">
            Select a field on a table to trace its sources, transformations and uses.
          </p>
        ) : (
          <>
            <div className="field-home">
              <Home size={16} aria-hidden="true" />
              <code>{label(focus)}</code>
              <span className="visually-hidden">Focal field</span>
            </div>
            <p className="hint">
              Arrow keys move between fields. Enter traces a field. Escape exits field focus.
            </p>
            {loading && <p role="status">Tracing field lineage…</p>}
            {error && (
              <div role="alert">
                <p>Field lineage could not be loaded. {error.message}</p>
                <Button variant="outline" onClick={retry}>
                  Try again
                </Button>
              </div>
            )}
            {graph && (
              <>
                {graph.incomplete && (
                  <p className="field-warning" role="status">
                    Lineage is incomplete. Some definitions could not be resolved. Table
                    relationships may contain additional dependencies.
                  </p>
                )}
                <h3>Transformation chain</h3>
                {graph.edges.length === 0 && (
                  <p className="hint">
                    No field transformations were found within your access and the 50-hop limit.
                  </p>
                )}
                <ol className="field-chain">
                  {columnHops(graph).map((index) => {
                    const edge = graph.edges[index];
                    return (
                      <li key={index}>
                        <Button
                          variant="link"
                          className="field-link"
                          onClick={() => onFocus(edge.from.dataset_id, edge.from.column)}
                        >
                          <code>{label(edge.from)}</code>
                        </Button>
                        <div className="field-operation">
                          <ArrowRight size={14} aria-hidden="true" />
                          <span className="field-kind">
                            {edge.kind[0].toUpperCase() + edge.kind.slice(1)}
                          </span>
                        </div>
                        {edge.expression === null ? (
                          <p className="hint">Expression restricted by access policy.</p>
                        ) : (
                          <pre
                            className="field-expression"
                            tabIndex={0}
                            aria-label="Read-only transformation expression"
                          >
                            <code>{edge.expression}</code>
                          </pre>
                        )}
                        <div className="flex flex-wrap items-baseline gap-x-3">
                          <Button
                            variant="link"
                            className="field-link"
                            onClick={() => onFocus(edge.to.dataset_id, edge.to.column)}
                          >
                            <code>{label(edge.to)}</code>
                          </Button>
                          {edge.via.model_id && (
                            <Button
                              variant="link"
                              className="text-caption"
                              onClick={() =>
                                onNavigate({
                                  kind: 'model',
                                  id: edge.via.model_id!,
                                  name: 'Transformation model',
                                })
                              }
                            >
                              Open model
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <h3>Used in</h3>
                {graph.usage.length === 0 && (
                  <p className="hint">No joins, filters or group-bys were found for this path.</p>
                )}
                <ul className="field-usage">
                  {graph.usage.map((use, index) => (
                    <li key={index}>
                      <Button
                        variant="link"
                        className="field-link"
                        onClick={() => {
                          if (use.in.kind === 'view') onClose();
                          onNavigate(use.in);
                        }}
                      >
                        {use.in.name}
                      </Button>
                      <span>
                        {use.in.kind === 'view' ? 'View' : use.in.kind} ·{' '}
                        {use.role.replaceAll('_', ' ')}
                      </span>
                      <code>{label(use)}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
