import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Api, Connection, EngineSettings, Me } from '@/lib/api';
import { can } from '@/features/access/access-model';
import { FeatureError, FeatureLoading } from '@/components/workbench/FeatureState';
import { SegmentedControl, StatePill, Tray } from '@/components/workbench/primitives';
import { PageIntro } from '@/components/workbench/page-layout';
import { queryKeys } from '@/lib/queryKeys';
import { useThemeStore } from '@/stores/theme';
import type { ThemePreference } from '@/stores/theme';
import { usePreferences } from '@/stores/preferences';

const themes: Record<string, ThemePreference> = { System: 'system', Light: 'light', Dark: 'dark' };

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="settings-list">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
const on = (value: boolean, yes = 'Enabled', no = 'Disabled') => (
  <StatePill state={value ? 'enabled' : 'disabled'} label={value ? yes : no} />
);

/** Effective engine configuration, read-only: edit straton.toml or STRATON_* and restart. */
export function engineRows(s: EngineSettings): { title: string; rows: [string, ReactNode][] }[] {
  return [
    {
      title: 'Engine',
      rows: [
        ['Version', <code>{s.version}</code>],
        ['API address', <code>{s.bind}</code>],
        ['TLS', on(s.tls, 'Configured', 'Loopback only')],
        ['Data directory', <code>{s.data_dir}</code>],
        ['Concurrent runs', s.max_concurrent_runs],
        ['Attempts per run', s.max_attempts],
      ],
    },
    {
      title: 'SQL endpoint',
      rows: [
        ['Postgres wire', on(s.sql.enabled)],
        ['Address', <code>{s.sql.bind}</code>],
        ['Query timeout', s.sql.query_timeout_secs + ' s'],
        ['Row limit', s.sql.max_rows.toLocaleString()],
        ['Memory limit', s.sql.memory_limit_mb.toLocaleString() + ' MiB'],
      ],
    },
    {
      title: 'Security',
      rows: [
        ['Snapshot encryption', on(s.encryption.enabled)],
        [
          'Secret store',
          s.secret_store === 'kernel-keyring' ? (
            <span className="settings-warning">
              <StatePill state="warning" label="Lost on reboot" /> Linux kernel keyring. Set
              STRATON_SECRETS_DIR so the KEK and connector secrets survive a restart.
            </span>
          ) : s.secret_store === 'file' ? (
            'Owner-only files in the secrets directory'
          ) : (
            'OS keychain'
          ),
        ],
        [
          'Connector egress',
          s.network.allow_private
            ? 'Private networks allowed; metadata and link-local blocked'
            : 'Public addresses only',
        ],
      ],
    },
    {
      title: 'Backups',
      rows: [
        ['Schedule (UTC)', <code>{s.backup.cron}</code>],
        ['Directory', <code>{s.backup.dir}</code>],
        ['Snapshots kept', s.backup.keep],
      ],
    },
  ];
}

export default function Settings({
  client,
  me,
  connection,
}: {
  client: Api | null;
  me: Me | null;
  connection: Connection | null;
}) {
  const preference = useThemeStore((state) => state.preference);
  const setTheme = useThemeStore((state) => state.setTheme);
  const collapsed = usePreferences((state) => state.collapsed);
  const toggleCollapsed = usePreferences((state) => state.toggleCollapsed);
  const admin = can(me, 'admin');
  const engine = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => client!.engineSettings(),
    enabled: !!client && admin,
  });
  return (
    <div className="settings-page space-y-6">
      <PageIntro>
        Desktop preferences apply to this device. Engine settings are read from straton.toml and
        STRATON_* variables; change them there and restart the engine.
      </PageIntro>
      <Tray title="Desktop">
        <Rows
          rows={[
            [
              'Theme',
              <SegmentedControl
                label="Theme"
                items={Object.keys(themes)}
                value={Object.keys(themes).find((k) => themes[k] === preference) ?? 'System'}
                onChange={(label) => setTheme(themes[label])}
              />,
            ],
            [
              'Sidebar',
              <SegmentedControl
                label="Sidebar"
                items={['Expanded', 'Collapsed']}
                value={collapsed ? 'Collapsed' : 'Expanded'}
                onChange={(value) => {
                  if ((value === 'Collapsed') !== collapsed) toggleCollapsed();
                }}
              />,
            ],
          ]}
        />
      </Tray>
      <Tray title="Connection">
        <Rows
          rows={[
            ['Engine', <code>{connection?.url ?? 'Not connected'}</code>],
            ['Signed in as', me?.user.name ?? '—'],
            ['Roles', me?.roles.map((r) => r.name).join(', ') || '—'],
          ]}
        />
      </Tray>
      {admin &&
        (engine.isPending ? (
          <FeatureLoading label="Loading engine settings…" />
        ) : engine.isError ? (
          <FeatureError error={engine.error} retry={() => void engine.refetch()} />
        ) : (
          engineRows(engine.data).map((group) => (
            <Tray key={group.title} title={group.title}>
              <Rows rows={group.rows} />
            </Tray>
          ))
        ))}
    </div>
  );
}
