import { fetch } from '@tauri-apps/plugin-http';
import WebSocket from '@tauri-apps/plugin-websocket';

export interface SqlColumn {
  name: string;
  type: string;
}
export interface SqlTable {
  schema: string;
  name: string;
  columns: SqlColumn[];
}
export type SqlCell = string | number | boolean | null;
export interface SqlResult {
  columns: SqlColumn[];
  rows: SqlCell[][];
  row_count: number;
  truncated_preview: boolean;
  elapsed_ms: number;
}
export interface SqlExplain {
  logical: string;
  physical: string;
}

export interface Connection {
  url: string;
  token: string;
}
export type SourceKind = 'postgres' | 'sqlite' | 'csv' | 'external' | 'parquet' | 'noop';
export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  credential_id: string | null;
  config: Record<string, string | number>;
}
export type SourceInput = Omit<Source, 'id' | 'credential_id'> & { secret?: string };
export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}
export interface MapSource {
  type: 'source';
  id: string;
  name: string;
  kind: SourceKind;
  connected: boolean;
}
export interface Dataset {
  type: 'dataset';
  display_name?: string;
  id: string;
  source_id: string;
  name: string;
  stale: boolean;
  columns: Column[];
}
export type EdgeKind = 'declared_fk' | 'inferred' | 'lineage' | 'manual';
export interface Relationship {
  id: string;
  from_dataset: string;
  from_cols: string[];
  to_dataset: string;
  to_cols: string[];
  kind: EdgeKind;
  confidence: number | null;
}
export interface DataMap {
  nodes: (MapSource | Dataset)[];
  edges: Relationship[];
}
export interface Job {
  id: string;
  name: string;
  source_id: string | null;
  dataset: string;
  cron: string | null;
  enabled: boolean;
  builtin: boolean;
}
export interface JobInput {
  name: string;
  source_id: string;
  dataset: string;
  cron: string | null;
  enabled: boolean;
}
export type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export interface Run {
  id: string;
  job_id: string;
  state: RunState;
  attempt: number;
  available_at: number;
  error: string | null;
  committed_batches: number;
}
export interface Status {
  version: string;
  uptime_seconds: number;
  queue_depth: number;
  last_backup: string | null;
}
export interface EngineEvent {
  type: string;
  id?: string;
  state?: RunState;
  message?: string;
}
export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use a root HTTPS URL, or HTTP on localhost / 127.0.0.1.');
  return url.origin;
}
const idPath = (id: string) => encodeURIComponent(id);
export function api(connection: Connection) {
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(connection.url + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + connection.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      connectTimeout: 15000,
      maxRedirections: 0,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(error?.error || 'Engine request failed (' + response.status + ')');
    }
    if (response.status === 204 || (response.status === 202 && path.endsWith('/cancel')))
      return undefined as T;
    return response.json() as Promise<T>;
  }
  return {
    sqlQuery: (query: string, limit = 1000) =>
      request<SqlResult>('/v1/sql', 'POST', { query, limit }),
    sqlExplain: (query: string) => request<SqlExplain>('/v1/sql/explain', 'POST', { query }),
    sqlTables: () => request<{ tables: SqlTable[] }>('/v1/sql/tables'),
    health: () => request<{ ok: boolean }>('/health'),
    status: () => request<Status>('/v1/status'),
    sources: () => request<Source[]>('/v1/sources'),
    source: (id: string) => request<Source>('/v1/sources/' + idPath(id)),
    createSource: (body: SourceInput) => request<Source>('/v1/sources', 'POST', body),
    updateSource: (id: string, body: SourceInput) =>
      request<Source>('/v1/sources/' + idPath(id), 'PUT', body),
    deleteSource: (id: string) => request<void>('/v1/sources/' + idPath(id), 'DELETE'),
    checkSource: (id: string) =>
      request<{ ok: boolean }>('/v1/sources/' + idPath(id) + '/check', 'POST'),
    discoverSource: (id: string) =>
      request<{ ok: boolean }>('/v1/sources/' + idPath(id) + '/discover', 'POST'),
    createDataset: (id: string, body: { name: string; columns: Column[] }) =>
      request<{ id: string; source_id: string; name: string }>(
        '/v1/sources/' + idPath(id) + '/datasets',
        'POST',
        body,
      ),
    datamap: () => request<DataMap>('/v1/datamap'),
    createRelationship: (body: Omit<Relationship, 'id'>) =>
      request<Relationship>('/v1/relationships', 'POST', body),
    deleteRelationship: (id: string) => request<void>('/v1/relationships/' + idPath(id), 'DELETE'),
    jobs: () => request<Job[]>('/v1/jobs'),
    job: (id: string) => request<Job>('/v1/jobs/' + idPath(id)),
    createJob: (body: JobInput) => request<JobInput & { id: string }>('/v1/jobs', 'POST', body),
    updateJob: (id: string, body: JobInput) =>
      request<JobInput & { id: string }>('/v1/jobs/' + idPath(id), 'PUT', body),
    deleteJob: (id: string) => request<void>('/v1/jobs/' + idPath(id), 'DELETE'),
    runJob: (id: string) =>
      request<{ id: string; state: RunState }>('/v1/jobs/' + idPath(id) + '/run', 'POST'),
    runs: (job = '', state = '') =>
      request<Run[]>(
        '/v1/runs?' + new URLSearchParams({ ...(job ? { job } : {}), ...(state ? { state } : {}) }),
      ),
    cancelRun: (id: string) => request<void>('/v1/runs/' + idPath(id) + '/cancel', 'POST'),
    backups: () => request<string[]>('/v1/backups'),
    backup: () => request<{ file: string }>('/v1/backups', 'POST'),
  };
}
export type Api = ReturnType<typeof api>;
export function subscribe(
  connection: Connection,
  receive: (event: EngineEvent) => void,
  state: (value: string) => void,
): () => void {
  let stopped = false,
    attempt = 0;
  let socket: WebSocket | undefined,
    unlisten: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  function retry() {
    if (stopped || timer) return;
    state('Reconnecting');
    timer = setTimeout(
      () => {
        timer = undefined;
        void connect();
      },
      Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
    );
  }
  async function connect() {
    try {
      state('Connecting');
      const next = await WebSocket.connect(connection.url.replace(/^http/, 'ws') + '/v1/events', {
        headers: { Authorization: 'Bearer ' + connection.token },
      });
      if (stopped) {
        await next.disconnect();
        return;
      }
      socket = next;
      unlisten = next.addListener((message) => {
        if (stopped) return;
        if (message.type === 'Close') {
          clearTimeout(stableTimer);
          unlisten?.();
          socket = undefined;
          retry();
        }
        if (message.type === 'Text') {
          try {
            const value: unknown = JSON.parse(message.data);
            if (
              typeof value === 'object' &&
              value !== null &&
              'type' in value &&
              typeof value.type === 'string'
            )
              receive(value as EngineEvent);
          } catch {
            /* Ignore malformed event frames. */
          }
        }
      });
      stableTimer = setTimeout(() => {
        attempt = 0;
      }, 10000);
      state('Live');
      receive({ type: 'resync_required' });
    } catch {
      retry();
    }
  }
  void connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(stableTimer);
    unlisten?.();
    void socket?.disconnect().catch(() => {});
  };
}
