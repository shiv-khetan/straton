import { StatePill } from '@/components/workbench/primitives';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Field } from '@/components/workbench/Field';
import type { Action } from '@/components/workbench/Field';
import { invoke } from '@tauri-apps/api/core';
import type { Api, Source, SourceKind } from '@/lib/api';
import { Tray, RowMenu, Sheet, Table as UiTable } from '@/components/workbench/primitives';
const fields: Record<string, string[]> = {
  postgres: ['host', 'port', 'database', 'username', 'batch_size'],
  sqlite: ['path', 'batch_size'],
  csv: ['path', 'batch_size', 'sample_size'],
  stripe: ['account_label', 'rate_limit_rps'],
  salesforce: ['login_url', 'client_id', 'rate_limit_rps'],
  external: [],
};
const numericFields = ['port', 'batch_size', 'sample_size', 'rate_limit_rps'];
const stripeObjects = [
  'customers',
  'charges',
  'payment_intents',
  'invoices',
  'subscriptions',
  'products',
  'prices',
  'refunds',
  'balance_transactions',
];
export default function Sources({
  sources,
  client,
  action,
  busy,
  open,
  onClose,
}: {
  sources: Source[];
  client: Api;
  action: Action;
  busy: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SourceKind>('postgres');
  const [config, setConfig] = useState<Record<string, string | number | string[]>>({});
  const [secret, setSecret] = useState('');
  const [manual, setManual] = useState('');
  const [datasetName, setDatasetName] = useState('');
  const [columns, setColumns] = useState([
    { name: 'id', type: 'Int64', nullable: false, pk: true },
  ]);
  function reset() {
    setEditing(null);
    setName('');
    setKind('postgres');
    setConfig({});
    setSecret('');
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      name,
      kind,
      config: Object.fromEntries(
        Object.entries(config)
          .filter(([, value]) => value !== '')
          .map(([key, value]) => [key, numericFields.includes(key) ? Number(value) : value]),
      ),
      ...(secret ? { secret } : {}),
    };
    void action(
      async () => {
        if (editing) await client.updateSource(editing, body);
        else await client.createSource(body);
        reset();
        onClose();
      },
      editing ? 'Source updated' : 'Source created',
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Sources</h1>
          <p className="hint">Connect systems and discover their datasets.</p>
        </div>
      </div>
      <Tray title="Connected systems">
        <UiTable label="Sources">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Kind</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => (
              <TableRow key={source.id} id={'source:' + source.id} tabIndex={-1}>
                <TableCell>{source.name}</TableCell>
                <TableCell>
                  <code>{source.kind}</code>
                </TableCell>
                <TableCell>
                  <StatePill state={source.kind === 'external' ? 'External' : 'Configured'} />
                </TableCell>
                <TableCell>
                  <div className="actions row-actions">
                    {['postgres', 'sqlite', 'csv', 'stripe', 'salesforce', 'external'].includes(
                      source.kind,
                    ) && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setEditing(source.id);
                            setName(source.name);
                            setKind(source.kind);
                            setConfig(source.config);
                            setSecret('');
                          }}
                        >
                          Edit
                        </Button>
                      </>
                    )}
                    {!['external', 'parquet', 'models'].includes(source.kind) && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void action(
                              () => client.discoverSource(source.id),
                              'Catalog discovered',
                            )
                          }
                        >
                          Discover
                        </Button>
                      </>
                    )}
                    {source.kind === 'external' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => setManual(source.id)}
                      >
                        Add dataset
                      </Button>
                    )}
                    {!['parquet', 'models'].includes(source.kind) && (
                      <RowMenu label={'More actions for ' + source.name}>
                        {!['external', 'parquet', 'models'].includes(source.kind) && (
                          <>
                            {' '}
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void action(
                                  () => client.checkSource(source.id),
                                  'Connection check passed',
                                )
                              }
                            >
                              Check
                            </Button>
                          </>
                        )}
                        {['postgres', 'sqlite', 'csv', 'stripe', 'salesforce', 'external'].includes(
                          source.kind,
                        ) && (
                          <>
                            {' '}
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={async () => {
                                if (await confirmDialog('Delete source “' + source.name + '”?'))
                                  void action(
                                    () => client.deleteSource(source.id),
                                    'Source deleted',
                                  );
                              }}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </RowMenu>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </UiTable>
        {!sources.length && (
          <p className="empty">Add a source, then Discover to populate your Data Map.</p>
        )}
      </Tray>
      <Sheet
        open={open || !!editing}
        title={editing ? 'Edit source' : 'Add source'}
        onClose={() => {
          reset();
          onClose();
        }}
      >
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="Name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Kind">
              <select
                value={kind}
                disabled={!!editing}
                onChange={(e) => {
                  setKind(e.target.value as SourceKind);
                  setConfig({});
                  setSecret('');
                }}
              >
                {['postgres', 'sqlite', 'csv', 'stripe', 'salesforce', 'external'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            {(fields[kind] || []).map((key) => (
              <Field
                key={key}
                label={key === 'path' ? 'Path on engine machine' : key.replaceAll('_', ' ')}
              >
                <Input
                  required={['host', 'database', 'username', 'path'].includes(key)}
                  type={numericFields.includes(key) ? 'number' : 'text'}
                  min="1"
                  max={key === 'rate_limit_rps' ? '1000' : '2147483647'}
                  placeholder={
                    key === 'rate_limit_rps'
                      ? (kind === 'salesforce' ? '10' : '25') + ' (default)'
                      : key === 'login_url'
                        ? 'https://login.salesforce.com (or test.salesforce.com)'
                        : undefined
                  }
                  value={(config[key] as string | number | undefined) ?? ''}
                  onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                />
              </Field>
            ))}
            {kind === 'stripe' && (
              <fieldset className="checklist">
                <legend>Objects to sync</legend>
                {stripeObjects.map((o) => {
                  const chosen = (config.objects as string[] | undefined) ?? stripeObjects;
                  return (
                    <label key={o}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(o)}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            objects: e.target.checked
                              ? stripeObjects.filter((x) => x === o || chosen.includes(x))
                              : chosen.filter((x) => x !== o),
                          })
                        }
                      />
                      <code>{o}</code>
                    </label>
                  );
                })}
              </fieldset>
            )}
            {(kind === 'postgres' || kind === 'stripe') && (
              <Field label={kind === 'stripe' ? 'API key (write-only)' : 'Password (write-only)'}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  aria-describedby={kind === 'stripe' ? 'stripe-key-help' : undefined}
                  placeholder={
                    editing ? 'Leave blank to keep current secret' : 'Stored in engine OS keychain'
                  }
                />
              </Field>
            )}
            {kind === 'stripe' && (
              <p id="stripe-key-help" className="hint">
                Use a restricted key (<code>rk_…</code>) with read-only access to the selected
                objects and to Events.
              </p>
            )}
            {kind === 'salesforce' && (
              <>
                <Field label="Objects (API names, comma-separated)">
                  <Input
                    required
                    placeholder="Account, Contact, Opportunity"
                    value={((config.objects as string[] | undefined) ?? []).join(', ')}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        objects: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
                <div className="actions">
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy || !config.client_id}
                    onClick={() =>
                      void action(async () => {
                        // PKCE sign-in runs in the desktop shell; only the grant comes back here.
                        const grant = await invoke<{ refresh_token: string; instance_url: string }>(
                          'salesforce_authorize',
                          {
                            loginUrl:
                              (config.login_url as string) || 'https://login.salesforce.com',
                            clientId: config.client_id,
                          },
                        );
                        setSecret(grant.refresh_token);
                        setConfig({ ...config, instance_url: grant.instance_url });
                      }, 'Signed in to Salesforce — save the source to keep it')
                    }
                  >
                    {config.instance_url ? 'Sign in again' : 'Sign in with Salesforce'}
                  </Button>
                  {config.instance_url && <code>{config.instance_url as string}</code>}
                </div>
                <p className="hint">
                  Uses your connected app's consumer key with PKCE and the callback{' '}
                  <code>http://localhost:1717/OauthRedirect</code>. The refresh token is stored only
                  in the engine's OS keychain.
                </p>
              </>
            )}
          </div>
          <div className="actions">
            <Button
              variant="default"
              disabled={busy || (kind === 'salesforce' && !config.instance_url)}
            >
              Save source
            </Button>
            {editing && (
              <Button variant="outline" type="button" onClick={reset}>
                Cancel edit
              </Button>
            )}
          </div>
        </form>
      </Sheet>
      {manual && (
        <Sheet
          open={!!manual}
          title={'Add dataset to ' + sources.find((s) => s.id === manual)?.name}
          onClose={() => setManual('')}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await client.createDataset(manual, { name: datasetName, columns });
                setManual('');
                setDatasetName('');
                setColumns([{ name: 'id', type: 'Int64', nullable: false, pk: true }]);
              }, 'Dataset created');
            }}
          >
            <Field label="Dataset name">
              <Input
                required
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
              />
            </Field>
            {columns.map((column, i) => (
              <div className="column-editor" key={i}>
                <Field label="Column name">
                  <Input
                    required
                    value={column.name}
                    onChange={(e) =>
                      setColumns(
                        columns.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)),
                      )
                    }
                  />
                </Field>
                <Field label="Type">
                  <Input
                    required
                    value={column.type}
                    onChange={(e) =>
                      setColumns(
                        columns.map((c, j) => (j === i ? { ...c, type: e.target.value } : c)),
                      )
                    }
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={column.nullable}
                    onChange={(e) =>
                      setColumns(
                        columns.map((c, j) => (j === i ? { ...c, nullable: e.target.checked } : c)),
                      )
                    }
                  />{' '}
                  Nullable
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={column.pk}
                    onChange={(e) =>
                      setColumns(
                        columns.map((c, j) => (j === i ? { ...c, pk: e.target.checked } : c)),
                      )
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
              <Button variant="outline" type="button" onClick={() => setManual('')}>
                Cancel
              </Button>
            </div>
          </form>
        </Sheet>
      )}
    </>
  );
}
