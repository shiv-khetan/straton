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
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'starts_with'
  | 'is_null'
  | 'not_null'
  | 'in';
export interface ExplorerFilter {
  column: string;
  op: FilterOp;
  value?: SqlCell | SqlCell[];
}
export interface ExplorerRequest {
  schema: string;
  table: string;
  columns?: string[];
  sort: { column: string; dir: 'asc' | 'desc' }[];
  filters: ExplorerFilter[];
  search?: string;
  limit: number;
  offset: number;
}
export interface ExplorerRows {
  columns: SqlColumn[];
  rows: SqlCell[][];
  offset: number;
  limit: number;
  total: number;
  total_exact: boolean;
}
export interface ExplorerTree {
  sources: {
    source_id: string;
    name: string;
    kind: SourceKind;
    schemas: { name: string; tables: Dataset[] }[];
  }[];
}
export interface SavedQuery {
  id: string;
  owner_id: string;
  name: string;
  sql: string;
  shared: boolean;
  created_at: number;
  updated_at: number;
}
export type SavedQueryInput = Pick<SavedQuery, 'name' | 'sql' | 'shared'>;
export interface StorageUsage {
  total_bytes: number;
  state_db_bytes: number;
  backups_bytes: number;
  lake_bytes: number;
  models_bytes: number;
  sources: {
    source_id: string;
    name: string;
    bytes: number;
    datasets: { dataset_id: string; name: string; bytes: number; snapshot: string | null }[];
  }[];
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
  | 'sqlserver'
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
  config: Record<string, string | number | boolean | string[]>;
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
  dataset_type?: 'table' | 'view';
  approximate_row_count?: number | null;
  definition?: string | null;
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
export interface DatasetKey {
  id: string;
  target_id: string;
  kek_version: number;
  created_at: number;
  retired_at: number | null;
}
export interface AuditVerification {
  ok: boolean;
  rows: number;
  first_bad_id: number | null;
}
export interface Status {
  version: string;
  uptime_seconds: number;
  queue_depth: number;
  last_backup: string | null;
  encryption_enabled: boolean;
  audit_head: string;
}
export interface EngineEvent {
  /** Local receipt time; the engine event payload has no timestamp. */
  received_at?: number;
  type: string;
  id?: string;
  state?: RunState | 'pending' | 'skipped';
  run_id?: string;
  node_id?: string | null;
  severity?: 'info' | 'warn' | 'error';
  title?: string;
  body?: string;
  entity_kind?: string;
  entity_id?: string;
  message?: string;
}

export type PipelineKind = 'sync' | 'transform' | 'validate';
export interface PipelineNode {
  node_id: string;
  kind: PipelineKind;
  ref_id: string;
  label: string;
  x: number;
  y: number;
}
export interface PipelineEdge {
  from_node: string;
  to_node: string;
}
export interface PipelineInput {
  name: string;
  description: string;
  cron: string | null;
  enabled: boolean;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}
export interface Pipeline extends Omit<PipelineInput, 'nodes' | 'edges'> {
  id: string;
  owner_id: string;
  last_scheduled: number;
  created_at: number;
  updated_at: number;
}
export interface PipelineGraph extends Pipeline {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}
export interface PipelineValidation {
  valid: boolean;
  errors: { node_id?: string; message: string }[];
}
export interface PipelineRun {
  id: string;
  pipeline_id: string;
  state: RunState;
  trigger: 'manual' | 'cron';
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}
export interface PipelineRunNode {
  node_id: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  child_run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}
export interface PipelineRunDetail extends PipelineRun {
  nodes: PipelineRunNode[];
}
export type QualityKind =
  'not_null' | 'unique' | 'range' | 'freshness' | 'row_count' | 'custom_sql';
export interface QualityInput {
  name: string;
  dataset_id: string | null;
  model_id: string | null;
  kind: QualityKind;
  column_name: string | null;
  config: { min?: SqlCell; max?: SqlCell; max_age_seconds?: number; sql?: string };
  severity: 'error' | 'warn';
  cron: string | null;
  enabled: boolean;
}
export interface QualityCheck extends QualityInput {
  id: string;
  owner_id: string;
  last_scheduled: number;
  created_at: number;
  updated_at: number;
}
export interface QualityRun {
  id: string;
  check_id: string;
  status: 'passed' | 'failed' | 'error';
  observed: number | null;
  failing_rows: number | null;
  message: string;
  pipeline_run_id: string | null;
  started_at: number;
  finished_at: number;
}
export interface QualitySummary {
  score: number;
  counts: { passed: number; failed: number; error: number };
  datasets: { dataset_id: string; score: number; passed: number; total: number }[];
  daily: { day: number; passed: number; total: number; score: number }[];
}
export type ChartKind = 'line' | 'bar' | 'area' | 'stat' | 'table';
export interface ChartConfig {
  x?: string;
  y?: string[];
  series?: string;
  time_column?: string;
}
export interface ChartInput {
  name: string;
  sql: string;
  kind: ChartKind;
  config: ChartConfig;
  shared: boolean;
}
export interface Chart extends ChartInput {
  id: string;
  owner_id: string;
  created_at: number;
  updated_at: number;
}
export interface ChartRange {
  from?: SqlCell;
  to?: SqlCell;
}
export interface ChartData {
  columns: SqlColumn[];
  rows: SqlCell[][];
}
export interface DashboardTile {
  chart_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface DashboardInput {
  name: string;
  description: string;
  layout: DashboardTile[];
  shared: boolean;
}
export interface AnalyticsDashboard extends DashboardInput {
  id: string;
  owner_id: string;
  created_at: number;
  updated_at: number;
}
export type ImpactDirection = 'downstream' | 'upstream' | 'both';
export interface ColumnRef {
  dataset_id: string;
  column: string;
}
export type ColumnLineageKind = 'passthrough' | 'rename' | 'transform' | 'aggregate';
export interface ColumnGraph {
  root: ColumnRef;
  nodes: (ColumnRef & { dataset_name: string; kind: string })[];
  edges: {
    from: ColumnRef;
    to: ColumnRef;
    kind: ColumnLineageKind;
    expression: string | null;
    via: { model_id?: string; view_id?: string };
  }[];
  usage: (ColumnRef & {
    role: 'join_key' | 'filter' | 'group_key';
    in: { kind: 'model' | 'check' | 'chart'; id: string; name: string };
  })[];
  incomplete: boolean;
}
export interface ImpactRequest {
  node: string;
  direction?: ImpactDirection;
  depth?: number;
}
export interface ImpactGraph {
  root: string;
  nodes: {
    id: string;
    kind: 'dataset' | 'model' | 'pipeline' | 'check' | 'chart' | 'dashboard';
    name: string;
    status: string | null;
  }[];
  edges: { from: string; to: string; kind: string }[];
  summary: {
    models: number;
    pipelines: number;
    checks: number;
    charts: number;
    dashboards: number;
  };
}
export interface ActivityEntry {
  id: number;
  at: number;
  action: string;
  entity_id: string;
  actor_id: string | null;
  actor_name: string | null;
  summary: string;
}
export interface ActivityFilter {
  before_id?: number;
  limit?: number;
  action_prefix?: string;
  actor?: string;
  entity?: string;
}
export interface EngineNotification {
  id: string;
  created_at: number;
  severity: 'info' | 'warn' | 'error';
  kind: string;
  title: string;
  body: string;
  entity_kind: string;
  entity_id: string;
  read: boolean;
}
export class ApiError extends Error {
  status: number;
  validation?: PipelineValidation;
  constructor(status: number, message: string, validation?: PipelineValidation) {
    super(message);
    this.status = status;
    this.validation = validation;
  }
}
const params = (values: object) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') search.set(key, String(value));
  return search.size ? '?' + search : '';
};

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
  async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    binary = false,
  ): Promise<T> {
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
      const error = (await response.json().catch(() => null)) as
        ({ error?: string } & Partial<PipelineValidation>) | null;
      throw new ApiError(
        response.status,
        error?.error ||
          error?.errors?.map((e) => e.message).join('; ') ||
          'Engine request failed (' + response.status + ')',
        error?.valid === false ? (error as PipelineValidation) : undefined,
      );
    }
    if (response.status === 204 || (response.status === 202 && path.endsWith('/cancel')))
      return undefined as T;
    if (binary) return response.arrayBuffer() as Promise<T>;
    return response.json() as Promise<T>;
  }
  return {
    pipelines: () => request<Pipeline[]>('/v1/pipelines'),
    pipeline: (id: string) => request<PipelineGraph>('/v1/pipelines/' + idPath(id)),
    createPipeline: (body: PipelineInput) => request<PipelineGraph>('/v1/pipelines', 'POST', body),
    updatePipeline: (id: string, body: PipelineInput) =>
      request<PipelineGraph>('/v1/pipelines/' + idPath(id), 'PUT', body),
    deletePipeline: (id: string) => request<void>('/v1/pipelines/' + idPath(id), 'DELETE'),
    validatePipeline: (body: PipelineInput) =>
      request<PipelineValidation>('/v1/pipelines/validate', 'POST', body),
    runPipeline: (id: string) =>
      request<{ id: string }>('/v1/pipelines/' + idPath(id) + '/run', 'POST'),
    pipelineRuns: (id: string, limit = 50) =>
      request<PipelineRun[]>('/v1/pipelines/' + idPath(id) + '/runs' + params({ limit })),
    pipelineRun: (id: string) => request<PipelineRunDetail>('/v1/pipeline-runs/' + idPath(id)),
    cancelPipelineRun: (id: string) =>
      request<void>('/v1/pipeline-runs/' + idPath(id) + '/cancel', 'POST'),
    qualityChecks: () => request<QualityCheck[]>('/v1/quality/checks'),
    qualityCheck: (id: string) => request<QualityCheck>('/v1/quality/checks/' + idPath(id)),
    createQualityCheck: (body: QualityInput) =>
      request<QualityCheck>('/v1/quality/checks', 'POST', body),
    updateQualityCheck: (id: string, body: QualityInput) =>
      request<QualityCheck>('/v1/quality/checks/' + idPath(id), 'PUT', body),
    deleteQualityCheck: (id: string) => request<void>('/v1/quality/checks/' + idPath(id), 'DELETE'),
    runQualityCheck: (id: string) =>
      request<QualityRun>('/v1/quality/checks/' + idPath(id) + '/run', 'POST'),
    qualityCheckRuns: (id: string, limit = 50) =>
      request<QualityRun[]>('/v1/quality/checks/' + idPath(id) + '/runs' + params({ limit })),
    qualityRuns: (limit = 50) => request<QualityRun[]>('/v1/quality/runs' + params({ limit })),
    qualitySummary: () => request<QualitySummary>('/v1/quality/summary'),
    charts: () => request<Chart[]>('/v1/charts'),
    chart: (id: string) => request<Chart>('/v1/charts/' + idPath(id)),
    createChart: (body: ChartInput) => request<Chart>('/v1/charts', 'POST', body),
    updateChart: (id: string, body: ChartInput) =>
      request<Chart>('/v1/charts/' + idPath(id), 'PUT', body),
    deleteChart: (id: string) => request<void>('/v1/charts/' + idPath(id), 'DELETE'),
    chartData: (id: string, range: ChartRange = {}) =>
      request<ChartData>('/v1/charts/' + idPath(id) + '/data', 'POST', range),
    previewChart: (body: { sql: string; config: ChartConfig } & ChartRange) =>
      request<ChartData>('/v1/charts/preview', 'POST', body),
    drillChart: (id: string, body: { x_value: SqlCell } & ChartRange) =>
      request<ChartData>('/v1/charts/' + idPath(id) + '/drill', 'POST', body),
    dashboards: () => request<AnalyticsDashboard[]>('/v1/dashboards'),
    dashboard: (id: string) => request<AnalyticsDashboard>('/v1/dashboards/' + idPath(id)),
    createDashboard: (body: DashboardInput) =>
      request<AnalyticsDashboard>('/v1/dashboards', 'POST', body),
    updateDashboard: (id: string, body: DashboardInput) =>
      request<AnalyticsDashboard>('/v1/dashboards/' + idPath(id), 'PUT', body),
    deleteDashboard: (id: string) => request<void>('/v1/dashboards/' + idPath(id), 'DELETE'),
    columnLineage: (query: ColumnRef & { direction?: ImpactDirection; depth?: number }) =>
      request<ColumnGraph>(
        '/v1/lineage/columns' +
          params({
            dataset: query.dataset_id,
            column: query.column,
            direction: query.direction ?? 'both',
            depth: query.depth ?? 50,
          }),
      ),
    lineageImpact: (query: ImpactRequest) =>
      request<ImpactGraph>('/v1/lineage/impact' + params(query)),
    activity: (query: ActivityFilter = {}) =>
      request<ActivityEntry[]>('/v1/activity' + params(query)),
    notifications: (query: { unread?: boolean; limit?: number } = {}) =>
      request<EngineNotification[]>('/v1/notifications' + params(query)),
    readNotifications: (body: { ids?: string[]; all?: boolean }) =>
      request<void>('/v1/notifications/read', 'POST', body),
    notificationCount: () => request<{ count: number }>('/v1/notifications/unread-count'),
    keys: () => request<DatasetKey[]>('/v1/admin/keys'),
    rotateKek: () => request<{ kek_version: number }>('/v1/admin/keys/rotate-kek', 'POST'),
    rotateDatasetKey: (target: string) =>
      request<{ ok: boolean }>('/v1/admin/keys/rotate/' + idPath(target), 'POST'),
    verifyAudit: () => request<AuditVerification>('/v1/audit/verify'),
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
    explorerTree: () => request<ExplorerTree>('/v1/explorer/tree'),
    explorerRows: (body: ExplorerRequest) =>
      request<ExplorerRows>('/v1/explorer/rows', 'POST', body),
    explorerExport: (body: ExplorerRequest & { format: 'csv' | 'parquet'; max_rows?: number }) =>
      request<ArrayBuffer>('/v1/explorer/export', 'POST', body, true),
    storage: () => request<StorageUsage>('/v1/storage'),
    savedQueries: () => request<SavedQuery[]>('/v1/saved-queries'),
    createSavedQuery: (body: SavedQueryInput) =>
      request<SavedQuery>('/v1/saved-queries', 'POST', body),
    updateSavedQuery: (id: string, body: SavedQueryInput) =>
      request<SavedQuery>('/v1/saved-queries/' + idPath(id), 'PUT', body),
    deleteSavedQuery: (id: string) => request<void>('/v1/saved-queries/' + idPath(id), 'DELETE'),
    cancelSql: (id: string) => request<void>('/v1/sql/cancel/' + idPath(id), 'POST'),
    sqlQuery: (query: string, limit = 1000, query_id?: string) =>
      request<SqlResult>('/v1/sql', 'POST', {
        query,
        limit,
        ...(query_id ? { query_id } : {}),
      }),
    sqlExplain: (query: string) => request<SqlExplain>('/v1/sql/explain', 'POST', { query }),
    sqlTables: () => request<{ tables: SqlTable[] }>('/v1/sql/tables'),
    health: () => request<{ ok: boolean }>('/health'),
    status: () => request<Status>('/v1/status'),
    advisor: (source = '') =>
      request<{ recommendations: AdvisorRecommendation[]; sources: AdvisorSource[] }>(
        '/v1/advisor' + (source ? '?source=' + idPath(source) : ''),
      ),
    refreshAdvisor: (source: string) =>
      request<{ recommendations: number; warnings: string[] }>(
        '/v1/advisor/refresh?source=' + idPath(source),
        'POST',
      ),
    applyAdvice: (id: string, approval_token: string) =>
      request<{ ok: boolean }>('/v1/advisor/' + idPath(id) + '/apply', 'POST', { approval_token }),
    rollbackAdvice: (id: string, approval_token: string) =>
      request<{ ok: boolean }>('/v1/advisor/' + idPath(id) + '/rollback', 'POST', {
        approval_token,
      }),
    dismissAdvice: (id: string) =>
      request<{ ok: boolean }>('/v1/advisor/' + idPath(id) + '/dismiss', 'POST'),
    datasetOptimization: (id: string) =>
      request<DatasetOptimization>('/v1/optimizer/datasets/' + idPath(id)),
    relayoutDataset: (id: string) =>
      request<{ ok: boolean }>('/v1/optimizer/datasets/' + idPath(id) + '/relayout', 'POST'),
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
export interface AdvisorRecommendation {
  id: string;
  source_id: string;
  dataset_id: string | null;
  target: string;
  kind: string;
  ddl: string;
  rollback_ddl: string;
  evidence: Record<string, unknown>;
  estimated_benefit: number;
  cost: string;
  risk: string;
  required_permission: string;
  applicable: boolean;
  approval_token: string;
  status: 'open' | 'dismissed' | 'applying' | 'applied' | 'failed' | 'rolled_back';
  applied_by: string | null;
  applied_at: number | null;
  error: string | null;
}
export interface AdvisorSource {
  id: string;
  name: string;
  kind: string;
  advisor_may_write: boolean;
  connection_target: string;
}
export interface DatasetOptimization {
  dataset_id: string;
  name: string;
  source_id: string;
  stats: {
    column: string;
    role: string;
    op: string;
    count: number;
    rows_scanned: number;
    rows_returned: number;
    elapsed_ms: number;
    last_seen: number;
  }[];
  layout: {
    sort_column: string | null;
    bloom_columns: string[];
    row_group_size: number;
    reason: string;
    updated_at: number;
  } | null;
  next_layout: { sort_column: string | null; reason: string };
  hash_index: { enabled: boolean; reason: string };
  metrics_note: string;
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
