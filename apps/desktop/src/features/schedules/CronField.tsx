import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cronFeedback, cronPresets, normalizeCron } from './cron-model';

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
        placeholder={
          optional ? 'Manual: pick a preset or type a cron' : 'Pick a preset or type a cron'
        }
        disabled={disabled}
        required={required}
        spellCheck={false}
        aria-invalid={feedback?.ok === false || undefined}
        aria-describedby={id + '-feedback'}
        onChange={(e) => onChange(e.target.value)}
        // Engineers type 5-field cron from habit: convert it to the engine's 6-field dialect.
        onBlur={() => {
          const normalized = normalizeCron(value);
          if (normalized) onChange(normalized);
        }}
      />
      <div className="cron-presets" role="group" aria-label="Schedule presets">
        {cronPresets
          .filter((p) => optional || p.cron)
          .map((p) => (
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
        {normalizeCron(value)
          ? 'Standard 5-field cron: converted to ' +
            normalizeCron(value) +
            ' when you leave the field.'
          : feedback
            ? feedback.text
            : optional
              ? 'Runs manually. Six fields, seconds first (Sunday = 1); 5-field cron is converted.'
              : 'Six fields, seconds first (Sunday = 1); 5-field cron is converted.'}
      </p>
    </div>
  );
}
