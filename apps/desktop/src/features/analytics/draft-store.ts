const drafts = new Map<string, unknown>();

export function draftKey(scope: string, kind: string, id = 'active') {
  return JSON.stringify([scope, kind, id]);
}

export function readDraft<T>(key: string): T | undefined {
  const value = drafts.get(key);
  return value === undefined ? undefined : (structuredClone(value) as T);
}

export function writeDraft<T>(key: string, value: T) {
  drafts.set(key, structuredClone(value));
}

export function clearDraft(key: string) {
  drafts.delete(key);
}

export type DashboardContinuation = { dashboardId: string; chartId?: string };

export function snapshotSave<T>(target: string | undefined, value: T) {
  return { target, value: structuredClone(value) };
}

export function installExitGuard<T extends { page: string }>(
  store: {
    getState: () => T;
    setState: (state: T) => void;
    subscribe: (listener: (next: T, previous: T) => void) => () => void;
  },
  shouldBlock: () => boolean,
  blocked: (leave: () => void) => void,
) {
  let bypass = false;
  const allow = (leave: () => void) => {
    bypass = true;
    try {
      leave();
    } finally {
      bypass = false;
    }
  };
  const unsubscribe = store.subscribe((next, previous) => {
    if (bypass || !shouldBlock() || next.page === previous.page || next.page === 'Connect') return;
    allow(() => store.setState(previous));
    blocked(() => allow(() => store.setState(next)));
  });
  return { allow, unsubscribe };
}
