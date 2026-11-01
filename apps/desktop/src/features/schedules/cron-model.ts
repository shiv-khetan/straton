// Match the engine's cron 0.15: seconds first, UTC, Sunday=1, and day fields intersect.
const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const aliases: Record<string, string> = {
  '@yearly': '0 0 0 1 1 *',
  '@monthly': '0 0 0 1 * *',
  '@weekly': '0 0 0 * * 1',
  '@daily': '0 0 0 * * *',
  '@hourly': '0 0 * * * *',
};
function field(
  text: string,
  min: number,
  max: number,
  names: string[] = [],
  any = false,
): number[] {
  const point = (value: string) => {
    if (/^\d+$/.test(value)) return Number(value);
    const key = value.toLowerCase();
    const index = names.findIndex(
      (n) =>
        n === key ||
        n.slice(0, 3) === key ||
        (n === 'tuesday' && key === 'tues') ||
        (n === 'thursday' && key === 'thurs'),
    );
    if (index < 0) throw Error('Unknown cron value: ' + value);
    return index + 1;
  };
  const result = new Set<number>();
  for (const item of text.split(',')) {
    const parts = item.split('/');
    if (parts.length > 2 || !parts[0] || (parts.length === 2 && !/^\d+$/.test(parts[1])))
      throw Error('Invalid cron field: ' + text);
    const step = parts[1] === undefined ? 1 : Number(parts[1]);
    if (step < 1 || step > max) throw Error('Invalid cron step: ' + text);
    const base = parts[0];
    const range = base.split('-');
    if (parts.length === 2 && /^[a-z]+$/i.test(base))
      throw Error('Named points cannot have a cron step.');
    if (
      range.length === 2 &&
      !range.every((v) => /^\d+$/.test(v)) &&
      !range.every((v) => /^[a-z]+$/i.test(v))
    )
      throw Error('Cron ranges must use two numbers or two names.');
    let from: number, to: number;
    if (base === '*' || (base === '?' && any)) {
      from = min;
      to = max;
    } else if (range.length === 2 && range.every(Boolean)) {
      from = point(range[0]);
      to = point(range[1]);
    } else if (range.length === 1) {
      from = point(base);
      to = parts.length === 2 ? max : from;
    } else throw Error('Invalid cron range: ' + text);
    if (from < min || to > max || from > to) throw Error('Cron value out of range: ' + text);
    for (let n = from; n <= to; n += step) result.add(n);
  }
  return [...result].sort((a, b) => a - b);
}
export function nextCron(expression: string, after: Date = new Date()): Date | null {
  if (!Number.isFinite(after.getTime())) throw Error('Invalid starting time.');
  const text = expression.trim().replace(/\s*([,\-/])\s*/g, '$1');
  const parts = (aliases[text] ?? text).split(/\s+/);
  if (parts.length !== 6 && parts.length !== 7)
    throw Error('Use six cron fields (seconds first), with an optional year.');
  const seconds = field(parts[0], 0, 59),
    minutes = field(parts[1], 0, 59),
    hours = field(parts[2], 0, 23);
  const dates = field(parts[3], 1, 31, [], true),
    month = field(parts[4], 1, 12, months),
    weekdays = field(parts[5], 1, 7, days, true),
    years = field(parts[6] ?? '*', 1970, 2100);
  const start = new Date(
    Math.max(Date.UTC(1970, 0, 1), Math.floor(after.getTime() / 1000) * 1000 + 1000),
  );
  const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (date.getUTCFullYear() <= 2100) {
    const year = date.getUTCFullYear();
    if (!years.includes(year)) {
      const next = years.find((y) => y > year);
      if (next === undefined) return null;
      date.setTime(Date.UTC(next, 0, 1));
      continue;
    }
    if (
      month.includes(date.getUTCMonth() + 1) &&
      dates.includes(date.getUTCDate()) &&
      weekdays.includes(date.getUTCDay() + 1)
    ) {
      for (const hour of hours) {
        if (date.getTime() + hour * 3600000 + 3600000 <= start.getTime()) continue;
        for (const minute of minutes) {
          if (date.getTime() + hour * 3600000 + minute * 60000 + 60000 <= start.getTime()) continue;
          for (const second of seconds) {
            const time = date.getTime() + hour * 3600000 + minute * 60000 + second * 1000;
            if (time >= start.getTime()) return new Date(time);
          }
        }
      }
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return null;
}

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');
/** Values `[from, from+k, ...]` up to max with one step k > 1, or null. */
function stepOf(values: number[], from: number, max: number): number | null {
  if (values.length < 2 || values[0] !== from) return null;
  const k = values[1] - values[0];
  if (k <= 1) return null;
  const expected = Math.floor((max - from) / k) + 1;
  return values.length === expected && values.every((v, i) => v === from + i * k) ? k : null;
}
/**
 * Plain-English schedule for the engine's 6/7-field UTC cron (seconds first, Sunday = 1),
 * e.g. "Every 15 minutes" or "Weekdays at 09:30 UTC". Returns null when the expression is
 * invalid or too irregular to describe exactly; callers then show the expression itself.
 */
export function describeCron(expression: string): string | null {
  try {
    const text = expression.trim().replace(/\s*([,\-/])\s*/g, '$1');
    const parts = (aliases[text] ?? text).split(/\s+/);
    if (parts.length !== 6 && parts.length !== 7) return null;
    const s = field(parts[0], 0, 59),
      m = field(parts[1], 0, 59),
      h = field(parts[2], 0, 23),
      dom = field(parts[3], 1, 31, [], true),
      mon = field(parts[4], 1, 12, months),
      dow = field(parts[5], 1, 7, days, true),
      year = field(parts[6] ?? '*', 1970, 2100);
    const all = (v: number[], min: number, max: number) => v.length === max - min + 1;
    if (!all(mon, 1, 12) || !all(year, 1970, 2100)) return null;
    const anyDay = all(dom, 1, 31) && all(dow, 1, 7);
    const plural = (k: number, unit: string) => (k === 1 ? 'Every ' + unit : `Every ${k} ${unit}s`);
    if (anyDay && all(h, 0, 23) && all(m, 0, 59)) {
      if (all(s, 0, 59)) return 'Every second';
      const k = stepOf(s, 0, 59);
      if (k) return plural(k, 'second');
      return s.length === 1 ? 'Every minute' : null;
    }
    if (s.length !== 1) return null;
    if (anyDay && all(h, 0, 23)) {
      const k = stepOf(m, 0, 59);
      if (k && s[0] === 0) return plural(k, 'minute');
      if (m.length === 1) return m[0] === 0 && s[0] === 0 ? 'Hourly' : `Hourly at :${pad(m[0])}`;
      return null;
    }
    if (m.length !== 1) return null;
    if (anyDay) {
      const k = stepOf(h, 0, 23);
      if (k) return plural(k, 'hour') + (m[0] ? ` at :${pad(m[0])}` : '');
    }
    if (h.length !== 1) return null;
    const time = `${pad(h[0])}:${pad(m[0])}${s[0] ? ':' + pad(s[0]) : ''} UTC`;
    if (anyDay) return 'Daily at ' + time;
    if (all(dom, 1, 31)) {
      if (dow.join() === '2,3,4,5,6') return 'Weekdays at ' + time;
      if (dow.join() === '1,7') return 'Weekends at ' + time;
      if (dow.length === 1) return `Weekly on ${dayNames[dow[0] - 1]} at ${time}`;
      return dow.map((d) => dayNames[d - 1].slice(0, 3)).join(', ') + ' at ' + time;
    }
    if (all(dow, 1, 7) && dom.length === 1) return `Monthly on day ${dom[0]} at ${time}`;
    return null;
  } catch {
    return null;
  }
}

/** Common schedules offered as one-click presets in schedule fields. */
export const cronPresets: { label: string; cron: string }[] = [
  { label: 'Every 15 min', cron: '0 */15 * * * *' },
  { label: 'Hourly', cron: '0 0 * * * *' },
  { label: 'Daily 02:00', cron: '0 0 2 * * *' },
  { label: 'Weekdays 09:00', cron: '0 0 9 * * MON-FRI' },
];
export type CronFeedback = { ok: true; text: string } | { ok: false; text: string } | null;
/** Live feedback for a schedule input: words plus the next run, or why it is invalid. */
export function cronFeedback(expression: string, now = new Date()): CronFeedback {
  if (!expression.trim()) return null;
  try {
    const next = nextCron(expression, now);
    const words = describeCron(expression) ?? 'Custom schedule';
    if (!next) return { ok: false, text: 'This schedule never runs again.' };
    const at = next.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    return { ok: true, text: `${words} · next run ${at}` };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : 'Invalid schedule.' };
  }
}
