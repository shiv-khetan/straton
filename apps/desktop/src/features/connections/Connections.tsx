import { databaseSslMode } from './source-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Field } from '@/components/workbench/Field';
import type { Action } from '@/components/workbench/Field';
import type { Api, Source, SourceKind } from '@/lib/api';
import { Sheet } from '@/components/workbench/primitives';
import { ManualDatasetSheet } from './ManualDatasetSheet';
import {
  AdvisorToggle,
  ConfigFields,
  DatabaseSsl,
  kindLabels,
  MongoFields,
  numericFields,
  SalesforceFields,
  SecretField,
  sourceKinds,
  SqlServerSecurity,
  StripeObjects,
} from './SourceFormSections';
import type { Config } from './SourceFormSections';
import { SourceTable } from './SourceTable';
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
  const [config, setConfig] = useState<Config>({});
  const [secret, setSecret] = useState('');
  const sslMode = databaseSslMode(kind, config);
  const [manual, setManual] = useState('');
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
  const props = { config, setConfig };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Sources</h1>
          <p className="hint">Connect systems and discover their datasets.</p>
        </div>
      </div>
      <SourceTable
        sources={sources}
        client={client}
        action={action}
        busy={busy}
        onEdit={(source) => {
          setEditing(source.id);
          setName(source.name);
          setKind(source.kind);
          setConfig(source.config);
          setSecret('');
        }}
        onAddDataset={setManual}
      />
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
                  setConfig(
                    e.target.value === 'sqlserver'
                      ? {
                          auth: 'windows',
                          port: 1433,
                          encrypt: true,
                          trust_server_certificate: false,
                        }
                      : {},
                  );
                  setSecret('');
                }}
              >
                {sourceKinds.map((k) => (
                  <option key={k} value={k}>
                    {kindLabels[k] ?? k}
                  </option>
                ))}
              </select>
            </Field>
            {kind === 'sqlserver' && <SqlServerSecurity {...props} setSecret={setSecret} />}
            {['postgres', 'mysql'].includes(kind) && (
              <DatabaseSsl {...props} kind={kind} sslMode={sslMode} />
            )}
            {kind === 'mongodb' && <MongoFields {...props} />}
            {['sqlserver', 'postgres', 'mysql', 'mongodb'].includes(kind) && (
              <AdvisorToggle {...props} />
            )}
            <ConfigFields {...props} kind={kind} />
            {kind === 'stripe' && <StripeObjects {...props} />}
            {(kind === 'postgres' ||
              kind === 'mysql' ||
              kind === 'mongodb' ||
              kind === 'stripe' ||
              (kind === 'sqlserver' && config.auth === 'sql')) && (
              <SecretField
                kind={kind}
                config={config}
                secret={secret}
                setSecret={setSecret}
                hasCredential={!!sources.find((s) => s.id === editing)?.credential_id}
              />
            )}
            {kind === 'salesforce' && (
              <SalesforceFields {...props} setSecret={setSecret} busy={busy} action={action} />
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
        <ManualDatasetSheet
          sourceId={manual}
          sourceName={sources.find((s) => s.id === manual)?.name}
          client={client}
          action={action}
          busy={busy}
          onClose={() => setManual('')}
        />
      )}
    </>
  );
}
