import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Choice } from '@/components/workbench/FeatureState';
import { Button } from '@/components/workbench/primitives';
import type { Api, Dataset, Relationship } from '@/lib/api';
import { datasetLabel } from '@/lib/view-model';
import { relationshipInput } from './relationship-form';

type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;

export function AddRelationshipDialog({
  open,
  onOpenChange,
  datasets,
  busy,
  canManage,
  client,
  action,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasets: Dataset[];
  busy: boolean;
  canManage: boolean;
  client: Api;
  action: Action;
}) {
  const [sourceDataset, setSourceDataset] = useState('');
  const [sourceColumn, setSourceColumn] = useState('');
  const [targetDataset, setTargetDataset] = useState('');
  const [targetColumn, setTargetColumn] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) setError('');
  }, [open]);
  const datasetOptions = [
    { value: '', label: 'Choose dataset' },
    ...datasets.map((d) => ({ value: d.id, label: datasetLabel(d) })),
  ];
  const columnOptions = (id: string) => [
    { value: '', label: 'Choose column' },
    ...(datasets.find((d) => d.id === id)?.columns ?? []).map((c) => ({
      value: c.name,
      label: c.name,
    })),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add relationship</DialogTitle>
          <DialogDescription>
            Choose the source and target columns for a manual relationship.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            if (!canManage || busy) return;
            void action(async () => {
              try {
                await client.createRelationship(
                  relationshipInput(
                    datasets,
                    sourceDataset,
                    sourceColumn,
                    targetDataset,
                    targetColumn,
                  ),
                );
                onOpenChange(false);
              } catch (reason) {
                setError(String(reason));
                throw reason;
              }
            }, 'Manual relationship created');
          }}
        >
          <Choice
            label="Source dataset"
            value={sourceDataset}
            disabled={busy}
            options={datasetOptions}
            onChange={(value) => {
              setSourceDataset(value);
              setSourceColumn('');
            }}
          />
          <Choice
            label="Source column"
            value={sourceColumn}
            disabled={busy || !sourceDataset}
            options={columnOptions(sourceDataset)}
            onChange={setSourceColumn}
          />
          <Choice
            label="Target dataset"
            value={targetDataset}
            disabled={busy}
            options={datasetOptions}
            onChange={(value) => {
              setTargetDataset(value);
              setTargetColumn('');
            }}
          />
          <Choice
            label="Target column"
            value={targetColumn}
            disabled={busy || !targetDataset}
            options={columnOptions(targetDataset)}
            onChange={setTargetColumn}
          />
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !sourceColumn || !targetColumn}>
              {busy ? 'Adding…' : 'Add relationship'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveRelationshipsDialog({
  removal,
  onRemoval,
  datasets,
  busy,
  canManage,
  client,
  action,
}: {
  removal: Relationship[];
  onRemoval: (update: (pending: Relationship[]) => Relationship[]) => void;
  datasets: Dataset[];
  busy: boolean;
  canManage: boolean;
  client: Api;
  action: Action;
}) {
  const label = (id: string) => datasetLabel(datasets.find((d) => d.id === id));
  return (
    <Dialog
      open={removal.length > 0}
      onOpenChange={(open) => {
        if (!open && !busy) onRemoval(() => []);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete{' '}
            {removal.length === 1
              ? 'manual relationship'
              : removal.length + ' manual relationships'}
            ?
          </DialogTitle>
          <DialogDescription>
            This removes the selected relationships from the Data Map. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-48 overflow-auto text-sm">
          {removal.map((edge) => (
            <li key={edge.id}>
              <code>
                {label(edge.from_dataset)}.{edge.from_cols.join(', ')} → {label(edge.to_dataset)}.
                {edge.to_cols.join(', ')}
              </code>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button autoFocus variant="outline" disabled={busy} onClick={() => onRemoval(() => [])}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !canManage}
            onClick={() =>
              void action(async () => {
                for (const edge of removal) {
                  await client.deleteRelationship(edge.id);
                  onRemoval((pending) => pending.filter((item) => item.id !== edge.id));
                }
              }, 'Manual relationships deleted')
            }
          >
            {busy ? 'Deleting…' : 'Delete relationships'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
