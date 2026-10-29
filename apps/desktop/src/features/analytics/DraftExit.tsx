import { useEffect, useRef, useState } from 'react';
import { useRouteStore } from '@/stores/route';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { installExitGuard, readDraft, writeDraft } from './draft-store';

export function useDraftExit(dirty: boolean, discard: () => void) {
  const current = useRef({ dirty, discard });
  current.current = { dirty, discard };
  const [pending, setPending] = useState<{ leave: () => void } | null>(null);
  const guard = useRef<ReturnType<typeof installExitGuard> | null>(null);
  useEffect(() => {
    const installed = installExitGuard(
      useRouteStore,
      () => current.current.dirty,
      (leave) => setPending({ leave }),
    );
    guard.current = installed;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current.current.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      installed.unsubscribe();
      guard.current = null;
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  const allow = (leave: () => void) => {
    if (guard.current) guard.current.allow(leave);
    else leave();
  };
  const request = (leave: () => void) => {
    if (current.current.dirty) setPending({ leave });
    else allow(leave);
  };
  const dialog = (
    <Dialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            Your work has not been saved. Keep editing to finish it, or discard changes to leave.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button autoFocus variant="outline" onClick={() => setPending(null)}>
            Keep editing
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const leave = pending?.leave;
              current.current.discard();
              setPending(null);
              if (leave) allow(leave);
            }}
          >
            Discard changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return { request, allow, dialog };
}

export function useDraftValue<T>(key: string, initial: () => T) {
  const [value, setValue] = useState<T>(() => readDraft<T>(key) ?? initial());
  const current = useRef(value);
  current.current = value;
  const update = (next: T | ((current: T) => T)) => {
    const value = typeof next === 'function' ? (next as (current: T) => T)(current.current) : next;
    current.current = value;
    writeDraft(key, value);
    setValue(value);
  };
  return [value, update] as const;
}
