import { invoke } from '@tauri-apps/api/core';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/workbench/Field';
import type { Action } from '@/components/workbench/Field';
import type { SourceKind } from '@/lib/api';
import { mongoTlsDefault } from './source-model';

export type Config = Record<string, string | number | boolean | string[]>;

// Kinds that can be created and edited from the source form.
export const sourceKinds: SourceKind[] = [
  'postgres',
  'sqlserver',
  'mysql',
  'mongodb',
  'sqlite',
  'csv',
  'stripe',
  'salesforce',
  'external',
];
export const kindLabels: Record<string, string> = {
  sqlserver: 'SQL Server',
  mysql: 'MySQL / MariaDB',
  mongodb: 'MongoDB',
  postgres: 'Postgres / Neon',
};
const fields: Record<string, string[]> = {
  postgres: ['host', 'port', 'database', 'username', 'ca_cert_path', 'options', 'batch_size'],
  mysql: ['host', 'port', 'database', 'username', 'batch_size'],
  mongodb: ['database', 'username', 'auth_source', 'replica_set', 'sample_size', 'batch_size'],
  sqlserver: ['host', 'port', 'instance', 'database', 'username', 'batch_size'],
  sqlite: ['path', 'batch_size'],
  csv: ['path', 'batch_size', 'sample_size'],
  stripe: ['account_label', 'rate_limit_rps'],
  salesforce: ['login_url', 'client_id', 'rate_limit_rps'],
  external: [],
};
export const numericFields = ['port', 'batch_size', 'sample_size', 'rate_limit_rps'];
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

// Windows or SQL login, plus the encrypt and trust-certificate switches.
export function SqlServerSecurity({
  config,
  setConfig,
  setSecret,
}: {
  config: Config;
  setConfig: (config: Config) => void;
  setSecret: (secret: string) => void;
}) {
  return (
    <>
      <Field label="Authentication">
        <select
          value={(config.auth as string | undefined) ?? 'windows'}
          onChange={(e) => {
            const next: typeof config = { ...config, auth: e.target.value };
            if (e.target.value === 'windows') delete next.username;
            setConfig(next);
            setSecret('');
          }}
        >
          <option value="windows">Windows integrated</option>
          <option value="sql">SQL login</option>
        </select>
      </Field>
      {config.auth !== 'sql' && (
        <p className="hint">Connects as the Windows account running the engine.</p>
      )}
      <fieldset className="checklist">
        <legend>Connection security</legend>
        <label>
          <input
            type="checkbox"
            checked={config.encrypt !== false}
            onChange={(e) => setConfig({ ...config, encrypt: e.target.checked })}
          />
          Encrypt connection
        </label>
        <label>
          <input
            type="checkbox"
            checked={config.trust_server_certificate === true}
            aria-describedby="sqlserver-trust-help"
            onChange={(e) => setConfig({ ...config, trust_server_certificate: e.target.checked })}
          />
          Trust server certificate
        </label>
        <p id="sqlserver-trust-help" className="hint">
          Trusting the server certificate skips certificate and hostname validation. Enable only
          when you have verified the server on a trusted network.
        </p>
        {config.encrypt === false && (
          <p role="status" className="message">
            Encryption is disabled. Data may travel unencrypted.
          </p>
        )}
        {config.trust_server_certificate === true && (
          <p role="status" className="message">
            Certificate validation is disabled. The server's identity will not be verified.
          </p>
        )}
      </fieldset>
    </>
  );
}

