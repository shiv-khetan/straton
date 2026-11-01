import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Api, Role, User } from '@/lib/api';
import { Button, StatePill, Table, Tray } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import type { Work } from './Access';

export function UsersTab({
  client,
  users,
  roles,
  busy,
  work,
  onTokens,
}: {
  client: Api;
  users: User[];
  roles: Role[];
  busy: boolean;
  work: Work;
  onTokens: (userId: string) => void;
}) {
  const [userName, setUserName] = useState('');
  return (
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
          <Input
            required
            autoComplete="off"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="default" disabled={busy}>
          Create user
        </Button>
      </form>
      <Table label="Users">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Roles</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.name}</TableCell>
              <TableCell>
                <StatePill state={u.disabled ? 'Disabled' : 'Active'} />
              </TableCell>
              <TableCell>
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
              </TableCell>
              <TableCell>
                <div className="actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onTokens(u.id)}
                  >
                    Tokens
                  </Button>
                  {u.id !== 'admin' && (
                    <Button
                      type="button"
                      disabled={busy}
                      variant={u.disabled ? 'ghost' : 'destructive'}
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Tray>
  );
}
