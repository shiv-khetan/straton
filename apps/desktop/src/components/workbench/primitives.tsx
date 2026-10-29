import { createPortal } from 'react-dom';
import { Table as DataTable } from '@/components/ui/table';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Sheet as SheetRoot, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs as TabsRoot, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Breadcrumb as BreadcrumbRoot,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { toast } from 'sonner';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useReadOnly } from './ReadOnlyScope';
export { Icon } from './Icon';
export type { IconName } from './Icon';
import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
export { Button } from '@/components/ui/button';

export function Pill({
  tone = 'neutral',
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <Badge
      variant="secondary"
      className={
        'pill ' +
        {
          neutral: 'bg-panel text-ink-2',
          primary: 'bg-primary-soft text-primary',
          success: 'bg-success-soft text-success',
          warning: 'bg-warning-soft text-warning',
          danger: 'bg-danger-soft text-danger',
          info: 'bg-info-soft text-info',
        }[tone] +
        ' ' +
        className
      }
      {...props}
    />
  );
}

// Engine states render as one lozenge everywhere: dot, sentence case, tone by meaning.
export function StatePill({ state, label }: { state: string; label?: string }) {
  const text = (label ?? state).replaceAll('_', ' ');
  const tone = stateTone(state);
  return (
    <Pill
      tone={tone}
      className={
        'status-chip state-' +
        state.toLowerCase().replaceAll(' ', '-') +
        (tone === 'success' || tone === 'neutral' ? ' bg-transparent' : '')
      }
    >
      <span className="status-dot" aria-hidden="true" />
      {text ? text[0].toUpperCase() + text.slice(1) : text}
    </Pill>
  );
}
export function stateTone(state: string): Tone {
  const value = state.toLowerCase();
  return [
    'succeeded',
    'applied',
    'rolled_back',
    'passed',
    'live',
    'connected',
    'enabled',
    'healthy',
    'active',
    'configured',
    'ready',
  ].includes(value)
    ? 'success'
    : ['failed', 'failing', 'interrupted', 'error', 'broken'].includes(value)
      ? 'danger'
      : ['queued', 'stale data', 'stale', 'warning'].includes(value)
        ? 'warning'
        : ['running', 'applying'].includes(value)
          ? 'info'
          : 'neutral';
}
export function Card({ children, className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={'card ' + className} {...props}>
      {children}
    </section>
  );
}
export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <DataTable>{children}</DataTable>
    </div>
  );
}

export function Inspector({
  entityId,
  title,
  label,
  onClose,
  children,
}: {
  entityId: string;
  title: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    setClosing(false);
    panel.current?.focus();
    return () => {
      clearTimeout(timer.current);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [entityId]);
  const close = () => {
    if (closing) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
      return;
    }
    setClosing(true);
    timer.current = setTimeout(onClose, 150);
  };
  return (
    <aside
      ref={panel}
      className={'map-inspector' + (closing ? ' is-closing' : '')}
      aria-label={label}
      tabIndex={-1}
      inert={closing}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="panel-heading">
        <h2 title={title}>{title}</h2>
        <Button type="button" variant="ghost" aria-label="Close inspector" onClick={close}>
          <Icon name="close" />
        </Button>
      </div>
      {children}
    </aside>
  );
}
function menuChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; disabled?: boolean }>(child)) return null;
    if (child.type === Fragment) return menuChildren(child.props.children);
    return (
      <DropdownMenuItem asChild disabled={child.props.disabled}>
        {child}
      </DropdownMenuItem>
    );
  });
}
export function RowMenu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label}>
          <Icon name="more" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label}>
        {menuChildren(children)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const readOnly = useReadOnly();
  return (
    <SheetRoot
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent
        className="w-[480px] max-w-[calc(100vw-24px)] gap-0 overflow-y-auto bg-panel p-0 sm:max-w-[480px]"
        aria-describedby={undefined}
      >
        <SheetHeader className="sticky top-0 z-sticky border-b border-line bg-panel p-4 pr-12">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <fieldset disabled={readOnly} className="min-w-0 border-0 p-4">
          {open && children}
        </fieldset>
      </SheetContent>
    </SheetRoot>
  );
}

