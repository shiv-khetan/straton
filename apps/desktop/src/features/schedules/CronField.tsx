import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cronFeedback, cronPresets } from './cron-model';

/**
 * Schedule input with presets and live feedback: the schedule in words and its next run, or
 * the reason it is invalid. Blank means manual (when `optional`).
 */
export function CronField({
  label = 'Schedule (cron, UTC)',
  value,
  onChange,
  disabled,
  required,
  optional = true,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  optional?: boolean;
}) {
  const id = useId();
  const feedback = cronFeedback(value);
  return (
    <div className="field cron-field">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        value={value}
        placeholder="0 0 * * * *"
        disabled={disabled}
        required={required}
        spellCheck={false}
        aria-invalid={feedback?.ok === false || undefined}
        aria-describedby={id + '-feedback'}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="cron-presets" role="group" aria-label="Schedule presets">
        {cronPresets.map((p) => (
          <Button
            key={p.cron}
            type="button"
            size="xs"
            variant={value.trim() === p.cron ? 'secondary' : 'outline'}
            disabled={disabled}
            aria-pressed={value.trim() === p.cron}
            onClick={() => onChange(p.cron)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <p
        id={id + '-feedback'}
        role="status"
        className={feedback?.ok === false ? 'cron-feedback text-danger' : 'cron-feedback hint'}
      >
        {feedback
          ? feedback.text
          : optional
            ? 'Blank runs manually. Six fields: second minute hour day month weekday (Sunday = 1).'
            : 'Six fields: second minute hour day month weekday (Sunday = 1).'}
      </p>
    </div>
  );
}
