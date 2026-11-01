import { Star } from 'lucide-react';
import type { Dataset, Model } from '@/lib/api';
import { can } from '@/features/access/access-model';
import { Breadcrumb, Button, Icon, Pill, StatePill } from '@/components/workbench/primitives';
import { Field } from '@/components/workbench/Field';
import { backupTime, relativeTime } from '@/lib/view-model';
import { StatusChip } from '@/features/console/ConsoleDrawer';
import { datasetState } from '@/features/console/workbench-model';
import type { Route } from '@/stores/route-history';
import { navItemOf, sectionLabels, sectionOf } from './navigation';
import type { useEngineData } from './useEngineData';
import { CronText } from '@/features/schedules/CronText';

type EngineData = ReturnType<typeof useEngineData>;

export function PageHeader({
  page,
  pageLabel,
  selection,
  selectedDataset,
  selectedModel,
  data: { me, jobs, runs, status, roles },
  primary,
  online,
  busy,
  favorite,
  onToggleFavorite,
  asRole,
  onAsRole,
  onRefresh,
}: {
  page: Route;
  pageLabel: string;
  /** Selected graph entity name on Data Map and Models; empty elsewhere. */
  selection: string;
  selectedDataset?: Dataset;
  selectedModel?: Model;
  data: EngineData;
  primary: { label: string; run: () => void } | null;
  online: boolean;
  busy: boolean;
  favorite: boolean;
  onToggleFavorite: () => void;
  asRole: string;
  onAsRole: (role: string) => void;
  /** Absent while disconnected. */
  onRefresh?: () => void;
}) {
  const running = runs.filter((run) => run.state === 'running').length;
  return (
    <header className="page-header">
      <div>
        {/* The row above the title is always present (breadcrumb, or engine telemetry on
            Overview) so the title and actions never jump when switching pages. */}
        {status && navItemOf(page).route === 'Dashboard' ? (
          <div
            className="page-header-meta flex flex-wrap gap-x-4 text-caption text-ink-3 tabular-nums"
            aria-label="Engine telemetry"
          >
            <span>Queue {status.queue_depth}</span>
            <span>Running {can(me, 'sync_admin') ? running : '—'}</span>
            <span>
              Up {Math.floor(status.uptime_seconds / 3600)} h{' '}
              {Math.floor((status.uptime_seconds % 3600) / 60)} m
            </span>
            <span>Backup {relativeTime(backupTime(status.last_backup))}</span>
          </div>
        ) : navItemOf(page).route === 'Dashboard' || page === 'Connect' ? (
          <div className="page-header-meta" aria-hidden="true" />
        ) : (
          <Breadcrumb
            items={[
              sectionLabels[sectionOf(page).label],
              pageLabel,
              ...(selection ? [selection] : []),
            ]}
          />
        )}
        <div className="page-title">
          <h1>{selection || pageLabel}</h1>
          {selectedDataset && <StatusChip state={datasetState(selectedDataset, jobs, runs)} />}
          {selectedModel && (
            <>
              <StatusChip
                state={
                  selectedModel.status === 'broken'
                    ? 'failed'
                    : (selectedModel.last_run_status ?? selectedModel.status)
                }
              />
              <Pill>{selectedModel.materialization}</Pill>
              <Pill>
                {selectedModel.cron ? (
                  <CronText cron={selectedModel.cron} />
                ) : (
                  selectedModel.trigger
                )}
              </Pill>
            </>
          )}
          {navItemOf(page).route === 'Pipelines' && (
            <StatePill state={running ? 'running' : 'idle'} label={running + ' running'} />
          )}
        </div>
      </div>
      <div className="actions">
        <span id="page-actions" className="contents" />
        {primary && (
          <Button type="button" variant="default" disabled={!online || busy} onClick={primary.run}>
            <Icon name="plus" />
            {primary.label}
          </Button>
        )}
        {!['Connect', 'Favorites', 'Recent'].includes(page) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={favorite ? 'Remove favorite' : 'Favorite this page or selection'}
            aria-pressed={favorite}
            onClick={onToggleFavorite}
          >
            <Star size={18} className={favorite ? 'fill-ink' : ''} />
          </Button>
        )}
        {page === 'Data Map' && can(me, 'admin') && (
          <Field label="View as role">
            <select value={asRole} onChange={(e) => onAsRole(e.target.value)}>
              <option value="">My access</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {onRefresh && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onRefresh}>
            <Icon name="refresh" />
            {/* Icon-only on narrow windows; the label stays for assistive tech. */}
            <span className="max-[1023px]:sr-only">Refresh</span>
          </Button>
        )}
      </div>
    </header>
  );
}
