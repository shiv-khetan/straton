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
const DataMapView = lazy(() => import('./DataMap'));
const emptyMap: DataMap = { nodes: [], edges: [] };
type Page = 'Dashboard' | 'Sources' | 'Jobs' | 'Data Map' | 'SQL' | 'Connect';
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
    ])
      .then(([s, so, j, r, m]) => {
        if (active) {
          setStatus(s);
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
    <div className="shell">
      <aside>
        <div className="brand">◈ Straton</div>
        <p className="sidebar-caption">Engine workspace</p>
        <nav aria-label="Main navigation">
          {(['Dashboard', 'Sources', 'Jobs', 'Data Map', 'SQL', 'Connect'] as Page[]).map(
            (item) => (
              <button
                key={item}
                aria-current={page === item ? 'page' : undefined}
                disabled={!connection && item !== 'Connect'}
                onClick={() => setPage(item)}
              >
                {item}
              </button>
            ),
          )}
        </nav>
        <div className="connection-state">
          <span className={live === 'Live' ? 'live-dot' : ''}>●</span> {live}
          <small>{connection?.url || 'No engine connected'}</small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <h1>{page}</h1>
            <p>
              {page === 'Data Map'
                ? 'Explore the catalog, trace relationships, and connect columns.'
                : page === 'Connect'
                  ? 'Connect to your self-hosted engine.'
                  : 'Your data operations, in one place.'}
            </p>
          </div>
          {connection && (
            <button disabled={busy} onClick={refresh}>
              Refresh
            </button>
          )}
        </header>
        {error && (
          <div className="message error" role="alert">
            {error}
            <button onClick={() => setError('')} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="message" role="status">
            {notice}
          </div>
        )}
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
                setLive('Disconnected');
              }, 'Connection forgotten')
            }
          />
        )}
        {client && page === 'Dashboard' && (
          <>
            <section className="status-strip" aria-label="Engine status">
              <div>
                Version<strong>{status?.version ?? 'Loading…'}</strong>
              </div>
              <div>
                Uptime
                <strong>
                  {status ? Math.floor(status.uptime_seconds / 60) + ' minutes' : 'Loading…'}
                </strong>
              </div>
              <div>
                Queued<strong>{status?.queue_depth ?? '…'}</strong>
              </div>
              <div>
                Last backup
                <strong className="path">{status?.last_backup || 'No backup yet'}</strong>
              </div>
            </section>
            <div className="section-heading">
              <h2>Recent activity</h2>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void action(() => client.backup(), 'Backup created')}
              >
                Backup now
              </button>
            </div>
            {(['running', 'queued', 'failed'] as const).map((state) => (
              <section key={state}>
                <h3>
                  {state}{' '}
                  <span className="count">{runs.filter((r) => r.state === state).length}</span>
                </h3>
                <RunTable runs={runs.filter((r) => r.state === state).slice(0, 8)} jobs={jobs} />
              </section>
            ))}
            <h2>Latest runs</h2>
            <RunTable runs={runs.slice(0, 12)} jobs={jobs} />
          </>
        )}
        {client && page === 'Sources' && (
          <Sources sources={sources} client={client} busy={busy} action={action} />
        )}
        {client && page === 'Jobs' && (
          <Jobs
            sources={sources}
            datasets={datasets}
            jobs={jobs}
            runs={runs}
            events={events}
            client={client}
            action={action}
            busy={busy}
          />
        )}
        {client && page === 'SQL' && <SqlView client={client} revision={revision} />}
        {client && connection && page === 'Data Map' && (
          <ErrorBoundary>
            <Suspense fallback={<p role="status">Loading Data Map…</p>}>
              <DataMapView
                map={map}
                engineUrl={connection.url}
                client={client}
                action={action}
                busy={busy}
              />
            </Suspense>
          </ErrorBoundary>
        )}
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
    <section className="form-section">
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
}: {
  sources: Source[];
  client: Api;
  action: Action;
  busy: boolean;
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
      },
      editing ? 'Source updated' : 'Source created',
    );
  }
  return (
    <>
      <section>
        <h2>Connected systems</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>{source.name}</td>
                  <td>{source.kind}</td>
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
          </table>
        </div>
        {!sources.length && (
          <p className="empty">Add a source below, then Discover to populate your Data Map.</p>
        )}
      </section>
      <section className="form-section">
        <h2>{editing ? 'Edit source' : 'Add source'}</h2>
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
      </section>
      {manual && (
        <section className="form-section">
          <h2>Add dataset to {sources.find((s) => s.id === manual)?.name}</h2>
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
        </section>
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
}: {
  sources: Source[];
  datasets: Dataset[];
  jobs: Job[];
  runs: Run[];
  events: EngineEvent[];
  client: Api;
  action: Action;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [dataset, setDataset] = useState('');
  const [cron, setCron] = useState('0 */5 * * * *');
  const [jobFilter, setJobFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  return (
    <>
      <section>
        <h2>Sync jobs</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Dataset</th>
                <th>Schedule (UTC)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    {job.name}
                    <small>{job.enabled ? 'Enabled' : 'Disabled'}</small>
                  </td>
                  <td>{job.dataset}</td>
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
          </table>
        </div>
        {!jobs.length && <p className="empty">Create a job after discovering a source.</p>}
      </section>
      <section className="form-section">
        <h2>Create sync job</h2>
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
                      {d.name}
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
      </section>
      <section>
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
      </section>
      <section>
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
      </section>
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
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Job / run</th>
            <th>State</th>
            <th>Attempt</th>
            <th>Batches</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                {jobs.find((j) => j.id === run.job_id)?.name || run.job_id}
                <small>{run.id}</small>
              </td>
              <td>
                <span className={'badge ' + run.state}>{run.state}</span>
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
      </table>
    </div>
  ) : (
    <p className="empty">No matching runs.</p>
  );
}
