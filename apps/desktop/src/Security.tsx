import { useEffect, useState } from 'react';
import type { Api, AuditVerification, Dataset, DatasetKey, Status } from './api';
import { Button, Pill, Sheet, Table, Tray } from './ui';
import { Skeleton } from './Workbench';

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
  const [busy, setBusy] = useState(false);
  const [rotation, setRotation] = useState<Rotation | null>(null);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  useEffect(() => {
    let current = true;
    setError('');
    void client.keys().then(
      (value) => {
        if (current) setKeys(value);
      },
      (reason: unknown) => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [client, revision]);
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
      setKeys(await client.keys());
      setNotice('Key rotation completed.');
      onChanged();
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
        <Pill tone={status?.encryption_enabled ? 'success' : 'warning'}>
          {status
            ? status.encryption_enabled
              ? 'Encryption enabled'
              : 'New snapshots are plaintext'
            : 'Loading status…'}
        </Pill>
      }
    >
      <p className="hint">
        Snapshot encryption covers Parquet data. Database metadata and backups remain plaintext.
      </p>
      <div className="toolbar">
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => setRotation({ kind: 'kek' })}
        >
          Rotate KEK
        </Button>
        <Button variant="secondary" disabled={disabled} onClick={() => void verify()}>
          {busy && !rotation ? 'Working…' : 'Verify audit chain'}
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {verification && (
        <p role="status">
          <Pill tone={verification.ok ? 'success' : 'danger'}>
            {verification.ok ? 'Audit chain verified' : 'Audit chain is broken'}
          </Pill>{' '}
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
      {keys === null && !error ? (
        <Skeleton label="Loading encryption keys…" />
      ) : (
        <Table label="Encryption key metadata">
          <thead>
            <tr>
              <th scope="col">Dataset</th>
              <th scope="col">Key ID</th>
              <th scope="col">KEK version</th>
              <th scope="col">Created</th>
              <th scope="col">Retired</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {keys?.map((key) => {
              const dataset = datasets.find((item) => item.id === key.target_id);
              const name = dataset ? dataset.sql_schema + '.' + dataset.sql_table : key.target_id;
              return (
                <tr key={key.id}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td>
                    <code>{key.id}</code>
                  </td>
                  <td>{key.kek_version}</td>
                  <td>{new Date(key.created_at * 1000).toLocaleString()}</td>
                  <td>
                    {key.retired_at === null
                      ? 'Active'
                      : new Date(key.retired_at * 1000).toLocaleString()}
                  </td>
                  <td>
                    {key.retired_at === null && (
                      <Button
                        disabled={disabled}
                        onClick={() =>
                          setRotation({ kind: 'dataset', target: key.target_id, name })
                        }
                      >
                        Rotate dataset key
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
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
          <Button variant="secondary" disabled={busy} onClick={() => setRotation(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={disabled} onClick={() => void rotate()}>
            {busy ? 'Rotating…' : 'Confirm rotation'}
          </Button>
        </div>
      </Sheet>
    </Tray>
  );
}
