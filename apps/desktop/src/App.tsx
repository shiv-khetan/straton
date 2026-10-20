import { Component, lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api, normalizeUrl, subscribe } from './api';
import type {
  Api,
  Connection,
  DataMap,
  Dataset,
  EngineEvent,
  Job,
  Run,
  Source,
  SourceKind,
  Status,
} from './api';
import SqlView from './Sql';
import Dashboard from './Dashboard';
import {
  Breadcrumb,
  Button,
  Card,
  Icon,
  Pill,
  Sheet,
  Toast,
  Table as UiTable,
  stateTone,
} from './ui';
import type { IconName } from './ui';
import { backupTime, datasetLabel, isLoopback, relativeTime } from './view-model';
import { tableReference } from './sql-model';
const DataMapView = lazy(() => import('./DataMap'));
const emptyMap: DataMap = { nodes: [], edges: [] };
type Page = 'Dashboard' | 'Sources' | 'Jobs' | 'Data Map' | 'SQL' | 'Connect' | 'Backups';
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (this.state.error !== null) {
      return (
        <section className="form-section" role="alert">
          <h2>Unable to display this screen</h2>
          <p>{this.state.error}</p>
          <button onClick={() => this.setState({ error: null })}>Reload</button>
        </section>
      );
    }
    return this.props.children;
  }
}
export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
function AppContent() {
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('straton:theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* Use system preference when storage is unavailable. */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => {
      try {
        if (localStorage.getItem('straton:theme')) return;
      } catch {
        /* Follow system preference. */
      }
      setTheme(media.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  const [sheet, setSheet] = useState<'source' | 'job' | null>(null);
  const [jobSeed, setJobSeed] = useState<Dataset | null>(null);
  const [querySeed, setQuerySeed] = useState('SELECT 1;');
  const [selection, setSelection] = useState('');
  const [backups, setBackups] = useState<string[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [page, setPage] = useState<Page>('Connect');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [map, setMap] = useState<DataMap>(emptyMap);
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState('Disconnected');
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const client = useMemo(() => (connection ? api(connection) : null), [connection]);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    let active = true;
    void invoke<Connection | null>('load_connection')
      .then((saved) => {
        if (active && saved) {
          setConnection({ ...saved, url: normalizeUrl(saved.url) });
          setPage('Dashboard');
        }
      })
      .catch(() => {
        if (active) setError('Saved connection could not be loaded. Enter your connection below.');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!client) return;
    let active = true;
    void Promise.all([
      client.status(),
      client.sources(),
      client.jobs(),
      client.runs(),
      client.datamap(),
      client.backups(),
    ])
      .then(([s, so, j, r, m, b]) => {
        if (active) {
          setStatus(s);
          setBackups(b);
          setSources(so);
          setJobs(j);
          setRuns(r);
          setMap((previous) => (JSON.stringify(previous) === JSON.stringify(m) ? previous : m));
        }
      })
      .catch((e: unknown) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [client, revision]);
  useEffect(() => {
    if (!connection) return;
    return subscribe(
      connection,
      (event) => {
        setEvents((values) => [event, ...values].slice(0, 100));
        if (['catalog.changed', 'run.state', 'resync_required'].includes(event.type)) refresh();
      },
      setLive,
    );
  }, [connection]);
  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, [connection]);
  async function action(work: () => Promise<unknown>, message = 'Saved') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const datasets = map.nodes.filter((node): node is Dataset => node.type === 'dataset');
  return (
    <div className={'shell' + (collapsed ? ' rail' : '')}>
      <aside className="sidebar">
        <div className="workspace-card">
          <span className="workspace-mark">
            <Icon name="source" size={20} />
          </span>
          <div className="rail-hide">
            <strong>Straton</strong>
            <small>{connection ? new URL(connection.url).hostname : 'Engine workspace'}</small>
          </div>
          <span className="rail-hide">
            <Pill tone="primary">
              {connection && !isLoopback(connection.url) ? 'REMOTE' : 'LOCAL'}
            </Pill>
          </span>
        </div>
        <Button
          className="collapse-button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          <Icon name="collapse" />
          <span className="rail-hide">Collapse sidebar</span>
        </Button>
        <nav className="main-nav" aria-label="Main navigation">
          {(
            [
              {
                label: 'Main',
                items: [
                  ['Dashboard', 'dashboard'],
                  ['Data Map', 'map'],
                ],
              },
              {
                label: 'Data',
                items: [
                  ['Sources', 'source'],
                  ['Jobs', 'jobs'],
                  ['SQL', 'sql'],
                ],
              },
              {
                label: 'System',
                items: [
                  ['Backups', 'backup'],
                  ['Connect', 'connect'],
                ],
              },
            ] as { label: string; items: [Page, IconName][] }[]
          ).map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label rail-hide">{group.label}</p>
              {group.items.map(([item, icon]) => (
                <button
                  key={item}
                  title={item}
                  aria-label={item}
                  aria-current={page === item ? 'page' : undefined}
                  disabled={!connection && item !== 'Connect'}
                  onClick={() => {
                    setPage(item);
                    setSelection('');
                  }}
                >
                  <Icon name={icon} />
                  <span className="rail-hide">{item}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div
          className="connection-state"
          role="status"
          aria-label={live + ' · ' + (connection?.url ?? 'No engine connected')}
          title={live + ': ' + (connection?.url ?? 'No engine connected')}
        >
          <div>
            <span className={'connection-dot' + (live === 'Live' ? ' live' : '')} />
            <span className="rail-hide">{live}</span>
          </div>
          <small className="rail-hide">
            <code>{connection?.url || 'No engine connected'}</code>
          </small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <Breadcrumb
            items={['Engine', page, ...(page === 'Data Map' && selection ? [selection] : [])]}
          />
          <div className="actions">
            <Button
              aria-label={'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' theme'}
              title="Toggle theme"
              onClick={() => {
                const next = theme === 'light' ? 'dark' : 'light';
                setTheme(next);
                try {
                  localStorage.setItem('straton:theme', next);
                } catch {
                  /* Theme works without persistence. */
                }
              }}
            >
              <Icon name={theme === 'light' ? 'moon' : 'sun'} />
            </Button>
            {connection && (
              <Button disabled={busy} onClick={refresh}>
                <Icon name="refresh" />
                Refresh
              </Button>
            )}
            {client && (page === 'Sources' || page === 'Jobs') && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setJobSeed(null);
                  setSheet(page === 'Sources' ? 'source' : 'job');
                }}
              >
                <Icon name="plus" />
                {page === 'Sources' ? 'Add source' : 'New job'}
              </Button>
            )}
            {client && page === 'Backups' && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void action(() => client.backup(), 'Backup created')}
              >
                <Icon name="backup" />
                Back up now
              </Button>
            )}
          </div>
        </header>
        <div
          className={
            'page-content' +
            (page === 'Data Map' ? ' map-page' : '') +
            (page === 'Connect' ? ' connect-page' : '')
          }
        >
          {error && <Toast message={error} error onClose={() => setError('')} />}
          {notice && <Toast message={notice} onClose={() => setNotice('')} />}
          {page === 'Connect' && (
            <Connect
              connection={connection}
              busy={busy}
              connect={(c) =>
                action(async () => {
                  await api(c).status();
                  await invoke('save_connection', c as unknown as Record<string, unknown>);
                  setConnection(c);
                  setPage('Dashboard');
                }, 'Connection tested and saved in OS keychain')
              }
              forget={() =>
                action(async () => {
                  await invoke('forget_connection');
                  setConnection(null);
                  setStatus(null);
                  setSources([]);
                  setJobs([]);
                  setRuns([]);
                  setMap(emptyMap);
                  setEvents([]);
                  setBackups([]);
                  setLive('Disconnected');
                }, 'Connection forgotten')
              }
            />
          )}
          {client && page === 'Dashboard' && (
            <Dashboard datasets={datasets} runs={runs} jobs={jobs} status={status}>
              <RunTable runs={runs.slice(0, 12)} jobs={jobs} />
            </Dashboard>
          )}
          {client && page === 'Backups' && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Backups</h1>
                  <p className="hint">Engine snapshots, ready when you need them.</p>
                </div>
              </div>
              <Card>
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Engine backups">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Filename</th>
                        <th scope="col">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backups.map((path) => {
                        const time = backupTime(path);
                        return (
                          <tr key={path}>
                            <td title={path}>
                              <code>{path.split(/[\\/]/).pop()}</code>
                            </td>
                            <td title={time ? new Date(time).toLocaleString() : path}>
                              {relativeTime(time)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!backups.length && (
                  <p className="empty">
                    No backups yet. Create your first snapshot with Back up now.
                  </p>
                )}
              </Card>
            </>
          )}
          {client && page === 'Sources' && (
            <Sources
              sources={sources}
              client={client}
              busy={busy}
              action={action}
              open={sheet === 'source'}
              onClose={() => setSheet(null)}
            />
          )}
          {client && page === 'Jobs' && (
            <Jobs
              sources={sources}
              datasets={datasets}
              jobs={jobs}
              runs={runs}
              events={events}
              open={sheet === 'job'}
              onClose={() => setSheet(null)}
              seed={jobSeed}
              client={client}
              action={action}
              busy={busy}
            />
          )}
          {client && page === 'SQL' && (
            <SqlView client={client} revision={revision} initialQuery={querySeed} />
          )}
          {client && connection && page === 'Data Map' && (
            <ErrorBoundary>
              <Suspense fallback={<p role="status">Loading Data Map…</p>}>
                <DataMapView
                  map={map}
                  onSelection={setSelection}
                  onQuery={(dataset) => {
                    setQuerySeed(
                      'SELECT * FROM ' +
                        tableReference(dataset.sql_schema, dataset.sql_table) +
                        ' LIMIT 100',
                    );
                    setPage('SQL');
                  }}
                  onCreateJob={(dataset) => {
                    setJobSeed(dataset);
                    setSheet('job');
                    setPage('Jobs');
                  }}
                  engineUrl={connection.url}
                  client={client}
                  action={action}
                  busy={busy}
                />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </main>
    </div>
  );
}
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
function Connect({
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
      <h1>Connect your engine</h1>
      <p className="hint">Your workspace starts with a connection.</p>
      <form onSubmit={submit}>
        <Field label="Engine URL">
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Bearer token">
          <input
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
          Use HTTPS for remote engines. HTTP is allowed only on localhost or 127.0.0.1. The
          connection is stored in your OS keychain.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="actions">
          <button className="primary" disabled={busy}>
            {busy ? 'Connecting…' : 'Test and save connection'}
          </button>
          {connection && (
            <button type="button" disabled={busy} onClick={() => void forget()}>
              Forget connection
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
const fields: Record<string, string[]> = {
  postgres: ['host', 'port', 'database', 'username', 'batch_size'],
  sqlite: ['path', 'batch_size'],
  csv: ['path', 'batch_size', 'sample_size'],
  external: [],
};
function Sources({
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
  const [config, setConfig] = useState<Record<string, string | number>>({});
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
          .map(([key, value]) => [
            key,
            ['port', 'batch_size', 'sample_size'].includes(key) ? Number(value) : value,
          ]),
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
      <Card>
        <h2>Connected systems</h2>
        <UiTable label="Sources">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td>{source.name}</td>
                <td>
                  <code>{source.kind}</code>
                </td>
                <td>
                  <Pill tone={source.kind === 'external' ? 'neutral' : 'success'}>
                    {source.kind === 'external' ? 'External' : 'Configured'}
                  </Pill>
                </td>
                <td>
                  <div className="actions">
                    {['postgres', 'sqlite', 'csv', 'external'].includes(source.kind) && (
                      <>
                        <button
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
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm('Delete source “' + source.name + '”?'))
                              void action(() => client.deleteSource(source.id), 'Source deleted');
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {!['external', 'parquet'].includes(source.kind) && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(
                              () => client.checkSource(source.id),
                              'Connection check passed',
                            )
                          }
                        >
                          Check
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(
                              () => client.discoverSource(source.id),
                              'Catalog discovered',
                            )
                          }
                        >
                          Discover
                        </button>
                      </>
                    )}
                    {source.kind === 'external' && (
                      <button disabled={busy} onClick={() => setManual(source.id)}>
                        Add dataset
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </UiTable>
        {!sources.length && (
          <p className="empty">Add a source, then Discover to populate your Data Map.</p>
        )}
      </Card>
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
              <input required value={name} onChange={(e) => setName(e.target.value)} />
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
                {['postgres', 'sqlite', 'csv', 'external'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            {(fields[kind] || []).map((key) => (
              <Field
                key={key}
                label={key === 'path' ? 'Path on engine machine' : key.replaceAll('_', ' ')}
              >
                <input
                  required={['host', 'database', 'username', 'path'].includes(key)}
                  type={['port', 'batch_size', 'sample_size'].includes(key) ? 'number' : 'text'}
                  min="1"
                  max="2147483647"
                  value={config[key] ?? ''}
                  onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                />
              </Field>
            ))}
            {kind === 'postgres' && (
              <Field label="Password (write-only)">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={
                    editing ? 'Leave blank to keep current secret' : 'Stored in engine OS keychain'
                  }
                />
              </Field>
            )}
          </div>
          <div className="actions">
            <button className="primary" disabled={busy}>
              Save source
            </button>
            {editing && (
              <button type="button" onClick={reset}>
                Cancel edit
              </button>
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
              <input
                required
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
              />
            </Field>
            {columns.map((column, i) => (
              <div className="column-editor" key={i}>
                <Field label="Column name">
                  <input
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
                  <input
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
                <button
                  type="button"
                  disabled={columns.length === 1}
                  onClick={() => setColumns(columns.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="actions">
              <button
                type="button"
                onClick={() =>
                  setColumns([...columns, { name: '', type: 'Utf8', nullable: true, pk: false }])
                }
              >
                Add column
              </button>
              <button className="primary" disabled={busy}>
                Create dataset
              </button>
              <button type="button" onClick={() => setManual('')}>
                Cancel
              </button>
            </div>
          </form>
        </Sheet>
      )}
    </>
  );
}
function Jobs({
  sources,
  datasets,
  jobs,
  runs,
  events,
  client,
  action,
  busy,
  open,
  onClose,
  seed,
}: {
  sources: Source[];
  datasets: Dataset[];
  jobs: Job[];
  runs: Run[];
  events: EngineEvent[];
  client: Api;
  action: Action;
  busy: boolean;
  open: boolean;
  onClose: () => void;
  seed: Dataset | null;
}) {
  const [name, setName] = useState(seed ? 'Sync ' + datasetLabel(seed) : '');
  const [source, setSource] = useState(seed?.source_id ?? '');
  const [dataset, setDataset] = useState(seed?.name ?? '');
  useEffect(() => {
    if (open) {
      setName(seed ? 'Sync ' + datasetLabel(seed) : '');
      setSource(seed?.source_id ?? '');
      setDataset(seed?.name ?? '');
    }
  }, [seed, open]);
  const [cron, setCron] = useState('0 */5 * * * *');
  const [jobFilter, setJobFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Jobs</h1>
          <p className="hint">Keep your local lake in sync.</p>
        </div>
      </div>
      <Card>
        <h2>Sync jobs</h2>
        <UiTable label="Sync jobs">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Dataset</th>
              <th scope="col">Schedule (UTC)</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  {job.name}
                  <small>
                    <Pill tone={job.enabled ? 'success' : 'neutral'}>
                      {job.enabled ? 'Enabled' : 'Disabled'}
                    </Pill>
                  </small>
                </td>
                <td>
                  {datasetLabel(
                    datasets.find(
                      (d) => d.source_id === job.source_id && d.name === job.dataset,
                    ) ?? { name: job.dataset },
                  )}
                </td>
                <td>
                  <code>{job.cron || 'Manual'}</code>
                </td>
                <td>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() => void action(() => client.runJob(job.id), 'Run queued')}
                    >
                      Run now
                    </button>
                    {!job.builtin && job.source_id && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(
                            () =>
                              client.updateJob(job.id, {
                                name: job.name,
                                source_id: job.source_id!,
                                dataset: job.dataset,
                                cron: job.cron,
                                enabled: !job.enabled,
                              }),
                            'Job updated',
                          )
                        }
                      >
                        {job.enabled ? 'Disable' : 'Enable'}
                      </button>
                    )}
                    <button onClick={() => setJobFilter(job.id)}>History</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </UiTable>
        {!jobs.length && <p className="empty">Create a job after discovering a source.</p>}
      </Card>
      <Sheet open={open} title="Create sync job" onClose={onClose}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await client.createJob({
                name,
                source_id: source,
                dataset,
                cron: cron.trim() || null,
                enabled: true,
              });
              setName('');
              onClose();
            }, 'Job created');
          }}
        >
          <div className="form-grid">
            <Field label="Job name">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Source">
              <select
                required
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setDataset('');
                }}
              >
                <option value="">Select source</option>
                {sources
                  .filter((s) => ['postgres', 'sqlite', 'csv', 'noop'].includes(s.kind))
                  .map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Dataset">
              <select required value={dataset} onChange={(e) => setDataset(e.target.value)}>
                <option value="">Select discovered dataset</option>
                {datasets
                  .filter((d) => d.source_id === source && !d.stale)
                  .map((d) => (
                    <option key={d.id} value={d.name}>
                      {datasetLabel(d)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Cron (UTC, seconds first)">
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                aria-describedby="cron-help"
              />
            </Field>
          </div>
          <p id="cron-help" className="hint">
            Six fields: second minute hour day month weekday. “0 */5 * * * *” runs every five
            minutes. Leave blank for manual runs.
          </p>
          <button className="primary" disabled={busy || !dataset}>
            Create job
          </button>
        </form>
      </Sheet>
      <Card>
        <h2>Run history</h2>
        <div className="toolbar">
          <Field label="Job">
            <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
              <option value="">All jobs</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="State">
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="">All states</option>
              {['queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>
        <RunTable
          runs={runs.filter(
            (r) =>
              (!jobFilter || r.job_id === jobFilter) && (!stateFilter || r.state === stateFilter),
          )}
          jobs={jobs}
          cancel={(id) => void action(() => client.cancelRun(id), 'Cancellation requested')}
          busy={busy}
        />
      </Card>
      <Card>
        <h2>Live activity</h2>
        <p className="hint">
          Run state events from the engine. Historical log text is not exposed by this engine
          version.
        </p>
        <div className="event-log" role="log" aria-live="polite">
          {events
            .filter((e) => e.type.startsWith('run.') || e.type.includes('log'))
            .slice(0, 30)
            .map((e, i) => (
              <div key={i}>
                <code>{e.type}</code> {e.id} {e.state} {e.message}
              </div>
            ))}
        </div>
      </Card>
    </>
  );
}
function RunTable({
  runs,
  jobs,
  cancel,
  busy,
}: {
  runs: Run[];
  jobs: Job[];
  cancel?: (id: string) => void;
  busy?: boolean;
}) {
  return runs.length ? (
    <UiTable label="Run history">
      <thead>
        <tr>
          <th scope="col">Job / run</th>
          <th scope="col">State</th>
          <th scope="col">Attempt</th>
          <th scope="col">Batches</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              {jobs.find((j) => j.id === run.job_id)?.name || run.job_id}
              <small>
                <code>{run.id}</code>
              </small>
            </td>
            <td>
              <Pill tone={stateTone(run.state)}>{run.state}</Pill>
            </td>
            <td>{run.attempt}</td>
            <td>{run.committed_batches}</td>
            <td>
              {run.error || new Date(run.available_at * 1000).toLocaleString()}
              {cancel && ['queued', 'running'].includes(run.state) && (
                <button disabled={busy} onClick={() => cancel(run.id)}>
                  Cancel run
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </UiTable>
  ) : (
    <p className="empty">No matching runs.</p>
  );
}