// Postgres and MySQL TLS mode, with a warning for modes that can send plaintext.
export function DatabaseSsl({
  kind,
  config,
  setConfig,
  sslMode,
}: {
  kind: SourceKind;
  config: Config;
  setConfig: (config: Config) => void;
  sslMode: string;
}) {
  return (
    <fieldset className="checklist">
      <legend>Connection security</legend>
      <Field label="SSL mode">
        <select
          aria-describedby="database-ssl-help"
          value={sslMode}
          onChange={(e) =>
            setConfig({
              ...config,
              [kind === 'postgres' ? 'sslmode' : 'ssl_mode']: e.target.value,
            })
          }
        >
          {(kind === 'postgres'
            ? ['disable', 'prefer', 'require', 'verify-full']
            : ['disabled', 'preferred', 'required', 'verify_identity']
          ).map((mode) => (
            <option key={mode} value={mode}>
              {mode.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </Field>
      <p id="database-ssl-help" className="hint">
        Remote hosts require encryption by default. Use{' '}
        {kind === 'postgres' ? 'verify-full' : 'verify identity'} to verify the certificate and
        hostname. Preferred mode can fall back to an unencrypted connection.
      </p>
      {['disable', 'disabled', 'prefer', 'preferred'].includes(sslMode) && (
        <p role="status" className="message">
          This mode allows data to travel unencrypted.
        </p>
      )}
      {['require', 'required'].includes(sslMode) && (
        <p role="status" className="message">
          Encryption is required; the server's identity is not verified.
        </p>
      )}
    </fieldset>
  );
}

// MongoDB host list or SRV address and TLS.
export function MongoFields({
  config,
  setConfig,
}: {
  config: Config;
  setConfig: (config: Config) => void;
}) {
  return (
    <>
      <Field label="Hosts (comma-separated) or mongodb+srv host">
        <Input
          required
          placeholder="localhost:27017 or mongodb+srv://cluster.example.net"
          value={
            (config.host as string | undefined) ??
            (config.hosts as string[] | undefined)?.join(', ') ??
            ''
          }
          onChange={(e) => {
            const next = { ...config };
            delete next.host;
            delete next.hosts;
            if (e.target.value.startsWith('mongodb+srv://')) next.host = e.target.value;
            else next.hosts = e.target.value.split(',').map((h) => h.trim());
            setConfig(next);
          }}
        />
      </Field>
      <fieldset className="checklist">
        <legend>Connection security</legend>
        <label>
          <input
            type="checkbox"
            checked={(config.tls as boolean | undefined) ?? mongoTlsDefault(config)}
            onChange={(e) => setConfig({ ...config, tls: e.target.checked })}
            aria-describedby="mongo-tls-help"
          />
          Encrypt connection (TLS)
        </label>
        <p id="mongo-tls-help" className="hint">
          TLS verifies the server certificate and hostname. It is enabled by default for remote
          hosts. Enter hosts only; passwords are stored in the engine OS keychain.
        </p>
        {(config.tls ?? mongoTlsDefault(config)) === false && (
          <p role="status" className="message">
            Encryption is disabled. Data may travel unencrypted.
          </p>
        )}
      </fieldset>
      <p className="hint">
        Schema inference samples up to 1,000 documents by default. Explorer shows field coverage;
        inferred relationships are suggestions. ObjectId watermarks track inserts by creation time;
        use an updated timestamp to track edits.
      </p>
    </>
  );
}

// Opt-in for the advisor to apply approved recommendations to the source database.
export function AdvisorToggle({
  config,
  setConfig,
}: {
  config: Config;
  setConfig: (config: Config) => void;
}) {
  return (
    <fieldset className="checklist">
      <legend>Source advisor</legend>
      <label>
        <input
          type="checkbox"
          checked={config.advisor_may_write === true}
          aria-describedby="advisor-write-warning"
          onChange={(e) => setConfig({ ...config, advisor_may_write: e.target.checked })}
        />
        Advisor may write
      </label>
      <p id="advisor-write-warning" className="hint">
        Allows an admin to execute each approved recommendation on this source database using its
        saved credentials. Index builds can block writes and consume disk and log space. Every apply
        is audited and includes a rollback command. Nothing runs automatically.
      </p>
    </fieldset>
  );
}

// Plain per-kind connection settings (host, port, path, batch size…).
export function ConfigFields({
  kind,
  config,
  setConfig,
}: {
  kind: SourceKind;
  config: Config;
  setConfig: (config: Config) => void;
}) {
  return (
    <>
      {(fields[kind] || [])
        .filter((key) => !(kind === 'sqlserver' && key === 'username' && config.auth !== 'sql'))
        .map((key) => (
          <Field
            key={key}
            label={
              key === 'ca_cert_path'
                ? 'CA certificate path on engine machine (optional)'
                : key === 'options'
                  ? 'Neon endpoint option (optional)'
                  : key === 'path'
                    ? 'Path on engine machine'
                    : key[0].toUpperCase() + key.slice(1).replaceAll('_', ' ')
            }
          >
            <Input
              required={
                ['host', 'database', 'path'].includes(key) ||
                (key === 'username' && kind !== 'mongodb')
              }
              type={numericFields.includes(key) ? 'number' : 'text'}
              min="1"
              max={key === 'port' ? '65535' : key === 'rate_limit_rps' ? '1000' : '2147483647'}
              placeholder={
                key === 'options'
                  ? 'endpoint=ep-example'
                  : key === 'port' && ['mysql', 'postgres', 'sqlserver'].includes(kind)
                    ? (
                        { mysql: '3306', postgres: '5432', sqlserver: '1433' } as Record<
                          string,
                          string
                        >
                      )[kind] + ' (default)'
                    : key === 'rate_limit_rps'
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
    </>
  );
}

// Which Stripe objects to sync; all by default.
export function StripeObjects({
  config,
  setConfig,
}: {
  config: Config;
  setConfig: (config: Config) => void;
}) {
  return (
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
  );
}

// Write-only password or API key; blank keeps the stored credential when editing.
export function SecretField({
  kind,
  config,
  secret,
  setSecret,
  hasCredential,
}: {
  kind: SourceKind;
  config: Config;
  secret: string;
  setSecret: (secret: string) => void;
  hasCredential: boolean;
}) {
  return (
    <>
      <Field label={kind === 'stripe' ? 'API key (write-only)' : 'Password (write-only)'}>
        <Input
          type="password"
          required={
            (kind === 'sqlserver' ||
              kind === 'mysql' ||
              (kind === 'mongodb' && Boolean(config.username))) &&
            !hasCredential
          }
          autoComplete="new-password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          aria-describedby={kind === 'stripe' ? 'stripe-key-help' : undefined}
          placeholder={
            hasCredential ? 'Leave blank to keep current secret' : 'Stored in engine OS keychain'
          }
        />
      </Field>
      {kind === 'stripe' && (
        <p id="stripe-key-help" className="hint">
          Use a restricted key (<code>rk_…</code>) with read-only access to the selected objects and
          to Events.
        </p>
      )}
    </>
  );
}

// Salesforce objects and the PKCE sign-in that yields the refresh token.
export function SalesforceFields({
  config,
  setConfig,
  setSecret,
  busy,
  action,
}: {
  config: Config;
  setConfig: (config: Config) => void;
  setSecret: (secret: string) => void;
  busy: boolean;
  action: Action;
}) {
  return (
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
              const grant = await invoke<{
                refresh_token: string;
                instance_url: string;
              }>('salesforce_authorize', {
                loginUrl: (config.login_url as string) || 'https://login.salesforce.com',
                clientId: config.client_id,
              });
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
        <code>http://localhost:1717/OauthRedirect</code>. The refresh token is stored only in the
        engine's OS keychain.
      </p>
    </>
  );
}
