import { describeCron } from './cron-model';

/** A schedule in words with the exact expression on hover; unusual expressions stay as code. */
export function CronText({
  cron,
  empty = 'Manual',
}: {
  cron: string | null | undefined;
  empty?: string;
}) {
  if (!cron) return <span className="text-ink-2">{empty}</span>;
  const text = describeCron(cron);
  return text ? <span title={cron + ' (UTC, seconds first)'}>{text}</span> : <code>{cron}</code>;
}
