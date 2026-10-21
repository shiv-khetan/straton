import { Clock3 } from 'lucide-react';
export function LaterPage({ name }: { name: string }) {
  return (
    <section className="mx-auto flex min-h-72 max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="grid size-12 place-items-center rounded-tray bg-panel text-ink-2">
        <Clock3 size={24} strokeWidth={1.5} />
      </span>
      <h2 className="text-lg font-medium">{name}</h2>
      <p className="m-0 text-body text-ink-2">Coming in a later phase</p>
      <p className="m-0 text-body text-ink-3">
        This workspace area will become available when its engine capabilities are ready.
      </p>
    </section>
  );
}
