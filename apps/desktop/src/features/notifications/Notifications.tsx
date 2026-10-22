import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import type { Api, EngineNotification } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Pill } from '@/components/workbench/primitives';
import {
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
  useFeatureAction,
} from '@/components/workbench/FeatureState';
import { relativeTime } from '@/lib/view-model';
export function Notifications({
  client,
  readOnly,
  onEntity,
}: {
  client: Api | null;
  readOnly: boolean;
  onEntity: (kind: string, id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const count = useQuery({
    queryKey: [...queryKeys.notifications, 'view', 'count'],
    queryFn: () => client!.notificationCount(),
    enabled: !!client,
    refetchInterval: 30000,
  });
  const list = useQuery({
    queryKey: [...queryKeys.notifications, 'view', 'list', unreadOnly],
    queryFn: () => client!.notifications({ unread: unreadOnly, limit: 50 }),
    enabled: !!client && open,
  });
  const action = useFeatureAction();
  const jump = (n: EngineNotification) =>
    void action.run(async () => {
      if (!n.read) await client!.readNotifications({ ids: [n.id] });
      await onEntity(n.entity_kind, n.entity_id);
      setOpen(false);
    });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          disabled={!client}
          aria-label={'Notifications · ' + (count.data?.count ?? 0) + ' unread'}
        >
          <Bell size={18} />
          {!!count.data?.count && (
            <span className="absolute -right-1 -top-1 rounded-xs bg-primary px-1 text-[11px] font-semibold text-primary-foreground">
              {count.data.count > 99 ? '99+' : count.data.count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] max-w-[calc(100vw-24px)] p-0">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel p-3">
          <h2 className="font-medium">Notifications</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={readOnly || action.pending || !count.data?.count}
            onClick={() =>
              void action.run(
                () => client!.readNotifications({ all: true }),
                'All notifications marked read',
              )
            }
          >
            Mark all read
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((v) => !v)}
          >
            {unreadOnly ? 'Show all' : 'Unread only'}
          </Button>
        </header>
        <div className="max-h-96 overflow-y-auto p-3">
          <FeatureError error={action.error} />
          <FeatureError error={count.error} retry={() => void count.refetch()} />
          {list.isPending && <FeatureLoading label="Loading notifications" />}
          <FeatureError error={list.error} retry={() => void list.refetch()} />
          {list.data?.length === 0 && (
            <FeatureEmpty
              title={unreadOnly ? 'You’re caught up' : 'No notifications yet'}
              action="View activity"
              onAction={() =>
                void action.run(async () => {
                  await onEntity('activity', '');
                  setOpen(false);
                })
              }
            >
              Failures and completed pipeline runs will appear here as work progresses.
            </FeatureEmpty>
          )}
          <ol className="divide-y divide-line">
            {list.data?.map((n) => (
              <li key={n.id} className={'space-y-2 py-3 ' + (!n.read ? 'bg-primary-soft' : '')}>
                <div className="flex items-start gap-2">
                  <Pill
                    tone={
                      n.severity === 'error' ? 'danger' : n.severity === 'warn' ? 'warning' : 'info'
                    }
                  >
                    {n.severity}
                  </Pill>
                  <p className="min-w-0 flex-1 break-words font-medium">{n.title}</p>
                  {!n.read && <span className="text-caption text-primary">Unread</span>}
                </div>
                {n.body && <p className="break-words text-caption text-ink-2">{n.body}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <time className="mr-auto font-mono text-caption text-ink-2">
                    {relativeTime(n.created_at * 1000)}
                  </time>
                  {!n.read && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readOnly || action.pending}
                      onClick={() =>
                        void action.run(() => client!.readNotifications({ ids: [n.id] }))
                      }
                    >
                      Mark read
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="link"
                    disabled={readOnly || action.pending}
                    onClick={() => jump(n)}
                  >
                    Open {n.entity_kind.replaceAll('_', ' ')}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </PopoverContent>
    </Popover>
  );
}
