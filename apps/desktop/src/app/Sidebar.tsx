import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { Me, Status } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/workbench/Icon';
import { usePreferences } from '@/stores/preferences';
import { navKeyboardIndex, sidebarBounds } from '@/stores/sidebar-state';
import { useRouteStore } from '@/stores/route';
import { routeLabels } from '@/stores/route-history';
import type { Route } from '@/stores/route-history';
import { navigation, routeAvailable } from './navigation';
export function Sidebar({
  me,
  workspace,
  status,
  live,
  onNavigate,
  newJob,
  busy,
}: {
  me: Me | null;
  workspace: string;
  status: Status | null;
  live: string;
  onNavigate: (route: Route) => void;
  newJob?: () => void;
  busy: boolean;
}) {
  const { width, collapsed, expandedGroups, setWidth, toggleCollapsed, toggleGroup } =
    usePreferences();
  const page = useRouteStore((state) => state.page);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 900px)').matches);
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width });
  const reduced = useReducedMotion();
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const rail = collapsed || narrow;
  return (
    <motion.aside
      className="relative flex min-h-0 shrink-0 flex-col gap-3 border-r border-line bg-panel p-2 pt-3"
      aria-label="Workspace sidebar"
      initial={false}
      animate={{ width: rail ? sidebarBounds.rail : width }}
      transition={{ duration: reduced || dragging ? 0 : 0.18, ease: [0.25, 1, 0.5, 1] }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={
              'flex min-h-12 items-center gap-2.5 rounded-card border border-line bg-surface p-2 text-left ' +
              (rail ? 'justify-center border-transparent bg-transparent p-0' : '')
            }
            onClick={() => onNavigate('Connect')}
            aria-label={'Connect to engine · ' + workspace}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-control border border-line text-ink">
              <Icon name="server" />
            </span>
            {!rail && (
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-caption text-ink-2">
                  Engine{' '}
                  <span className="font-mono">{status ? 'v' + status.version : 'Offline'}</span>
                </span>
                <strong className="block truncate text-body font-medium" title={workspace}>
                  {workspace}
                </strong>
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Connect · {workspace}</TooltipContent>
      </Tooltip>
      {newJob && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="w-full" disabled={busy} onClick={newJob} aria-label="New sync job">
              <Icon name="plus" />
              {!rail && <span>New sync job</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New sync job</TooltipContent>
        </Tooltip>
      )}
      <nav
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden"
        aria-label="Main navigation"
        onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[data-nav-focus]:not(:disabled)',
            ),
          ];
          const index = items.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          items[navKeyboardIndex(index, event.key, items.length)]?.focus();
        }}
      >
        {navigation.map((group) => (
          <Collapsible
            key={group.label}
            open={rail || expandedGroups[group.label]}
            onOpenChange={() => toggleGroup(group.label)}
            className="border-t border-line pt-2 first:border-t-0 first:pt-0"
          >
            {!rail && (
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  data-nav-focus
                  className="mb-1 flex w-full items-center justify-between rounded-control px-3 py-1 text-left text-caption text-ink-2 hover:bg-panel-2"
                  aria-label={'Toggle ' + group.label + ' navigation'}
                >
                  {group.label}
                  <ChevronDown
                    size={14}
                    className={
                      'transition-transform duration-shell ease-workbench ' +
                      (!expandedGroups[group.label] ? '-rotate-90' : '')
                    }
                  />
                </button>
              </CollapsibleTrigger>
            )}
            <CollapsibleContent className="space-y-0.5">
              {group.items.map(({ route, icon }) => (
                <Tooltip key={route}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-nav-focus
                      className={
                        'flex min-h-9 w-full items-center gap-2.5 rounded-full border px-3 py-1.5 text-left text-nav font-normal transition-colors duration-fast ease-workbench disabled:opacity-50 ' +
                        (rail ? 'justify-center px-1 ' : '') +
                        (page === route
                          ? 'border-line bg-surface text-ink shadow-raised dark:bg-surface-2'
                          : 'border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink')
                      }
                      aria-current={page === route ? 'page' : undefined}
                      aria-label={routeLabels[route]}
                      disabled={!routeAvailable(me, route)}
                      onClick={() => onNavigate(route)}
                    >
                      <Icon name={icon} />
                      {!rail && <span className="truncate">{routeLabels[route]}</span>}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {routeLabels[route]}
                    {!routeAvailable(me, route) ? ' · Connect with the required access' : ''}
                  </TooltipContent>
                </Tooltip>
              ))}
            </CollapsibleContent>
          </Collapsible>
        ))}
      </nav>
      <div
        className={
          'flex items-center gap-2 px-3 text-caption text-ink-2 ' +
          (rail ? 'justify-center px-0' : '')
        }
        role="status"
        aria-label={'Engine: ' + live}
        title={live}
      >
        <span
          className={
            'size-1.5 shrink-0 rounded-full ' + (live === 'Live' ? 'bg-success' : 'bg-ink-3')
          }
        />
        {!rail && <span>{live}</span>}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className={'w-full ' + (rail ? 'px-0' : 'justify-start')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!rail}
            disabled={narrow}
            onClick={toggleCollapsed}
          >
            {rail ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            {!rail && 'Collapse sidebar'}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {narrow
            ? 'Sidebar expands in wider windows'
            : collapsed
              ? 'Expand sidebar'
              : 'Collapse sidebar'}
        </TooltipContent>
      </Tooltip>
      {!rail && (
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={sidebarBounds.min}
          aria-valuemax={sidebarBounds.max}
          aria-valuenow={width}
          tabIndex={0}
          className="absolute inset-y-0 -right-1 z-sticky w-2 cursor-col-resize touch-none hover:bg-primary/15 focus-visible:bg-primary/15"
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowLeft'
                ? width - (event.shiftKey ? 32 : 8)
                : event.key === 'ArrowRight'
                  ? width + (event.shiftKey ? 32 : 8)
                  : event.key === 'Home'
                    ? sidebarBounds.min
                    : event.key === 'End'
                      ? sidebarBounds.max
                      : null;
            if (next !== null) {
              event.preventDefault();
              setWidth(next);
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            start.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              setWidth(start.current.width + event.clientX - start.current.x);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => setDragging(false)}
        />
      )}
    </motion.aside>
  );
}
