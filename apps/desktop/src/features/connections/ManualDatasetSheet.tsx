import { Checkbox } from '@/components/ui/checkbox';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/workbench/Field';
import type { Action } from '@/components/workbench/Field';
import type { Api } from '@/lib/api';
import { Sheet } from '@/components/workbench/primitives';

const firstColumn = { name: 'id', type: 'Int64', nullable: false, pk: true };

// Declares a dataset and its columns on an external source.
export function ManualDatasetSheet({
  sourceId,
  sourceName,
  client,
  action,
  busy,
  onClose,
}: {
  sourceId: string;
  sourceName?: string;
  client: Api;
  action: Action;
  busy: boolean;
  onClose: () => void;
}) {
  const [datasetName, setDatasetName] = useState('');
  const [columns, setColumns] = useState([firstColumn]);
  return (
    <Sheet open title={'Add dataset to ' + sourceName} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            await client.createDataset(sourceId, { name: datasetName, columns });
            onClose();
            setDatasetName('');
            setColumns([{ name: 'id', type: 'Int64', nullable: false, pk: true }]);
          }, 'Dataset created');
        }}
      >
        <Field label="Dataset name">
          <Input required value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
        </Field>
        {columns.map((column, i) => (
          <div className="column-editor" key={i}>
            <Field label="Column name">
              <Input
                required
                value={column.name}
                onChange={(e) =>
                  setColumns(columns.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)))
                }
              />
            </Field>
            <Field label="Type">
              <Input
                required
                value={column.type}
                onChange={(e) =>
                  setColumns(columns.map((c, j) => (j === i ? { ...c, type: e.target.value } : c)))
                }
              />
            </Field>
            <label>
              <Checkbox
                checked={column.nullable}
                onCheckedChange={(checked) =>
                  setColumns(
                    columns.map((c, j) => (j === i ? { ...c, nullable: checked === true } : c)),
                  )
                }
              />{' '}
              Nullable
            </label>
            <label>
              <Checkbox
                checked={column.pk}
                onCheckedChange={(checked) =>
                  setColumns(columns.map((c, j) => (j === i ? { ...c, pk: checked === true } : c)))
                }
              />{' '}
              PK
            </label>
            <Button
              variant="outline"
              type="button"
              disabled={columns.length === 1}
              onClick={() => setColumns(columns.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="actions">
          <Button
            variant="outline"
            type="button"
            onClick={() =>
              setColumns([...columns, { name: '', type: 'Utf8', nullable: true, pk: false }])
            }
          >
            Add column
          </Button>
          <Button variant="default" disabled={busy}>
            Create dataset
          </Button>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
