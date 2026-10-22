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
