import { useCallback, useEffect, useState } from 'react';
import type { Api, Dataset, Grant, Role, Source, User } from '@/lib/api';
import { Feedback } from '@/components/workbench/primitives';
import { Skeleton } from '@/features/console/ConsoleDrawer';
import { PoliciesTab } from './PoliciesTab';
import { RolesTab } from './RolesTab';
import { TokenSheets } from './TokenSheets';
import { UsersTab } from './UsersTab';
import { PageTabs } from '@/components/workbench/page-layout';
export type Work = (fn: () => Promise<unknown>, text: string, refresh?: boolean) => Promise<void>;
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
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
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
  return (
    <>
      <PageTabs id="access" items={['Users', 'Roles', 'Policies']} value={tab} onChange={setTab} />
      {error && <Feedback error message={error} onClose={() => setError('')} />}
      {message && <Feedback message={message} onClose={() => setMessage('')} />}
      {loading && <Skeleton label="Loading access settings…" />}
      <section role="tabpanel" id={'access-panel-' + tab} aria-labelledby={'access-tab-' + tab}>
        {tab === 'Users' && (
          <UsersTab
            client={client}
            users={users}
            roles={roles}
            busy={busy}
            work={work}
            onTokens={setSelectedUser}
          />
        )}
        {tab === 'Roles' && (
          <RolesTab
            client={client}
            roles={roles}
            grants={grants}
            sources={sources}
            datasets={datasets}
            busy={busy}
            work={work}
          />
        )}
        {tab === 'Policies' && (
          <PoliciesTab
            client={client}
            datasets={datasets}
            roles={roles}
            busy={busy}
            work={work}
            onChanged={onChanged}
          />
        )}
      </section>
      <TokenSheets
        client={client}
        userId={selectedUser}
        user={users.find((u) => u.id === selectedUser)}
        revision={revision}
        busy={busy}
        work={work}
        onClose={() => setSelectedUser('')}
        onError={setError}
      />
    </>
  );
}
