import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useRouteStore } from '@/stores/route';
import { safeStorage } from '@/stores/storage';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';

export function useDraftGuard(dirty: boolean, save: () => Promise<void>, canSave: boolean) {
  const latest = useRef({ dirty, save, canSave });
  latest.current = { dirty, save, canSave };
  const [pending, setPending] = useState<{ leave: () => void } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const approved = useRef(false);
  function request(leave: () => void) {
    if (!latest.current.dirty) {
      leave();
      return;
    }
    setError('');
    setPending((current) => current ?? { leave });
  }
  useEffect(() => {
    const unsubscribe = useRouteStore.subscribe((next, previous) => {
      if (approved.current || next.page === previous.page || !latest.current.dirty) return;
      // Roll back synchronously before React reads the next route and unmounts the editor.
      approved.current = true;
      useRouteStore.setState(previous);
      approved.current = false;
      if (previous.page !== 'Connect') safeStorage.setItem('straton:last-page', previous.page);
      request(() => {
        approved.current = true;
        useRouteStore.setState({ entries: next.entries, index: next.index, page: next.page });
        if (next.page !== 'Connect') safeStorage.setItem('straton:last-page', next.page);
        approved.current = false;
      });
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty && !approved.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
          const nativeWindow = getCurrentWindow();
          const stop = await nativeWindow.onCloseRequested((event) => {
            if (!latest.current.dirty || approved.current) return;
            event.preventDefault();
            request(() => {
              approved.current = true;
              void nativeWindow.close().catch((e) => {
                approved.current = false;
                setError(String(e));
                setPending({ leave: () => void nativeWindow.close() });
              });
            });
          });
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch((e) => setError('Window close protection unavailable: ' + String(e)));
    }
    return () => {
      disposed = true;
      unsubscribe();
      unlisten?.();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  const dialog = (
    <AlertDialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open && !saving) setPending(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Save your changes?</AlertDialogTitle>
        <AlertDialogDescription>Your definition has unsaved changes.</AlertDialogDescription>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setPending(null)}>
            Keep editing
          </Button>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              const leave = pending?.leave;
              setPending(null);
              leave?.();
            }}
          >
            Discard
          </Button>
          <Button
            disabled={saving || !canSave}
            onClick={async () => {
              const leave = pending?.leave;
              setSaving(true);
              setError('');
              try {
                await latest.current.save();
                setPending(null);
                leave?.();
              } catch (e) {
                setError(String(e));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { request, dialog };
}
