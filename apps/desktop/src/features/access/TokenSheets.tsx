import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import type { Api, TokenInfo, User } from '@/lib/api';
import { Button, Sheet, Table } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import { relativeTime } from '@/lib/view-model';
import type { Work } from './Access';

// Token list and issue form for one user, plus the one-time sheet that reveals a new secret.
export function TokenSheets({
  client,
  userId,
  user,
  revision,
  busy,
  work,
  onClose,
  onError,
}: {
  client: Api;
  userId: string;
  user?: User;
  revision: number;
  busy: boolean;
  work: Work;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [tokenName, setTokenName] = useState('');
  const [expires, setExpires] = useState('');
  const [secret, setSecret] = useState('');
  useEffect(() => {
    setTokenName('');
    setExpires('');
    setSecret('');
  }, [userId]);
  useEffect(() => {
    let active = true;
    setTokens([]);
    if (userId)
      void client
        .tokens(userId)
        .then((t) => {
          if (active) setTokens(t);
        })
        .catch((e) => {
          if (active) onError(String(e));
        });
    return () => {
      active = false;
    };
  }, [client, userId, revision]);
  return (
    <>
      <Sheet
        open={!!userId}
        title={'Tokens · ' + (user?.name ?? '')}
        onClose={() => {
          onClose();
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
                userId,

                tokenName,
                expires ? Math.floor(new Date(expires).getTime() / 1000) : null,
              );
              setSecret(issued.token);
              setTokenName('');
            }, 'Token issued');
          }}
        >
          <Field label="Token name">
            <Input
              required
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Expires at (optional, local time)">
            <Input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="default" disabled={busy || user?.disabled}>
            Issue token
          </Button>
        </form>
        <h3>Existing tokens</h3>
        <Table label="User tokens">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.name}</TableCell>
                <TableCell>
                  {t.last_used_at ? relativeTime(t.last_used_at * 1000) : 'Never'}
                </TableCell>
                <TableCell>
                  {t.revoked_at
                    ? 'Revoked'
                    : t.expires_at && t.expires_at * 1000 <= Date.now()
                      ? 'Expired'
                      : 'Active'}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy || !!t.revoked_at}
                    onClick={() =>
                      void work(() => client.revokeToken(userId, t.id), 'Token revoked')
                    }
                  >
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Sheet>
      <Sheet open={!!secret} title="Save your token" onClose={() => setSecret('')}>
        <p role="alert">
          Copy this token now. It is shown only once and cannot be recovered. Keep it secret.
        </p>
        <Field label="New token">
          <Textarea readOnly rows={3} value={secret} autoComplete="off" spellCheck={false} />
        </Field>
        <Button
          type="button"
          variant="default"
          onClick={() =>
            void work(() => navigator.clipboard.writeText(secret), 'Token copied', false)
          }
        >
          Copy token
        </Button>
        <Button type="button" variant="ghost" onClick={() => setSecret('')}>
          I have saved the token
        </Button>
      </Sheet>
    </>
  );
}
