import { Skeleton as SkeletonBar } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EngineEvent, Job, Run, ModelExplain } from '@/lib/api';
import { Button, Icon, Pill, Table, Tabs, stateTone } from '@/components/workbench/primitives';
import {
  clampDrawerHeight,
  drawerBounds,
  formatEvent,
  statusChip,
} from '@/features/console/workbench-model';
import type { LogLevel } from '@/features/console/workbench-model';
import { ruleDiffRows } from '@/features/transformations/model-model';
import { runStats } from '@/features/jobs/job-model';
export function StatusChip({ state }: { state?: string | null }) {
  const chip = statusChip(state);
  return (
    <Pill tone={chip.tone} className={'status-chip state-' + chip.state.replace(' ', '-')}>
      <span className="status-dot" />
      {chip.label}
    </Pill>
  );
}
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 3000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        title={label}
        aria-label={label}
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => setMessage('Copied'))
            .catch(() => setMessage('Copy unavailable. Select the text to copy.'));
        }}
      >
        <Icon name="copy" />
      </Button>
      {message && (
        <span role="status" className="copy-feedback">
          {message}
        </span>
      )}
    </>
  );
}
export function Skeleton({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="skeleton-rows" role="status" aria-label={label}>
      {[0, 1, 2, 3].map((i) => (
        <SkeletonBar key={i} />
      ))}
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
export function ConsoleDrawer({
  tabs = ['Live events', 'Run history'],
  tab,
  onTab,
  collapsed,
  onCollapsed,
  events = [],
  children,
}: {
  tabs?: string[];
  tab: string;
  onTab: (tab: string) => void;
  collapsed: boolean;
  onCollapsed: (value: boolean) => void;
  events?: EngineEvent[];
  children?: ReactNode;
}) {
  const id = useId();
  const drawer = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(256);
  const [available, setAvailable] = useState(600);
  useLayoutEffect(() => {
    const parent = drawer.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      setAvailable(parent.clientHeight);
      setHeight((h) => clampDrawerHeight(h, parent.clientHeight));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const bounds = drawerBounds(available);
  return (
    <section
      ref={drawer}
      className="console-drawer"
      aria-label="Workbench console"
      style={{ height: collapsed ? 36 : height }}
    >
      {!collapsed && (
        <div
          className="drawer-splitter"
          role="separator"
          tabIndex={0}
          aria-label="Resize console"
          aria-orientation="horizontal"
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuenow={height}
          onKeyDown={(e) => {
            const next =
              e.key === 'ArrowUp'
                ? height + (e.shiftKey ? 48 : 16)
                : e.key === 'ArrowDown'
                  ? height - (e.shiftKey ? 48 : 16)
                  : e.key === 'Home'
                    ? bounds.min
                    : e.key === 'End'
                      ? bounds.max
                      : null;
            if (next !== null) {
              e.preventDefault();
              setHeight(clampDrawerHeight(next, available));
            }
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            if (drawer.current) drawer.current.dataset.resizing = 'true';
            e.currentTarget.dataset.startY = String(e.clientY);
            e.currentTarget.dataset.startHeight = String(height);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              setHeight(
                clampDrawerHeight(
                  Number(e.currentTarget.dataset.startHeight) +
                    Number(e.currentTarget.dataset.startY) -
                    e.clientY,
                  available,
                ),
              );
          }}
          onLostPointerCapture={() => {
            if (drawer.current) drawer.current.dataset.resizing = 'false';
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        />
      )}
      <div className="drawer-tabs panel-chrome">
        <Tabs
          id={id}
          items={tabs}
          value={tab}
          onChange={(value) => {
            onTab(value);
            onCollapsed(false);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          title={collapsed ? 'Expand console' : 'Collapse console'}
          aria-label={collapsed ? 'Expand console' : 'Collapse console'}
          aria-expanded={!collapsed}
          onClick={() => onCollapsed(!collapsed)}
        >
          <Icon name={collapsed ? 'expand' : 'minimize'} />
        </Button>
      </div>
      {!collapsed && (
        <div
          className="drawer-panel"
          role="tabpanel"
          id={id + '-panel-' + tab}
          aria-labelledby={id + '-tab-' + tab}
        >
          {tab === 'Live events' ? <LiveEvents events={events} /> : children}
        </div>
      )}
    </section>
  );
}
export function LiveEvents({ events }: { events: EngineEvent[] }) {
  const [level, setLevel] = useState('');
  const [entity, setEntity] = useState('');
  const [unread, setUnread] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const previous = useRef<EngineEvent | undefined>(events[0]);
  const lines = events
    .filter((e) => e.type !== 'resync_required')
    .map(formatEvent)
    .filter(
      (line) =>
        (!level || line.level === level) &&
        (!entity ||
          (line.entity + ' ' + line.message).toLowerCase().includes(entity.toLowerCase())),
    )
    .reverse();
  useLayoutEffect(() => {
    const head = events[0];
    const previousIndex = events.indexOf(previous.current!);
    const added =
      head === previous.current ? 0 : previousIndex >= 0 ? previousIndex : events.length;
    const newLines = events.slice(0, added).filter((event) => {
      const line = formatEvent(event);
      return (
        event.type !== 'resync_required' &&
        (!level || line.level === level) &&
        (!entity || (line.entity + ' ' + line.message).toLowerCase().includes(entity.toLowerCase()))
      );
    }).length;
    previous.current = head;
    if (bottom.current) {
      if (log.current) log.current.scrollTop = log.current.scrollHeight;
      setUnread(0);
    } else setUnread((n) => n + newLines);
  }, [events]);
  return (
    <div className="live-events">
      <div className="log-toolbar">
        <label>
          Level
          <select
            aria-label="Filter event level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="">All levels</option>
            {(['INFO', 'RUN', 'WARN', 'ERROR'] as LogLevel[]).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Entity
          <Input
            aria-label="Filter events by entity or message"
            type="search"
            value={entity}
            placeholder="Filter entity or message…"
            onChange={(e) => setEntity(e.target.value)}
          />
        </label>
        <span className="hint">Local receipt time</span>
        <CopyButton text={lines.map((line) => line.text).join('\n')} label="Copy visible events" />
      </div>
      <div
        ref={log}
        className="event-log"
        role="log"
        aria-live="off"
        aria-label="Live engine events"
        tabIndex={0}
        onScroll={(e) => {
          bottom.current =
            e.currentTarget.scrollHeight -
              e.currentTarget.scrollTop -
              e.currentTarget.clientHeight <
            20;
          if (bottom.current) setUnread(0);
        }}
      >
        {lines.map((line, i) => (
          <div className="log-line" key={i}>
            <time>{line.time}</time>
            <span className={'log-level level-' + line.level}>{line.level}</span>
            <span className="log-entity" title={line.entity}>
              {line.entity}
            </span>
            <span>{line.message}</span>
          </div>
        ))}
        {!lines.length && (
          <p className="empty">
            {events.some((event) => event.type !== 'resync_required')
              ? 'No events match these filters.'
              : 'Waiting for engine events…'}
          </p>
        )}
      </div>
      {unread > 0 && (
        <Button
          variant="outline"
          className="new-lines"
          onClick={() => {
            bottom.current = true;
            if (log.current) log.current.scrollTop = log.current.scrollHeight;
            setUnread(0);
          }}
        >
          {unread} new lines ↓
        </Button>
      )}
    </div>
  );
}
export function RunHistory({
  runs,
  jobs,
  cancel,
  busy,
}: {
  runs: Run[];
  jobs: Job[];
  cancel?: (id: string) => void;
  busy?: boolean;
}) {
  return runs.length ? (
    <Table label="Selected entity run history">
      <TableHeader>
        <TableRow>
          <TableHead>Job / run</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Attempt</TableHead>
          <TableHead>Batches</TableHead>
          <TableHead>Changes / read</TableHead>
          <TableHead>Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>
              {jobs.find((job) => job.id === run.job_id)?.name ?? run.job_id}
              <small>
                <code>{run.id}</code>
              </small>
            </TableCell>
            <TableCell>
              <Pill tone={stateTone(run.state)}>{run.state}</Pill>
            </TableCell>
            <TableCell>{run.attempt}</TableCell>
            <TableCell>{run.committed_batches}</TableCell>
            <TableCell>
              <code>{runStats(run)}</code>
              {run.fallback_reason && <small>{run.fallback_reason}</small>}
            </TableCell>
            <TableCell>
              {run.error ?? new Date(run.available_at * 1000).toLocaleString()}
              {cancel && ['queued', 'running'].includes(run.state) && (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => cancel(run.id)}
                >
                  Cancel run
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ) : (
    <p className="empty">No run history for this selection.</p>
  );
}
export function ExplainPlan({ plans }: { plans: ModelExplain | null }) {
  if (!plans)
    return (
      <p className="empty">Select a model and choose Explain to inspect the saved definition.</p>
    );
  return (
    <>
      <p className="hint">Saved definition · owner's access</p>
      <h3>Rule firings</h3>
      {plans.rules_fired.length ? (
        <Table label="Optimizer before and after">
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Expression</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ruleDiffRows(plans.rules_fired).map((row) => (
              <TableRow key={row.id} className={'rule-' + row.kind}>
                <TableCell>{row.rule}</TableCell>
                <TableCell>{row.sign}</TableCell>
                <TableCell>
                  <code>{row.expression}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="hint">No Straton rules fired for this plan.</p>
      )}
      {(['logical_before', 'logical_after', 'physical'] as const).map((key) => (
        <details key={key} className="model-plan">
          <summary>{key.replaceAll('_', ' ')}</summary>
          <pre tabIndex={0}>{plans[key]}</pre>
        </details>
      ))}
    </>
  );
}
