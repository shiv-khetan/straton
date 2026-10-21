import type { ReactNode } from 'react';
export type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
