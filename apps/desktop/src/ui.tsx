import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
const paths = {
  model: 'M4 4h6v6H4z M14 14h6v6h-6z M14 4h6v6h-6z M7 10v7h7 M10 7h4',
  copy: 'M8 8h12v13H8z M16 8V3H3v13h5',
  expand: 'm6 14 6-6 6 6',
  minimize: 'm6 10 6 6 6-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  console: 'M3 4h18v16H3z m4 5 3 3-3 3 M13 15h4',
  user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-2a8 8 0 0 1 16 0v2',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h1 M3 12h1 M3 18h1',
  straton: 'M3 17 9 5l6 12 6-12 M6 12h12',
  server: 'M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01',
  lock: 'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  map: 'M4 4h6v6H4z M14 14h6v6h-6z M14 4h6v6h-6z M7 10v7h7 M10 7h4',
  source:
    'M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3z M4 6v12c0 2 4 3 8 3s8-1 8-3V6 M4 12c0 2 4 3 8 3s8-1 8-3',
  jobs: 'M8 3h8v5H8z M3 16h7v5H3z M14 16h7v5h-7z M12 8v4 M6 16v-4h12v4',
  sql: 'm5 6 5 6-5 6 M13 18h7',
  backup: 'M4 8h16v13H4z M3 3h18v5H3z M9 12h6',
  connect: 'M8 3v5 M16 3v5 M5 8h14v3a7 7 0 0 1-14 0z M12 18v4',
  collapse: 'M3 4h18v16H3z M9 4v16 m8-12-4 4 4 4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  moon: 'M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13z',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M5 7a8 8 0 0 1 14-1l1 6 M4 12l1 6a8 8 0 0 0 14-1',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  close: 'm6 6 12 12 M6 18 18 6',
  table: 'M3 4h18v16H3z M3 9h18 M9 9v11',
  check: 'm5 12 4 4L19 6',
  warning: 'm12 3 10 18H2z M12 9v5 M12 17v1',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  fit: 'M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 m5 12 6 6',
  arrow: 'M4 12h16 m-6-6 6 6-6 6',
  link: 'm10 14 4-4 M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 0-6-6L8 4a4 4 0 0 0 0 6',
};
export type IconName = keyof typeof paths;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function Button({
  variant = 'ghost',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button type="button" className={'button ' + variant + ' ' + className} {...props}>
      {children}
    </button>
  );
}
export function Pill({
  tone = 'neutral',
  className = '',
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span className={'pill tone-' + tone + ' ' + className} {...props}>
      {children}
    </span>
  );
}
export function stateTone(state: string): Tone {
  return ['succeeded', 'Live', 'Connected', 'Enabled'].includes(state)
    ? 'success'
    : ['failed', 'interrupted'].includes(state)
      ? 'danger'
      : ['queued', 'Stale data'].includes(state)
        ? 'warning'
        : state === 'running'
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
      <table>{children}</table>
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
        <Button aria-label="Close inspector" onClick={close}>
          <Icon name="close" />
        </Button>
      </div>
      {children}
    </aside>
  );
}
export function RowMenu({ children, label }: { children: ReactNode; label: string }) {
  const id = useId();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  return (
    <>
      <Button
        aria-label={label}
        title={label}
        popoverTarget={id}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPosition({
            top: Math.max(8, Math.min(window.innerHeight - 160, rect.bottom + 4)),
            left: Math.max(8, Math.min(window.innerWidth - 208, rect.right - 200)),
          });
        }}
      >
        <Icon name="more" />
      </Button>
      <div
        id={id}
        popover="auto"
        className="row-menu-panel"
        aria-label={label}
        style={position}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) e.currentTarget.hidePopover();
        }}
      >
        {children}
      </div>
    </>
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
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const el = dialog.current;
    if (open && el && !el.open) el.showModal();
    if (!open && el?.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left) onClose();
        }
      }}
    >
      <div className="sheet-heading">
        <h2 id={id}>{title}</h2>
        <Button aria-label="Close panel" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </div>
      <div className="sheet-body">{open && children}</div>
    </dialog>
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
  onChange: (v: string) => void;
  id: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={id}>
      {items.map((item, i) => (
        <button
          key={item}
          type="button"
          role="tab"
          id={id + '-tab-' + item}
          aria-selected={item === value}
          aria-controls={id + '-panel-' + item}
          tabIndex={item === value ? 0 : -1}
          onClick={() => onChange(item)}
          onKeyDown={(e) => {
            let next = i;
            if (e.key === 'ArrowRight') next = (i + 1) % items.length;
            else if (e.key === 'ArrowLeft') next = (i + items.length - 1) % items.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = items.length - 1;
            else return;
            e.preventDefault();
            onChange(items[next]);
            document.getElementById(id + '-tab-' + items[next])?.focus();
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
export function Breadcrumb({ items }: { items: string[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol>
        {items.map((item, i) => (
          <li key={i} aria-current={i === items.length - 1 ? 'page' : undefined}>
            {item}
          </li>
        ))}
      </ol>
    </nav>
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
export function Toast({
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
    if (error) return;
    const timer = setTimeout(() => close.current(), 6000);
    return () => clearTimeout(timer);
  }, [message, error]);
  return (
    <div
      className={'toast tone-' + (error ? 'danger' : 'success')}
      role={error ? 'alert' : 'status'}
    >
      {message}
      <Button onClick={onClose} aria-label="Dismiss notification">
        <Icon name="close" />
      </Button>
    </div>
  );
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
                <button
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
                </button>
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