export function Tabs({
  items,
  value,
  onChange,
  id,
}: {
  items: string[];
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <TabsRoot value={value} onValueChange={onChange} className="contents">
      <TabsList
        variant="line"
        className="tabs h-auto w-full justify-start rounded-none bg-transparent p-0"
        aria-label={id}
      >
        {items.map((item) => (
          <TabsTrigger
            key={item}
            className="-mb-px h-auto flex-none rounded-none border-0 border-b-2 border-transparent px-0.5 pt-2 pb-1.5 font-normal after:hidden data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-ink data-[state=active]:shadow-none dark:data-[state=active]:border-primary dark:data-[state=active]:bg-transparent"
            value={item}
            id={id + '-tab-' + item}
            aria-controls={id + '-panel-' + item}
          >
            {item}
          </TabsTrigger>
        ))}
      </TabsList>
    </TabsRoot>
  );
}

export function Breadcrumb({ items }: { items: string[] }) {
  return (
    <BreadcrumbRoot>
      <BreadcrumbList className="text-caption">
        {items.map((item, index) => (
          <Fragment key={index}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem className="min-w-0 truncate">
              {index === items.length - 1 ? (
                <BreadcrumbPage className="truncate">{item}</BreadcrumbPage>
              ) : (
                <span className="truncate">{item}</span>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </BreadcrumbRoot>
  );
}

export function EmptyState({
  icon = 'table',
  children,
  action,
}: {
  icon?: IconName;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="icon-tile">
        <Icon name={icon} size={24} />
      </span>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Feedback({
  message,
  error = false,
  onClose,
}: {
  message: string;
  error?: boolean;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const id = error
      ? toast.error(message, { duration: Infinity, onDismiss: () => close.current() })
      : toast.success(message, {
          onDismiss: () => close.current(),
          onAutoClose: () => close.current(),
        });
    return () => {
      toast.dismiss(id);
    };
  }, [message, error]);
  return null;
}

export type TreeGroup = {
  id: string;
  label: string;
  items: {
    id: string;
    label: string;
    subtitle?: string;
    columns?: { name: string; type: string }[];
  }[];
};
export function SchemaTree({
  groups,
  hidden = [],
  onToggle,
  onSelect,
  selected,
}: {
  groups: TreeGroup[];
  hidden?: string[];
  onToggle?: (id: string) => void;
  onSelect: (id: string) => void;
  selected?: string;
}) {
  return (
    <div className="schema-tree">
      {groups.map((group) => (
        <details key={group.id} open>
          <summary>
            <Icon name="source" />
            {onToggle && (
              <input
                type="checkbox"
                aria-label={'Show ' + group.label}
                checked={!hidden.includes(group.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggle(group.id)}
              />
            )}
            <span>{group.label}</span>
            <span className="count">{group.items.length}</span>
          </summary>
          <ul>
            {group.items.map((item) => (
              <li key={item.id}>
                {onToggle && (
                  <input
                    type="checkbox"
                    aria-label={'Show ' + item.label}
                    checked={!hidden.includes(item.id)}
                    onChange={() => onToggle(item.id)}
                  />
                )}
                <Button
                  variant="outline"
                  type="button"
                  aria-current={selected === item.id ? 'true' : undefined}
                  onClick={() => onSelect(item.id)}
                  title={item.label}
                >
                  <Icon name="table" />
                  <span>
                    {item.label}
                    {item.subtitle && <small>{item.subtitle}</small>}
                  </span>
                </Button>
                {item.columns && (
                  <details className="tree-columns">
                    <summary>{item.columns.length} columns</summary>
                    <ul>
                      {item.columns.map((column, i) => (
                        <li key={i}>
                          <code>{column.name}</code>
                          <small>{column.type}</small>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export function Tray({
  title,
  actions,
  children,
  className = '',
  ...props
}: HTMLAttributes<HTMLElement> & { title: string; actions?: ReactNode }) {
  const id = useId();
  return (
    <section className={'tray ' + className} aria-labelledby={id} {...props}>
      <header className="tray-heading">
        <h2 id={id} className="mono-caption">
          {title}
        </h2>
        {actions}
      </header>
      <div className="tray-surface">{children}</div>
    </section>
  );
}
export function SegmentedControl({
  items,
  value,
  onChange,
  label,
}: {
  items: string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      className="segmented-control"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      aria-label={label}
    >
      {items.map((item) => (
        <ToggleGroupItem key={item} value={item} aria-label={item}>
          {item}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function Sparkline({
  series,
  label,
  width = 72,
  height = 28,
  ceiling,
  minPoints = 3,
}: {
  series: (number | null)[];
  label: string;
  width?: number;
  height?: number;
  ceiling?: number;
  minPoints?: number;
}) {
  const max = ceiling ?? Math.max(1, ...series.map((n) => n ?? 0));
  const points = series.map((n, i) =>
    n === null
      ? null
      : [
          2 + (i * (width - 4)) / Math.max(1, series.length - 1),
          height - 3 - (n / max) * (height - 6),
        ],
  );
  const hasData = series.some((n) => n !== null);
  // A trend needs three readings; fewer is said in words rather than drawn as a stray mark.
  if (series.filter((n) => n !== null).length < minPoints)
    return (
      <span className="ml-auto self-center text-xs text-ink-3" role="img" aria-label={label}>
        {hasData ? 'Not enough history' : 'No activity'}
      </span>
    );
  return (
    <svg
      className="sparkline"
      style={{ width, height }}
      viewBox={'0 0 ' + width + ' ' + height}
      role="img"
      aria-label={label}
    >
      <title>
        {label + ': ' + (hasData ? series.map((n) => n ?? 'no runs').join(', ') : 'No activity')}
      </title>
      <line x1="0" x2={width} y1={height - 2} y2={height - 2} stroke="var(--line)" />
      {points.map(
        (point, i) =>
          point && (
            <g key={i}>
              {points[i - 1] && (
                <line
                  x1={points[i - 1]![0]}
                  y1={points[i - 1]![1]}
                  x2={point[0]}
                  y2={point[1]}
                  stroke="var(--mark)"
                  strokeWidth="1.5"
                />
              )}
              <circle cx={point[0]} cy={point[1]} r="1.5" fill="var(--mark)" />
            </g>
          ),
      )}
    </svg>
  );
}
export function KpiTile({
  caption,
  value,
  unit,
  series,
  seriesLabel,
  footer,
  tone = 'neutral',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  caption: string;
  value: ReactNode;
  unit?: string;
  series: (number | null)[];
  seriesLabel: string;
  footer: string;
  tone?: Tone;
}) {
  return (
    <Button
      variant="outline"
      type="button"
      className="kpi-tile h-auto flex-col items-stretch gap-0 rounded-card border border-line bg-surface p-0 text-left whitespace-normal"
      {...props}
    >
      <span className="kpi-top">
        <span className="mono-caption">{caption}</span>
        <span className="kpi-reading">
          <span className="kpi-value">{value}</span>
          {unit && <span className="kpi-unit">{unit}</span>}
          <Sparkline series={series} label={seriesLabel} />
        </span>
        <span className={'kpi-sublabel ' + (tone === 'danger' ? 'text-danger' : 'text-ink-3')}>
          {footer}
        </span>
      </span>
    </Button>
  );
}

// Renders a page's primary action into the title row, so it sits in one place on every page.
export function PageActions({ children }: { children: import('react').ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById('page-actions')), []);
  return slot ? createPortal(children, slot) : null;
}
