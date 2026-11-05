import { useQuery } from '@tanstack/react-query';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Api } from '@/lib/api';
import { Button, EmptyState, StatePill, Table, Tray } from '@/components/workbench/primitives';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { relativeTime } from '@/lib/view-model';

// Addresses that presented rejected tokens recently (HTTP API and SQL endpoint). Detection
// only: tokens are 256-bit, so this points at leaked or revoked tokens still in use.
export function AuthFailures({ client, revision }: { client: Api; revision: number }) {
  const failures = useQuery({
    queryKey: ['engine', 'admin', 'auth-failures', revision],
    queryFn: () => client.authFailures(),
    refetchInterval: 60_000,
  });
  const data = failures.data;
  const minutes = data ? Math.round(data.window_secs / 60) : 10;
  return (
    <Tray title="Failed sign-ins">
      <p className="hint">
        Rejected tokens per address over the last {minutes} minutes, from the HTTP API and the SQL
        endpoint.{' '}
        {data && (
          <>
            At {data.threshold} failures the engine notifies admins and records an audit entry.
            Addresses are never blocked.
          </>
        )}
      </p>
      {failures.isPending ? (
        <Skeleton label="Loading failed sign-ins…" />
      ) : failures.isError ? (
        <div role="alert">
          <p>Could not load failed sign-ins. {String(failures.error)}</p>
          <Button variant="outline" onClick={() => void failures.refetch()}>
            Retry
          </Button>
        </div>
      ) : !data?.addresses.length ? (
        <EmptyState>No failed sign-ins in the last {minutes} minutes.</EmptyState>
      ) : (
        <Table label="Failed sign-ins by address">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Address</TableHead>
              <TableHead scope="col">Failures</TableHead>
              <TableHead scope="col">Endpoint</TableHead>
              <TableHead scope="col">First</TableHead>
              <TableHead scope="col">Last</TableHead>
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.addresses.map((a) => (
              <TableRow key={a.address}>
                <TableCell>
                  <code>{a.address}</code>
                </TableCell>
                <TableCell className="tabular-nums">{a.failures.toLocaleString()}</TableCell>
                <TableCell>{a.surface === 'sql' ? 'SQL endpoint' : 'HTTP API'}</TableCell>
                <TableCell title={new Date(a.first_at * 1000).toLocaleString()}>
                  {relativeTime(a.first_at * 1000)}
                </TableCell>
                <TableCell title={new Date(a.last_at * 1000).toLocaleString()}>
                  {relativeTime(a.last_at * 1000)}
                </TableCell>
                <TableCell>
                  <StatePill
                    state={a.alerted ? 'warning' : 'pending'}
                    label={a.alerted ? 'Admins notified' : 'Below threshold'}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Tray>
  );
}
