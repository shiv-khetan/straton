export function isDirty(draft: unknown, baseline: unknown): boolean {
  return JSON.stringify(draft) !== JSON.stringify(baseline);
}

export function saveSnapshot<T>(id: string | null, draft: T): { id: string | null; draft: T } {
  return { id, draft: structuredClone(draft) };
}
