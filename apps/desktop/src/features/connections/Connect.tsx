import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Field } from '@/components/workbench/Field';
import type { Connection } from '@/lib/api';
import { normalizeUrl } from '@/lib/api';
import { Icon } from '@/components/workbench/Icon';
export default function Connect({
  connection,
  connect,
  forget,
  busy,
}: {
  connection: Connection | null;
  connect: (c: Connection) => Promise<void>;
  forget: () => Promise<void>;
  busy: boolean;
}) {
  const [url, setUrl] = useState(connection?.url || 'http://127.0.0.1:8787');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const c = {
        url: normalizeUrl(url),
        token: token.trim() || (connection?.url === normalizeUrl(url) ? connection.token : ''),
      };
      if (!c.token) throw new Error('Enter the engine token.');
      setError('');
      void connect(c);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="card connect-card">
      <div className="icon-tile tone-primary">
        <Icon name="connect" size={24} />
      </div>
      <h2>Connect your engine</h2>
      <p className="hint">Your workspace starts with a connection.</p>
      <form onSubmit={submit}>
        <Field label="Engine URL">
          <Input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Bearer token">
          <Input
            type="password"
            autoComplete="off"
            value={token}
            placeholder={
              connection ? 'Leave blank to keep saved token' : 'Paste from engine data/token'
            }
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <p className="hint">
          Use HTTPS for remote engines. HTTP is allowed only on localhost, 127.0.0.1 or [::1]. The
          connection is stored in your OS keychain.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="actions">
          <Button variant="default" disabled={busy}>
            {busy ? 'Connecting…' : 'Test and save connection'}
          </Button>
          {connection && (
            <Button variant="outline" type="button" disabled={busy} onClick={() => void forget()}>
              Forget connection
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
