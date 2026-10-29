import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X, Search, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
import logo from '@/assets/logo.svg';
import { Notifications } from '@/features/notifications/Notifications';
import type { Api, Me } from '@/lib/api';
import { useThemeStore } from '@/stores/theme';
import type { Route } from '@/stores/route-history';
import { navigation, routeAvailable, sectionLabels, sectionOf } from './navigation';
export function TitleBar({
  workspace,
  page,
  onNavigate,
  me,
  online,
  live,
  client,
  onEntity,
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
  page: Route;
  onNavigate: (route: Route) => void;
  me: Me | null;
  online: boolean;
  live: string;
  client: Api | null;
  onEntity: (kind: string, id: string) => Promise<void>;
  onSearch: () => void;
  onConnect: () => void;
  onForget: () => void;
  busy: boolean;
  connected: boolean;
  consoleDisabled: boolean;
  onConsole: () => void;
  consoleCollapsed: boolean;
}) {
  const [accountPointerFocus, setAccountPointerFocus] = useState(false);
  useEffect(() => {
    const keyboard = () => setAccountPointerFocus(false);
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, []);
  const native = isTauri();
  const [maximized, setMaximized] = useState(false);
  const { preference, setTheme } = useThemeStore();
  const active = sectionOf(page);
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
        className="pointer-events-none flex shrink-0 items-center gap-2 pr-3 text-body font-semibold"
        data-tauri-drag-region
      >
        <img src={logo} width={22} height={22} alt="" draggable={false} />
        <span className="max-[680px]:hidden">Straton</span>
      </span>
      <nav
        aria-label="Sections"
        className="scrollbar-hidden flex h-full min-w-0 items-stretch gap-1 overflow-x-auto"
      >
        {navigation.map((group) => {
          const target = group.items.find((item) => routeAvailable(me, item.route));
          const current = group === active;
          return (
            <button
              key={group.label}
              type="button"
              className={
                'section-tab relative flex items-center whitespace-nowrap px-2.5 text-body transition-colors duration-fast ' +
                (current ? 'font-medium text-ink' : 'text-ink-2 hover:text-ink')
              }
              aria-current={current ? 'page' : undefined}
              disabled={!target}
              onClick={() => target && onNavigate(target.route)}
            >
              {sectionLabels[group.label]}
            </button>
          );
        })}
      </nav>
      <Button
        variant="ghost"
        className="ml-auto h-8 w-60 justify-start rounded-sm border border-line bg-surface px-2.5 font-normal text-ink-3 hover:bg-surface-2 hover:text-ink-2 max-[1100px]:w-44 max-[760px]:w-8 max-[760px]:px-2"
        onClick={onSearch}
        aria-label="Search workspace (Ctrl or Command K)"
      >
        <Search size={16} />
        <span className="flex-1 text-left max-[760px]:hidden">Search</span>
        <kbd className="rounded-xs border border-line px-1 text-xs text-ink-3 max-[760px]:hidden">
          {navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K'}
        </kbd>
      </Button>
      <span
        role="status"
        className="flex shrink-0 items-center gap-1.5 px-1.5 text-caption text-ink-2"
        title={workspace + ' · ' + live}
      >
        <span className={'size-1.5 rounded-full ' + (online ? 'bg-success' : 'bg-danger')} />
        <span className="max-[960px]:hidden">{live}</span>
        <span className="max-w-36 truncate font-mono text-ink-3 max-[1180px]:hidden">
          {workspace}
        </span>
      </span>
      <Notifications client={client} readOnly={!online} onEntity={onEntity} />
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={consoleDisabled}
        aria-label={consoleCollapsed ? 'Show live events and run history' : 'Hide console'}
        aria-pressed={!consoleCollapsed}
        className={consoleCollapsed ? '' : 'bg-primary-soft text-primary'}
        onClick={onConsole}
      >
        <SquareTerminal size={18} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Account menu"
            data-pointer-focus={accountPointerFocus}
            className="data-[pointer-focus=true]:ring-0 data-[pointer-focus=true]:outline-none"
            onPointerDown={() => setAccountPointerFocus(true)}
          >
            <Avatar className="size-7">
              <AvatarFallback className="bg-primary-soft text-xs font-semibold text-primary">
                {initials}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-60"
          onPointerDown={() => setAccountPointerFocus(true)}
        >
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
