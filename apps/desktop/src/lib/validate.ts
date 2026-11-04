// Runtime checks for the engine responses the app trusts most: identity and privileges,
// and query results rendered straight into grids. A mismatched or compromised engine then
// fails with one clear message instead of crashing a view or showing wrong permissions.
// Hand-written on purpose: a handful of shapes do not justify a schema dependency.

export type Check<T> = (value: unknown, at: string) => T;

export class ResponseShapeError extends Error {
  readonly path: string;
  readonly problem: string;
  constructor(path: string, problem: string) {
    super(
      'The engine sent a response this app does not understand (' +
        path +
        ': ' +
        problem +
        '). Check that the desktop app and engine versions match.',
    );
    this.name = 'ResponseShapeError';
    this.path = path;
    this.problem = problem;
  }
}

const fail = (at: string, expected: string): never => {
  throw new TypeError(at + ' should be ' + expected);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const string: Check<string> = (v, at) => (typeof v === 'string' ? v : fail(at, 'text'));
export const number: Check<number> = (v, at) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail(at, 'a number');
export const boolean: Check<boolean> = (v, at) =>
  typeof v === 'boolean' ? v : fail(at, 'true or false');
export const cell: Check<string | number | boolean | null> = (v, at) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? v
    : fail(at, 'a single value');

export const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (v, at) =>
    v === null ? null : check(v, at);
export const oneOf =
  <const T extends readonly string[]>(...values: T): Check<T[number]> =>
  (v, at) =>
    typeof v === 'string' && values.includes(v) ? (v as T[number]) : fail(at, values.join(' or '));
export const arrayOf =
  <T>(check: Check<T>): Check<T[]> =>
  (v, at) =>
    Array.isArray(v) ? v.map((item, i) => check(item, at + '[' + i + ']')) : fail(at, 'a list');

type Shape = Record<string, Check<unknown>>;
type Checked<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
/** Checks the listed fields and keeps any others, so newer engines can add fields. */
export const object =
  <S extends Shape>(shape: S): Check<Checked<S>> =>
  (v, at) => {
    if (!isRecord(v)) return fail(at, 'an object');
    const out: Record<string, unknown> = { ...v };
    for (const key of Object.keys(shape)) out[key] = shape[key](v[key], at + '.' + key);
    return out as Checked<S>;
  };

/** Run `check` on a response body, turning a mismatch into a ResponseShapeError. */
export function validated<T>(path: string, check: Check<T>, value: unknown): T {
  try {
    return check(value, 'response');
  } catch (e) {
    if (e instanceof TypeError) throw new ResponseShapeError(path, e.message);
    throw e;
  }
}

const column = object({ name: string, type: string });
const rows = arrayOf(arrayOf(cell));

export const sqlResultShape = object({
  columns: arrayOf(column),
  rows,
  row_count: number,
  truncated_preview: boolean,
  elapsed_ms: number,
});
export const explorerRowsShape = object({
  columns: arrayOf(column),
  rows,
  offset: number,
  limit: number,
  total: number,
  total_exact: boolean,
});
export const tableProfileShape = object({
  schema: string,
  table: string,
  rows: number,
  columns: arrayOf(
    object({
      name: string,
      type: string,
      non_null: number,
      nulls: number,
      null_ratio: number,
      approx_distinct: nullable(number),
      min: cell,
      max: cell,
    }),
  ),
});
export const sqlTablesShape = object({
  tables: arrayOf(object({ schema: string, name: string, columns: arrayOf(column) })),
});
const role = object({ id: string, name: string, is_admin: boolean });
const grant = object({
  id: string,
  role_id: string,
  target_kind: oneOf('source', 'dataset'),
  target_id: string,
  privilege: oneOf('read', 'sync_admin', 'admin'),
});
export const meShape = object({
  user: object({ id: string, name: string, disabled: boolean, created_at: number }),
  roles: arrayOf(role),
  privileges: object({
    admin: boolean,
    read: boolean,
    sync_admin: boolean,
    grants: arrayOf(grant),
  }),
});
export const statusShape = object({
  version: string,
  uptime_seconds: number,
  queue_depth: number,
  last_backup: nullable(string),
  encryption_enabled: boolean,
  audit_head: string,
});
