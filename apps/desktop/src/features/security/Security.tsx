import { StatePill } from '@/components/workbench/primitives';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { useEffect, useState } from 'react';
import type { Api, AuditVerification, Dataset, DatasetKey, Status } from '@/lib/api';
import { Button, Sheet, Table, Tray } from '@/components/workbench/primitives';
import { Skeleton } from '@/features/console/ConsoleDrawer';

type Rotation = { kind: 'kek' } | { kind: 'dataset'; target: string; name: string };

export default function Security({
  client,
  status,
  datasets,
  readOnly,
  revision,
  onChanged,
}: {
  client: Api;
  status: Status | null;
  datasets: Dataset[];
  readOnly: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const [keys, setKeys] = useState<DatasetKey[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [keyError, setKeyError] = useState('');
  const [keyRevision, setKeyRevision] = useState(0);
  const [rotated, setRotated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rotation, setRotation] = useState<Rotation | null>(null);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  useEffect(() => {
    let current = true;
    setKeyError('');
    void client.keys().then(
      (value) => {
        if (current) setKeys(value);
      },
      (reason: unknown) => {
        if (current) setKeyError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [client, revision, keyRevision]);
  const disabled = readOnly || busy;
  async function rotate() {
    if (!rotation || disabled) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (rotation.kind === 'kek') await client.rotateKek();
      else await client.rotateDatasetKey(rotation.target);
      setRotation(null);
      setRotated(true);
      setNotice('Key rotation completed.');
      onChanged();
      setKeyRevision((r) => r + 1);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    if (disabled) return;
    setBusy(true);
    setError('');
    setVerification(null);
    try {
      setVerification(await client.verifyAudit());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Tray
      title="Security"
      actions={
        <StatePill
          state={status ? (status.encryption_enabled ? 'enabled' : 'warning') : 'pending'}
          label={
            status
              ? status.encryption_enabled
                ? 'Encryption enabled'
                : 'New snapshots are plaintext'
              : 'Loading status…'
          }
        />
      }
    >
      <p className="hint">
        Snapshot encryption covers Parquet data. Database metadata and backups remain plaintext.
      </p>
      {status && !status.encryption_enabled && (
        <p className="hint">
          To encrypt new snapshots, set <code>[encryption] enabled = true</code> (or{' '}
          <code>STRATON_ENCRYPTION_ENABLED=true</code>) and restart the engine. On Linux also set{' '}
          <code>STRATON_SECRETS_DIR</code> so the key survives a reboot.
        </p>
      )}
      <div className="toolbar">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => setRotation({ kind: 'kek' })}
        >
          Rotate KEK
        </Button>
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => void verify()}>
          {busy && !rotation ? 'Working…' : 'Verify audit chain'}
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {keyError && (
        <div role="alert">
          <p>
            {rotated
              ? 'Key rotation completed. Key metadata could not refresh.'
              : 'Could not load key metadata.'}{' '}
            {keyError}
          </p>
          <Button variant="outline" disabled={busy} onClick={() => setKeyRevision((r) => r + 1)}>
            Retry
          </Button>
        </div>
      )}
      {verification && (
        <p role="status">
          <StatePill
            state={verification.ok ? 'healthy' : 'error'}
            label={verification.ok ? 'Audit chain verified' : 'Audit chain is broken'}
          />{' '}
          {verification.rows} audit rows.
          {verification.first_bad_id !== null && (
            <>
              {' '}
              First invalid row: <code>{verification.first_bad_id}</code>.
            </>
          )}
        </p>
      )}
      {status?.audit_head && (
        <p className="hint">
          Audit head: <code className="security-hash">{status.audit_head}</code>
        </p>
      )}
      {keys === null && !keyError ? (
        <Skeleton label="Loading encryption keys…" />
      ) : (
        <Table label="Encryption key metadata">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Dataset</TableHead>
              <TableHead scope="col">Key ID</TableHead>
              <TableHead scope="col">KEK version</TableHead>
              <TableHead scope="col">Created</TableHead>
              <TableHead scope="col">Retired</TableHead>
              <TableHead scope="col">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys?.map((key) => {
              const dataset = datasets.find((item) => item.id === key.target_id);
              const name = dataset ? dataset.sql_schema + '.' + dataset.sql_table : key.target_id;
              return (
                <TableRow key={key.id}>
                  <TableCell>
                    <code>{name}</code>
                  </TableCell>
                  <TableCell>
                    <code>{key.id}</code>
                  </TableCell>
                  <TableCell>{key.kek_version}</TableCell>
                  <TableCell>{new Date(key.created_at * 1000).toLocaleString()}</TableCell>
                  <TableCell>
                    {key.retired_at === null
                      ? 'Active'
                      : new Date(key.retired_at * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {key.retired_at === null && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() =>
                          setRotation({ kind: 'dataset', target: key.target_id, name })
                        }
                      >
                        Rotate dataset key
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {keys?.length === 0 && (
        <p className="empty">
          No encrypted snapshots yet. Keys appear after the first encrypted sync or model run.
        </p>
      )}
      <Sheet
        open={rotation !== null}
        title={rotation?.kind === 'dataset' ? 'Rotate dataset key' : 'Rotate KEK'}
        onClose={() => {
          if (!busy) setRotation(null);
        }}
      >
        <p>
          {rotation?.kind === 'dataset'
            ? 'Retire the active key for ' +
              rotation.name +
              '? The next run will use a new key. Existing snapshots keep their current key until cleanup. Finish active runs first.'
            : 'Re-wrap all dataset keys with a new keychain KEK? Existing snapshots remain readable. Older database backups may require their previous keychain backup.'}
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="sheet-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => setRotation(null)}
          >
            Cancel
          </Button>
          <Button type="button" variant="default" disabled={disabled} onClick={() => void rotate()}>
            {busy ? 'Rotating…' : 'Confirm rotation'}
          </Button>
        </div>
      </Sheet>
    </Tray>
  );
}
