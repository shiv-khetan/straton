import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Me, Model } from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  Pill,
  StatePill,
  Table,
} from '@/components/workbench/primitives';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { relativeTime } from '@/lib/view-model';
import { modelStatus } from './model-model';

// The List view of SQL models with per-row inspect, edit and run actions.
export function ModelList({
  models,
  loading,
  me,
  readOnly,
  busy,
  onEdit,
  onInspect,
  onRun,
}: {
  models: Model[];
  loading: boolean;
  me: Me;
  readOnly: boolean;
  busy: boolean;
  onEdit: (model: Model | null) => void;
  onInspect: (model: Model) => void;
  onRun: (model: Model) => void;
}) {
  return (
    <Card className="model-list table-surface" aria-busy={loading}>
      {loading ? (
        <Skeleton label="Loading models…" />
      ) : models.length ? (
        <Table label="SQL models">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Materialization</TableHead>
              <TableHead scope="col">Trigger</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Last run</TableHead>
              <TableHead scope="col">Rows</TableHead>
              <TableHead scope="col">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((m) => {
              const status = modelStatus(m.status, m.last_run_status);
              const canEdit = !readOnly && (me.privileges.admin || m.owner_id === me.user.id);
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    <Button
                      variant="ghost"
                      className="model-name"
                      disabled={busy}
                      onClick={() => onEdit(m)}
                    >
                      <code>models.{m.name}</code>
                    </Button>
                    {m.error && <small className="error">{m.error}</small>}
                  </TableCell>
                  <TableCell>
                    <Pill>{m.materialization}</Pill>
                  </TableCell>
                  <TableCell>{m.trigger}</TableCell>
                  <TableCell>
                    <StatePill state={status.label} label={status.label} />
                  </TableCell>
                  <TableCell>{m.last_run ? relativeTime(m.last_run * 1000) : 'Never'}</TableCell>
                  <TableCell>
                    {m.materialization === 'view'
                      ? 'On query'
                      : (m.row_count?.toLocaleString() ?? '—')}
                  </TableCell>
                  <TableCell>
                    <div className="actions">
                      <Button type="button" variant="ghost" onClick={() => onInspect(m)}>
                        Inspect model
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onEdit(m)}
                      >
                        {canEdit ? 'Edit / Explain' : 'Lineage'}
                      </Button>
                      {canEdit && m.materialization === 'table' && (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy || m.status === 'broken'}
                          onClick={() => onRun(m)}
                        >
                          Run now
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          action={
            <Button type="button" variant="default" onClick={() => onEdit(null)}>
              New model
            </Button>
          }
        >
          Create a model from a synced dataset. Table models publish snapshots; views run when
          queried.
        </EmptyState>
      )}
    </Card>
  );
}
