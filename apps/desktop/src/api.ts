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

export interface ModelInput {
  name: string;
  sql: string;
  materialization: 'table' | 'view';
  trigger: 'manual' | 'cron' | 'upstream';
  cron: string | null;
  optimize: boolean;
}
export interface Model extends ModelInput {
  id: string;
  owner_id: string;
  status: string;
  error: string | null;
  row_count: number | null;
  last_run: number | null;
  last_run_status: string | null;
}
export interface ModelExplain {
  logical_before: string;
  logical_after: string;
  physical: string;
  rules_fired: { rule: string; before: string; after: string }[];
}
export interface ModelLineage {
  upstream: Dataset[];
  downstream: Dataset[];
}
export interface Connection {
  url: string;
  token: string;
}
export type SourceKind =
  | 'postgres'
  | 'sqlite'
  | 'csv'
  | 'stripe'
  | 'salesforce'
  | 'external'
  | 'parquet'
  | 'noop'
  | 'models';
export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  credential_id: string | null;
  config: Record<string, string | number | string[]>;
}
export type SourceInput = Omit<Source, 'id' | 'credential_id'> & { secret?: string };
export type Privilege = 'read' | 'sync_admin' | 'admin';
export type MaskKind = 'null' | 'redact' | 'hash' | 'last4';
export interface User {
  id: string;
  name: string;
  disabled: boolean;
  created_at: number;
  role_ids: string[];
}
export interface Role {
  id: string;
  name: string;
  is_admin: boolean;
}
export interface Grant {
  id: string;
  role_id: string;
  target_kind: 'source' | 'dataset';
  target_id: string;
  privilege: Privilege;
}
export interface Me {
  user: User;
  roles: Role[];
  privileges: { admin: boolean; read: boolean; sync_admin: boolean; grants: Grant[] };
}
export interface TokenInfo {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}
export interface Policies {
  row_filters: { role_id: string; predicate: string }[];
  masks: { role_id: string; column: string; kind: MaskKind }[];
}
export interface Column {
  masked?: boolean;
  mask_kind?: MaskKind | null;
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
  row_filtered?: boolean;
  type: 'dataset';
  display_name?: string;
  id: string;
  source_id: string;
  name: string;
  stale: boolean;
  row_count: number | null;
  last_synced_at: string | null;
  sql_schema: string;
  sql_table: string;
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
export interface SyncSettings {
  mode: 'full' | 'incremental';
  watermark_column: string | null;
  key_columns: string[] | null;
  delete_detection: 'none' | 'key_diff';
  key_diff_every_runs: number;
}
export interface Job extends SyncSettings {
  id: string;
  name: string;
  source_id: string | null;
  dataset: string;
  cron: string | null;
  enabled: boolean;
  builtin: boolean;
  watermark: string | number | null;
}
export interface JobInput extends SyncSettings {
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
  mode_used: 'full' | 'incremental';
  rows_read: number;
  rows_inserted: number;
  rows_updated: number;
  rows_deleted: number;
  fallback_reason: string | null;
}
export interface Status {
  version: string;
  uptime_seconds: number;
  queue_depth: number;
  last_backup: string | null;
}
export interface EngineEvent {
  /** Local receipt time; the engine event payload has no timestamp. */
  received_at?: number;
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
    models: () => request<Model[]>('/v1/models'),
    createModel: (model: ModelInput) => request<Model>('/v1/models', 'POST', model),
    updateModel: (id: string, model: ModelInput) =>
      request<Model>('/v1/models/' + idPath(id), 'PUT', model),
    deleteModel: (id: string) => request<void>('/v1/models/' + idPath(id), 'DELETE'),
    validateModel: (model: ModelInput) =>
      request<{ valid: boolean }>('/v1/models/validate', 'POST', model),
    runModel: (id: string) => request<{ id: string }>('/v1/models/' + idPath(id) + '/run', 'POST'),
    explainModel: (id: string) => request<ModelExplain>('/v1/models/' + idPath(id) + '/explain'),
    modelLineage: (id: string) => request<ModelLineage>('/v1/models/' + idPath(id) + '/lineage'),
    me: () => request<Me>('/v1/me'),
    users: () => request<User[]>('/v1/users'),
    createUser: (name: string) => request<User>('/v1/users', 'POST', { name }),
    updateUser: (user: User, disabled: boolean) =>
      request<User>('/v1/users/' + idPath(user.id), 'PUT', { name: user.name, disabled }),
    assignRoles: (user: string, role_ids: string[]) =>
      request<void>('/v1/users/' + idPath(user) + '/roles', 'PUT', { role_ids }),
    tokens: (user: string) => request<TokenInfo[]>('/v1/users/' + idPath(user) + '/tokens'),
    issueToken: (user: string, name: string, expires_at: number | null) =>
      request<{ id: string; token: string }>('/v1/users/' + idPath(user) + '/tokens', 'POST', {
        name,
        expires_at,
      }),
    revokeToken: (user: string, token: string) =>
      request<void>('/v1/users/' + idPath(user) + '/tokens/' + idPath(token), 'DELETE'),
    roles: () => request<Role[]>('/v1/roles'),
    createRole: (name: string) => request<Role>('/v1/roles', 'POST', { name }),
    deleteRole: (id: string) => request<void>('/v1/roles/' + idPath(id), 'DELETE'),
    grants: () => request<Grant[]>('/v1/grants'),
    createGrant: (grant: Omit<Grant, 'id'>) => request<Grant>('/v1/grants', 'POST', grant),
    deleteGrant: (id: string) => request<void>('/v1/grants/' + idPath(id), 'DELETE'),
    policies: (dataset: string) =>
      request<Policies>('/v1/datasets/' + idPath(dataset) + '/policies'),
    rowFilter: (dataset: string, role: string, predicate: string | null) =>
      request<void>(
        '/v1/datasets/' + idPath(dataset) + '/row-filters/' + idPath(role),
        predicate === null ? 'DELETE' : 'PUT',
        predicate === null ? undefined : { predicate },
      ),
    mask: (dataset: string, role: string, column: string, kind: MaskKind | null) =>
      request<void>(
        '/v1/datasets/' + idPath(dataset) + '/masks/' + idPath(role) + '/' + idPath(column),
        kind === null ? 'DELETE' : 'PUT',
        kind === null ? undefined : { kind },
      ),
    validatePolicy: (dataset_id: string, predicate: string) =>
      request<{ ok: boolean; error?: string }>('/v1/policies/validate', 'POST', {
        dataset_id,
        predicate,
      }),
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
    datamap: (role = '') =>
      request<DataMap>('/v1/datamap' + (role ? '?as_role=' + idPath(role) : '')),
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
