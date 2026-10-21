import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Minus,
  Square,
  Copy,
  X,
  Search,
  SquareTerminal,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { Breadcrumb } from '@/components/workbench/primitives';
import appIcon from '../../src-tauri/icons/32x32.png';
import { notificationList } from '@/lib/events';
import type { EngineEvent, Me } from '@/lib/api';
import { relativeTime } from '@/lib/view-model';
import { useThemeStore } from '@/stores/theme';
import { useRouteStore } from '@/stores/route';
export function TitleBar({
  workspace,
  breadcrumbs,
  me,
  online,
  live,
  events,
  onSearch,
  onConnect,
  onForget,
  busy,
  connected,
  consoleDisabled,
  onConsole,
  consoleCollapsed,
}: {
  workspace: string;
  breadcrumbs: string[];
  me: Me | null;
  online: boolean;
  live: string;
  events: EngineEvent[];
  onSearch: () => void;
  onConnect: () => void;
  onForget: () => void;
  busy: boolean;
  connected: boolean;
  consoleDisabled: boolean;
  onConsole: () => void;
  consoleCollapsed: boolean;
}) {
  const native = isTauri();
  const [maximized, setMaximized] = useState(false);
  const [seen, setSeen] = useState(0);
  const { preference, setTheme } = useThemeStore();
  const { index, entries, back, forward } = useRouteStore();
  const notifications = notificationList(events);
  const unread = notifications.filter((item) => (item.receivedAt ?? 0) > seen).length;
  const initials =
    me?.user.name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  useEffect(() => {
    if (!native) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    const update = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (active) setMaximized(value);
        })
        .catch(() => {});
    };
    update();
    void win
      .onResized(update)
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [native]);
  async function windowAction(action: 'minimize' | 'maximize' | 'close' | 'drag') {
    if (!native) return;
    const win = getCurrentWindow();
    try {
      if (action === 'minimize') await win.minimize();
      if (action === 'maximize') {
        await win.toggleMaximize();
        setMaximized(await win.isMaximized());
      }
      if (action === 'close') await win.close();
      if (action === 'drag') await win.startDragging();
    } catch (error) {
      toast.error('Window action failed', { description: String(error) });
    }
  }
  return (
    <header
      className="title-bar flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface pl-3"
      data-tauri-drag-region
      onMouseDown={(event) => {
        if (
          !native ||
          event.button !== 0 ||
          (event.target as HTMLElement).closest('button, input, [role=button], a')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (event.detail === 1) void windowAction('drag');
      }}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest('button, input, [role=button], a')) {
          event.stopPropagation();
          void windowAction('maximize');
        }
      }}
    >
      <span
        className="pointer-events-none flex shrink-0 items-center gap-1.5 text-body font-semibold"
        data-tauri-drag-region
      >
        <img src={appIcon} width={20} height={20} alt="" draggable={false} />
        <span className="max-[680px]:hidden">Straton</span>
      </span>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={index === 0}
          onClick={back}
        >
          <ArrowLeft size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={index >= entries.length - 1}
          onClick={forward}
        >
          <ArrowRight size={16} />
        </Button>
      </div>
      <span
        className="max-w-32 truncate border-l border-line pl-2 font-mono text-caption text-ink-2 max-[1000px]:hidden"
        title={workspace}
      >
        {workspace}
      </span>
      <div
        className="min-w-0 max-w-56 flex-1 overflow-hidden max-[1100px]:hidden"
        data-tauri-drag-region
      >
        <Breadcrumb items={breadcrumbs} />
      </div>
      <Button
        variant="ghost"
        className="ml-auto h-8 w-56 justify-start rounded-sm border border-line bg-panel px-3 text-ink-3 hover:bg-panel-2 max-[850px]:w-44 max-[680px]:w-8 max-[680px]:px-2"
        onClick={onSearch}
        aria-label="Search workspace (Ctrl or Command K)"
      >
        <Search size={16} />
        <span className="flex-1 text-left max-[680px]:hidden">Search…</span>
        <kbd className="text-caption max-[680px]:hidden">
          {navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K'}
        </kbd>
      </Button>
      <span
        role="status"
        className="flex shrink-0 items-center gap-1.5 px-1 font-mono text-caption text-ink-2"
        title={workspace + ' · ' + live}
      >
        <span className={'size-1.5 rounded-full ' + (online ? 'bg-success' : 'bg-danger')} />
        <span className="max-[850px]:hidden">{live}</span>
      </span>
      <Popover
        onOpenChange={(open) => {
          if (open) setSeen(Date.now());
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            aria-label={'Notifications · ' + unread + ' unread'}
          >
            <Bell size={18} />
            {unread > 0 && (
              <span className="absolute right-0 top-0 size-1.5 rounded-full bg-primary" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-[calc(100vw-24px)] p-0">
          <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
            <h2 className="text-body font-medium">Engine notifications</h2>
            <span className="font-mono text-caption text-ink-2">{notifications.length}</span>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length ? (
              notifications.map((item) => (
                <article key={item.key} className="border-b border-line px-4 py-3 last:border-0">
                  <p
                    className={
                      'm-0 break-words text-body ' +
                      (item.level === 'ERROR' ? 'text-danger' : 'text-ink')
                    }
                  >
                    {item.title}
                  </p>
                  <div className="mt-1 flex items-center justify-between gap-3 font-mono text-caption text-ink-3">
                    <span className="truncate">{item.entity}</span>
                    <time className="shrink-0">
                      {item.receivedAt ? relativeTime(item.receivedAt) : 'Receipt time unavailable'}
                    </time>
                  </div>
                </article>
              ))
            ) : (
              <p className="m-0 p-6 text-body text-ink-2">
                No engine events received yet. Recent events appear here while connected.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={consoleDisabled}
        aria-label="Toggle console drawer"
        aria-expanded={!consoleCollapsed}
        onClick={onConsole}
      >
        <SquareTerminal size={18} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Account menu">
            <Avatar className="size-7">
              <AvatarFallback className="bg-panel font-mono text-caption text-ink">
                {initials}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>
            <span className="block text-caption font-normal text-ink-3">Signed in as</span>
            <span className="block truncate">{me?.user.name ?? 'Not connected'}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-caption font-normal text-ink-2">
            Appearance
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={preference}
            onValueChange={(value) => setTheme(value as 'system' | 'light' | 'dark')}
          >
            {(['system', 'light', 'dark'] as const).map((theme) => (
              <DropdownMenuRadioItem key={theme} value={theme}>
                {theme[0].toUpperCase() + theme.slice(1)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onConnect}>Connect</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={busy || !connected} onSelect={onForget}>
            Forget connection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {native && (
        <div className="ml-1 flex h-full shrink-0">
          <button
            type="button"
            className="window-control"
            aria-label="Minimize window"
            onClick={() => void windowAction('minimize')}
          >
            <Minus size={14} strokeWidth={1} />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? 'Restore window' : 'Maximize window'}
            onClick={() => void windowAction('maximize')}
          >
            {maximized ? <Copy size={13} strokeWidth={1} /> : <Square size={12} strokeWidth={1} />}
          </button>
          <button
            type="button"
            className="window-control window-close"
            aria-label="Close window"
            onClick={() => void windowAction('close')}
          >
            <X size={17} strokeWidth={1} />
          </button>
        </div>
      )}
    </header>
  );
}
