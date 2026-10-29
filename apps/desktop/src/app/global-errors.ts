import { toast } from 'sonner';

// Last-resort reporting for errors no boundary or handler caught: one friendly toast per
// distinct message, never a raw stack, and a single console line for diagnosis.
const seen = new Set<string>();
export function describeError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  const line = raw.split('\n')[0].trim();
  return line.length > 160 ? line.slice(0, 157) + '…' : line || 'An unexpected error occurred.';
}
function report(reason: unknown) {
  const message = describeError(reason);
  if (seen.has(message)) return;
  seen.add(message);
  console.error('Unhandled error:', reason);
  toast.error('Something went wrong', {
    description: message + ' The current view keeps working; reload if it looks wrong.',
  });
}
export function installGlobalErrorHandlers(target: Window = window) {
  const controller = new AbortController();
  target.addEventListener('error', (event) => report(event.error ?? event.message), {
    signal: controller.signal,
  });
  target.addEventListener('unhandledrejection', (event) => report(event.reason), {
    signal: controller.signal,
  });
  return () => controller.abort();
}
