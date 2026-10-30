import { useState } from 'react';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { Input } from '@/components/ui/input';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Api, Dataset, Grant, Privilege, Role, Source } from '@/lib/api';
import { Button, Table, Tray } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import { datasetLabel } from '@/lib/view-model';
import type { Work } from './Access';

// Roles and the grants each one gives on sources and datasets.
export function RolesTab({
  client,
  roles,
  grants,
  sources,
  datasets,
  busy,
  work,
}: {
  client: Api;
  roles: Role[];
  grants: Grant[];
  sources: Source[];
  datasets: Dataset[];
  busy: boolean;
  work: Work;
}) {
  const [roleName, setRoleName] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [target, setTarget] = useState('');
  const [privilege, setPrivilege] = useState<Privilege>('read');
  const targetLabel = (g: Grant) =>
    g.target_kind === 'source'
      ? (sources.find((s) => s.id === g.target_id)?.name ?? g.target_id)
      : datasetLabel(datasets.find((d) => d.id === g.target_id)) || g.target_id;
  return (
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
          <Input required value={roleName} onChange={(e) => setRoleName(e.target.value)} />
        </Field>
        <Button type="submit" variant="default" disabled={busy}>
          Create role
        </Button>
      </form>
      <Table label="Roles">
        <TableHeader>
          <TableRow>
            <TableHead>Role</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {roles.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.name}</TableCell>
              <TableCell>
                {r.is_admin
                  ? 'Global administrator'
                  : grants.filter((g) => g.role_id === r.id).length + ' grants'}
              </TableCell>
              <TableCell>
                <div className="actions">
                  <Button type="button" variant="ghost" onClick={() => setSelectedRole(r.id)}>
                    Edit grants
                  </Button>
                  {!r.is_admin && (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          !(await confirmDialog(
                            'Delete role “' + r.name + '”? Members lose every grant it gives them.',
                            { title: 'Delete role', kind: 'warning' },
                          ))
                        )
                          return;
                        void work(async () => {
                          await client.deleteRole(r.id);
                          if (selectedRole === r.id) setSelectedRole('');
                        }, 'Role deleted');
                      }}
                    >
                      Delete role
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
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
            Source grants include every dataset in that source. Admin grants include read and sync
            administration on their target.
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
              <select value={privilege} onChange={(e) => setPrivilege(e.target.value as Privilege)}>
                {['read', 'sync_admin', 'admin'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="default" disabled={busy}>
              Add grant
            </Button>
          </form>
          <Table label="Role grants">
            <TableHeader>
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead>Privilege</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants
                .filter((g) => g.role_id === selectedRole)
                .map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      {g.target_kind}: {targetLabel(g)}
                    </TableCell>
                    <TableCell>
                      <code>{g.privilege}</code>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={busy}
                        onClick={async () => {
                          if (
                            !(await confirmDialog(
                              'Remove the ' +
                                g.privilege +
                                ' grant? This role loses that access immediately.',
                              { title: 'Remove grant', kind: 'warning' },
                            ))
                          )
                            return;
                          void work(() => client.deleteGrant(g.id), 'Grant removed');
                        }}
                      >
                        Remove grant
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </>
      )}
    </Tray>
  );
}
