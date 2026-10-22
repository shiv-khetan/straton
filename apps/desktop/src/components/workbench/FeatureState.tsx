import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
export function FeatureLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 py-4">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((n) => (
        <Skeleton key={n} className="h-10 w-full" />
      ))}
    </div>
  );
}
export function FeatureError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-danger-soft p-3 text-danger"
    >
      <span className="min-w-0 flex-1 break-words">
        {error instanceof Error ? error.message : String(error)}
      </span>
      {retry && (
        <Button variant="outline" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
export function FeatureEmpty({
  title,
  children,
  action,
  onAction,
  disabled,
}: {
  title: string;
  children: ReactNode;
  action?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-3 py-8">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="max-w-prose text-ink-2">{children}</p>
      {action && (
        <Button disabled={disabled} onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  let emptyValue = '__empty:' + id;
  while (options.some((o) => o.value === emptyValue)) emptyValue += '_';
  const choices =
    value && !options.some((o) => o.value === value)
      ? [...options, { value, label: value }]
      : options;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value || emptyValue}
        onValueChange={(v) => onChange(v === emptyValue ? '' : v)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full min-w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((o) => (
            <SelectItem key={o.value} value={o.value || emptyValue}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function useFeatureAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(work: () => Promise<unknown>, message?: string) {
    setPending(true);
    setError(null);
    try {
      await work();
      if (message) toast.success(message);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run, clear: () => setError(null) };
}
