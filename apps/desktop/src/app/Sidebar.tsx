import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { PanelLeftClose, PanelLeftOpen, Pin, PinOff } from 'lucide-react';
import type { Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/workbench/Icon';
import { usePreferences } from '@/stores/preferences';
import { navKeyboardIndex, sidebarBounds } from '@/stores/sidebar-state';
import { useRouteStore } from '@/stores/route';
import { routeLabels } from '@/stores/route-history';
import type { Route } from '@/stores/route-history';
import { navigation, routeAvailable, sectionLabels, sectionOf } from './navigation';
import { orderSections, visibleItems } from './sidebar-model';
import type { NavGroup } from '@/stores/sidebar-state';
export function Sidebar({ me, onNavigate }: { me: Me | null; onNavigate: (route: Route) => void }) {
  const { width, collapsed, setWidth, toggleCollapsed, importantItems, togglePin } =
    usePreferences();
  const page = useRouteStore((state) => state.page);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 900px)').matches);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<NavGroup[]>([]);
  useEffect(() => setExpanded([]), [page]);
  const start = useRef({ x: 0, width });
  const reduced = useReducedMotion();
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const rail = collapsed || narrow;
  const section = sectionOf(page);
  return (
    <motion.aside
      className="relative flex min-h-0 shrink-0 flex-col gap-2 border-r border-line bg-panel p-2 pt-4"
      aria-label="Workspace sidebar"
      initial={false}
      animate={{ width: rail ? sidebarBounds.rail : width }}
      transition={{ duration: reduced || dragging ? 0 : 0.18, ease: [0.25, 1, 0.5, 1] }}
    >
      <nav
        className={
          'min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden ' +
          (rail ? 'scrollbar-hidden' : 'scrollbar-on-hover')
        }
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
        {orderSections(section.label, navigation).map((group) => {
          const items = visibleItems(
            group,
            importantItems,
            !rail && expanded.includes(group.label),
            section.label,
          );
          const hidden = group.items.length - items.length;
          if (rail && items.length === 0) return null;
          return (
            <motion.section
              key={group.label}
              layout={reduced ? false : 'position'}
              initial={false}
              transition={{ layout: { duration: 0.18, ease: [0.25, 1, 0.5, 1] } }}
              aria-label={sectionLabels[group.label]}
              className={rail && group.label !== section.label ? 'border-t border-line pt-3' : ''}
            >
              {!rail && (
                <h2 className="px-2.5 pb-1 text-xs font-medium text-ink-3">
                  {sectionLabels[group.label]}
                </h2>
              )}
              <div id={'sidebar-' + group.label} className="space-y-0.5">
                {items.map(({ route, icon }) => {
                  const pinned = importantItems[group.label]?.includes(route) ?? false;
                  const available = routeAvailable(me, route);
                  return (
                    <div key={route} className="group relative flex items-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="min-w-0 flex-1">
                            <button
                              type="button"
                              data-nav-focus
                              className={
                                'flex min-h-8 w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-nav transition-colors duration-fast ease-workbench disabled:opacity-50 ' +
                                (rail ? 'justify-center px-1 ' : 'pe-9 ') +
                                (page === route
                                  ? 'bg-primary-soft font-medium text-primary'
                                  : 'text-ink-2 hover:bg-panel-2 hover:text-ink')
                              }
                              aria-current={page === route ? 'page' : undefined}
                              aria-label={routeLabels[route]}
                              disabled={!available}
                              onClick={() => {
                                setExpanded([]);
                                onNavigate(route);
                              }}
                            >
                              <Icon name={icon} />
                              {!rail && <span className="truncate">{routeLabels[route]}</span>}
                            </button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {routeLabels[route]}
                          {!available ? ' · Connect with the required access' : ''}
                        </TooltipContent>
                      </Tooltip>
                      {!rail && (
                        <button
                          type="button"
                          aria-label={
                            (pinned ? 'Unpin ' : 'Pin ') +
                            routeLabels[route] +
                            (pinned ? ' from sidebar' : ' to sidebar')
                          }
                          aria-pressed={pinned}
                          className={
                            'absolute right-0.5 flex size-7 items-center justify-center rounded-sm hover:bg-panel-2 hover:text-ink group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ' +
                            (pinned ? 'text-ink-2 opacity-100' : 'text-ink-3 opacity-0')
                          }
                          onClick={() => togglePin(group.label, route)}
                        >
                          {pinned ? (
                            <Pin size={13} aria-hidden="true" />
                          ) : (
                            <PinOff size={13} aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {!rail && hidden > 0 && (
                <button
                  type="button"
                  data-nav-focus
                  aria-expanded={false}
                  aria-controls={'sidebar-' + group.label}
                  aria-label={
                    'Show all ' + sectionLabels[group.label] + ' pages (' + hidden + ' more)'
                  }
                  className="mt-0.5 flex min-h-8 w-full items-center rounded-sm px-2.5 py-1.5 text-left text-xs text-ink-3 hover:bg-panel-2 hover:text-ink"
                  onClick={() => setExpanded((current) => [...current, group.label])}
                >
                  Show all ({hidden} more)
                </button>
              )}
            </motion.section>
          );
        })}
      </nav>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className={'w-full text-ink-3 ' + (rail ? 'px-0' : 'justify-start')}
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
