import {
  Table as DataTable,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import type { Api, Dataset, Me, Status } from '@/lib/api';
import { Tray } from '@/components/workbench/primitives';
import { backupTime, relativeTime } from '@/lib/view-model';
import Security from './Security';
export default function Backups({
  client,
  backups,
  status,
  datasets,
  me,
  readOnly,
  revision,
  onChanged,
}: {
  client: Api;
  backups: string[];
  status: Status | null;
  datasets: Dataset[];
  me: Me | null;
  readOnly: boolean;
  revision: number;
  onChanged: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Backups</h1>
          <p className="hint">Engine snapshots, ready when you need them.</p>
        </div>
      </div>
      <Tray title="Engine backups">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Engine backups">
          <DataTable>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Filename</TableHead>
                <TableHead scope="col">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((path) => {
                const time = backupTime(path);
                return (
                  <TableRow key={path}>
                    <TableCell title={path}>
                      <code>{path.split(/[\\/]/).pop()}</code>
                    </TableCell>
                    <TableCell title={time ? new Date(time).toLocaleString() : path}>
                      {relativeTime(time)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </DataTable>
        </div>
        {!backups.length && (
          <p className="empty">No backups yet. Create your first snapshot with Back up now.</p>
        )}
      </Tray>
      {me?.privileges.admin && (
        <Security
          client={client}
          status={status}
          datasets={datasets}
          readOnly={readOnly}
          revision={revision}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
