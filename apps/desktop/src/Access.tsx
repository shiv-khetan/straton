import { useCallback, useEffect, useState } from 'react';
import type {
  Api,
  Dataset,
  Grant,
  MaskKind,
  Policies,
  Privilege,
  Role,
  Source,
  TokenInfo,
  User,
} from './api';
import { Button, Tray, EmptyState, Pill, Sheet, Table, Tabs, Toast } from './ui';
import { Field } from './App';
import { Skeleton } from './Workbench';
import { setMask } from './access-model';
import { datasetLabel, relativeTime } from './view-model';
const emptyPolicies: Policies = { row_filters: [], masks: [] };
export default function Access({
  client,
  sources,
  datasets,
  onChanged,
}: {
  client: Api;
  sources: Source[];
  datasets: Dataset[];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState('Users');
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [grants, setGrants] = useState<Grant[]>([]);
  const [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [userName, setUserName] = useState(''),
    [roleName, setRoleName] = useState('');
  const [selectedUser, setSelectedUser] = useState(''),
    [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [tokenName, setTokenName] = useState(''),
    [expires, setExpires] = useState(''),
    [secret, setSecret] = useState('');
  const [selectedRole, setSelectedRole] = useState(''),
    [target, setTarget] = useState(''),
    [privilege, setPrivilege] = useState<Privilege>('read');
  const [dataset, setDataset] = useState(''),
    [policies, setPolicies] = useState<Policies>(emptyPolicies),
    [policyReady, setPolicyReady] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({}),
    [validation, setValidation] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void Promise.all([client.users(), client.roles(), client.grants()])
      .then(([u, r, g]) => {
        if (active) {
          setLoading(false);
          setUsers(u);
          setRoles(r);
          setGrants(g);
        }
      })
      .catch((e) => {
        if (active) {
          setLoading(false);
          setError(String(e));
        }
      });
    return () => {
      active = false;
    };
  }, [client, revision]);
  useEffect(() => {
    let active = true;
    setTokens([]);
    if (selectedUser)
      void client
        .tokens(selectedUser)
        .then((t) => {
          if (active) setTokens(t);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [client, selectedUser, revision]);
  useEffect(() => {
    let active = true;
    setPolicyReady(false);
    setPolicies(emptyPolicies);
    setFilters({});
    setValidation({});
    if (dataset)
      void client
        .policies(dataset)
        .then((p) => {
          if (active) {
            setPolicies(p);
            setFilters(Object.fromEntries(p.row_filters.map((f) => [f.role_id, f.predicate])));
            setPolicyReady(true);
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [client, dataset, revision]);
  const work = useCallback(
    async (fn: () => Promise<unknown>, text: string, refresh = true) => {
      setBusy(true);
      setError('');
      setMessage('');
      try {
        await fn();
        setMessage(text);
        if (refresh) {
          setRevision((r) => r + 1);
          onChanged();
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );
  const selected = users.find((u) => u.id === selectedUser);
  const currentDataset = datasets.find((d) => d.id === dataset);
  const roleLabel = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const targetLabel = (g: Grant) =>
    g.target_kind === 'source'
      ? (sources.find((s) => s.id === g.target_id)?.name ?? g.target_id)
      : datasetLabel(datasets.find((d) => d.id === g.target_id)) || g.target_id;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Access</h1>
          <p className="hint">Manage people, their permissions, and the data they can see.</p>
        </div>
      </div>
      {error && <Toast error message={error} onClose={() => setError('')} />}
      {message && <Toast message={message} onClose={() => setMessage('')} />}
      {loading && <Skeleton label="Loading access settings…" />}
      <Tabs id="access" items={['Users', 'Roles', 'Policies']} value={tab} onChange={setTab} />
      <section role="tabpanel" id={'access-panel-' + tab} aria-labelledby={'access-tab-' + tab}>
        {tab === 'Users' && (
          <Tray title="Users">
            <form
              className="access-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void work(async () => {
                  await client.createUser(userName);
                  setUserName('');
                }, 'User created');
              }}
            >
              <Field label="New user name">
                <input
                  required
                  autoComplete="off"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="primary" disabled={busy}>
                Create user
              </Button>
            </form>
            <Table label="Users">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Roles</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>
                      <Pill tone={u.disabled ? 'neutral' : 'success'}>
                        {u.disabled ? 'Disabled' : 'Active'}
                      </Pill>
                    </td>
                    <td>
                      <fieldset className="access-roles">
                        <legend className="visually-hidden">Roles for {u.name}</legend>
                        {roles.map((r) => (
                          <label key={r.id}>
                            <input
                              type="checkbox"
                              disabled={busy || u.id === 'admin'}
                              checked={u.role_ids.includes(r.id)}
                              onChange={(e) =>
                                void work(
                                  () =>
                                    client.assignRoles(
                                      u.id,
                                      e.target.checked
                                        ? [...u.role_ids, r.id]
                                        : u.role_ids.filter((id) => id !== r.id),
                                    ),
                                  'Roles updated',
                                )
                              }
                            />
                            {r.name}
                          </label>
                        ))}
                      </fieldset>
                    </td>
                    <td>
                      <div className="actions">
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setSelectedUser(u.id);
                            setTokenName('');
                            setExpires('');
                            setSecret('');
                          }}
                        >
                          Tokens
                        </Button>
                        {u.id !== 'admin' && (
                          <Button
                            disabled={busy}
                            variant={u.disabled ? 'ghost' : 'danger'}
                            onClick={() =>
                              void work(
                                () => client.updateUser(u, !u.disabled),
                                u.disabled ? 'User enabled' : 'User disabled',
                              )
                            }
                          >
                            {u.disabled ? 'Enable' : 'Disable'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Tray>
        )}
        {tab === 'Roles' && (
          <Tray title="Roles">
            <form
              className="access-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void work(async () => {
                  await client.createRole(roleName);
                  setRoleName('');
                }, 'Role created');
              }}
            >
              <Field label="New role name">
                <input required value={roleName} onChange={(e) => setRoleName(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" disabled={busy}>
                Create role
              </Button>
            </form>
            <Table label="Roles">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Scope</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>
                      {r.is_admin
                        ? 'Global administrator'
                        : grants.filter((g) => g.role_id === r.id).length + ' grants'}
                    </td>
                    <td>
                      <div className="actions">
                        <Button onClick={() => setSelectedRole(r.id)}>Edit grants</Button>
                        {!r.is_admin && (
                          <Button
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                              void work(async () => {
                                await client.deleteRole(r.id);
                                if (selectedRole === r.id) setSelectedRole('');
                              }, 'Role deleted')
                            }
                          >
                            Delete role
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <h2>Grants</h2>
            <Field label="Role">
              <select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value)}>
                <option value="">Choose role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            {selectedRole && (
              <>
                <p className="hint">
                  Source grants include every dataset in that source. Admin grants include read and
                  sync administration on their target.
                </p>
                {roles.find((r) => r.id === selectedRole)?.is_admin && (
                  <p className="hint">This built-in role already has global administration.</p>
                )}
                <form
                  className="access-inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const [kind, ...id] = target.split(':');
                    void work(
                      () =>
                        client.createGrant({
                          role_id: selectedRole,
                          target_kind: kind as 'source' | 'dataset',
                          target_id: id.join(':'),
                          privilege,
                        }),
                      'Grant created',
                    );
                  }}
                >
                  <Field label="Target">
                    <select required value={target} onChange={(e) => setTarget(e.target.value)}>
                      <option value="">Choose source or dataset</option>
                      <optgroup label="Sources">
                        {sources.map((s) => (
                          <option key={s.id} value={'source:' + s.id}>
                            {s.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Datasets">
                        {datasets.map((d) => (
                          <option key={d.id} value={'dataset:' + d.id}>
                            {datasetLabel(d)}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </Field>
                  <Field label="Privilege">
                    <select
                      value={privilege}
                      onChange={(e) => setPrivilege(e.target.value as Privilege)}
                    >
                      {['read', 'sync_admin', 'admin'].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </Field>
                  <Button type="submit" variant="primary" disabled={busy}>
                    Add grant
                  </Button>
                </form>
                <Table label="Role grants">
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>Privilege</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grants
                      .filter((g) => g.role_id === selectedRole)
                      .map((g) => (
                        <tr key={g.id}>
                          <td>
                            {g.target_kind}: {targetLabel(g)}
                          </td>
                          <td>
                            <code>{g.privilege}</code>
                          </td>
                          <td>
                            <Button
                              variant="danger"
                              disabled={busy}
                              onClick={() =>
                                void work(() => client.deleteGrant(g.id), 'Grant removed')
                              }
                            >
                              Remove grant
                            </Button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </Table>
              </>
            )}
          </Tray>
        )}
        {tab === 'Policies' && (
          <Tray title="Policies">
            <Field label="Dataset">
              <select
                value={dataset}
                onChange={(e) => {
                  setPolicyReady(false);
                  setDataset(e.target.value);
                }}
              >
                <option value="">Choose dataset</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {datasetLabel(d)}
                  </option>
                ))}
              </select>
            </Field>
            {!dataset ? (
              <EmptyState>Choose a dataset to edit its row filters and column masks.</EmptyState>
            ) : !policyReady ? (
              <p role="status">Loading policies…</p>
            ) : (
              <>
                <h2>Row filters</h2>
                <p className="hint">
                  Filters from read-granting roles combine with OR. A read-granting role without a
                  filter allows all rows.
                </p>
                {roles.map((r) => (
                  <div className="access-policy" key={r.id}>
                    <Field label={r.name + ' row predicate'}>
                      <textarea
                        rows={2}
                        className="mono"
                        placeholder="No filter — all rows"
                        value={filters[r.id] ?? ''}
                        onChange={(e) => {
                          setFilters((p) => ({ ...p, [r.id]: e.target.value }));
                          setValidation((v) => ({ ...v, [r.id]: '' }));
                        }}
                      />
                    </Field>
                    <div className="actions">
                      <Button
                        disabled={busy || !filters[r.id]?.trim()}
                        onClick={() =>
                          void work(
                            async () => {
                              const result = await client.validatePolicy(dataset, filters[r.id]);
                              setValidation((v) => ({
                                ...v,
                                [r.id]: result.ok
                                  ? 'Valid predicate'
                                  : (result.error ?? 'Invalid predicate'),
                              }));
                            },
                            '',
                            false,
                          )
                        }
                      >
                        Validate
                      </Button>
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() =>
                          void work(
                            () =>
                              client.rowFilter(
                                dataset,
                                r.id,
                                filters[r.id]?.trim() ? filters[r.id] : null,
                              ),
                            'Row filter saved',
                          )
                        }
                      >
                        Save filter
                      </Button>
                      <Button
                        disabled={busy || !policies.row_filters.some((f) => f.role_id === r.id)}
                        onClick={() =>
                          void work(
                            () => client.rowFilter(dataset, r.id, null),
                            'Row filter removed',
                          )
                        }
                      >
                        Remove filter
                      </Button>
                    </div>
                    {validation[r.id] && <p role="status">{validation[r.id]}</p>}
                  </div>
                ))}
                <h2>Column masks</h2>
                <p className="hint">
                  A column is masked only when every read-granting role masks it. If all do, the
                  strictest kind wins: null, redact, hash, then last4.
                </p>
                <Table label="Column masks by role">
                  <thead>
                    <tr>
                      <th>Role</th>
                      {currentDataset?.columns.map((c) => (
                        <th key={c.name}>
                          <code>{c.name}</code>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">{roleLabel(r.id)}</th>
                        {currentDataset?.columns.map((c) => (
                          <td key={c.name}>
                            <select
                              aria-label={r.name + ' mask for ' + c.name}
                              disabled={busy}
                              value={
                                policies.masks.find(
                                  (m) => m.role_id === r.id && m.column === c.name,
                                )?.kind ?? ''
                              }
                              onChange={(e) => {
                                const kind = e.target.value as MaskKind | '';
                                void work(
                                  async () => {
                                    await client.mask(dataset, r.id, c.name, kind || null);
                                    setPolicies((p) => ({
                                      ...p,
                                      masks: setMask(p.masks, r.id, c.name, kind || null),
                                    }));
                                    onChanged();
                                  },
                                  'Mask saved',
                                  false,
                                );
                              }}
                            >
                              <option value="">Visible</option>
                              {['null', 'redact', 'hash', 'last4'].map((k) => (
                                <option key={k}>{k}</option>
                              ))}
                            </select>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </Tray>
        )}
      </section>
      <Sheet
        open={!!selectedUser}
        title={'Tokens · ' + (selected?.name ?? '')}
        onClose={() => {
          setSelectedUser('');
          setSecret('');
        }}
      >
        <p className="hint">
          Issue a separate token for each client. Revocation takes effect on the next request or SQL
          statement.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () => {
              const issued = await client.issueToken(
                selectedUser,
                tokenName,
                expires ? Math.floor(new Date(expires).getTime() / 1000) : null,
              );
              setSecret(issued.token);
              setTokenName('');
            }, 'Token issued');
          }}
        >
          <Field label="Token name">
            <input
              required
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Expires at (optional, local time)">
            <input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || selected?.disabled}>
            Issue token
          </Button>
        </form>
        <h3>Existing tokens</h3>
        <Table label="User tokens">
          <thead>
            <tr>
              <th>Name</th>
              <th>Last used</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.last_used_at ? relativeTime(t.last_used_at * 1000) : 'Never'}</td>
                <td>
                  {t.revoked_at
                    ? 'Revoked'
                    : t.expires_at && t.expires_at * 1000 <= Date.now()
                      ? 'Expired'
                      : 'Active'}
                </td>
                <td>
                  <Button
                    variant="danger"
                    disabled={busy || !!t.revoked_at}
                    onClick={() =>
                      void work(() => client.revokeToken(selectedUser, t.id), 'Token revoked')
                    }
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Sheet>
      <Sheet open={!!secret} title="Save your token" onClose={() => setSecret('')}>
        <p role="alert">
          Copy this token now. It is shown only once and cannot be recovered. Keep it secret.
        </p>
        <Field label="New token">
          <textarea readOnly rows={3} value={secret} autoComplete="off" spellCheck={false} />
        </Field>
        <Button
          variant="primary"
          onClick={() =>
            void work(() => navigator.clipboard.writeText(secret), 'Token copied', false)
          }
        >
          Copy token
        </Button>
        <Button onClick={() => setSecret('')}>I have saved the token</Button>
      </Sheet>
    </>
  );
}
