import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { QueryClient } from '@tanstack/react-query';
import { normalizeUrl, subscribe } from '@/lib/api';
import type { Connection, EngineEvent } from '@/lib/api';
import { eventQueryKeys } from '@/lib/events';
import { queryKeys } from '@/lib/queryKeys';

// The engine link: saved connection from the keychain, the live event stream, and the
// revision counter pages watch to refetch. onInstall resets shell state for a new engine.
export function useEngineConnection(
  cache: QueryClient,
  onInstall: (next: Connection | null) => void,
  onLoadError: (message: string) => void,
) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [live, setLive] = useState('Disconnected');
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [revision, setRevision] = useState(0);
  const callbacks = useRef({ onInstall, onLoadError });
  callbacks.current = { onInstall, onLoadError };
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: queryKeys.all });
    setRevision((value) => value + 1);
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  function installConnection(next: Connection | null) {
    cache.clear();
    setEvents([]);
    setLive(next ? 'Connecting' : 'Disconnected');
    setConnection(next);
    callbacks.current.onInstall(next);
  }
  const installRef = useRef(installConnection);
  installRef.current = installConnection;
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    // The keychain can be briefly busy right after a restart or reload; retry once before
    // reporting, and keep install errors out of the "could not be loaded" message.
    const load = () => invoke<Connection | null>('load_connection');
    void load()
      .catch(() => new Promise((resolve) => setTimeout(resolve, 400)).then(load))
      .then(
        (saved) => {
          if (active && saved) installRef.current({ ...saved, url: normalizeUrl(saved.url) });
        },
        () => {
          if (active)
            callbacks.current.onLoadError(
              'Saved connection could not be loaded. Enter your connection below.',
            );
        },
      );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!connection) return;
    return subscribe(
      connection,
      (event) => {
        if (event.type !== 'resync_required')
          setEvents((values) => [{ ...event, received_at: Date.now() }, ...values].slice(0, 500));
        const keys = eventQueryKeys(event);
        for (const queryKey of keys) void cache.invalidateQueries({ queryKey });
        if (keys.length) setRevision((value) => value + 1);
      },
      setLive,
    );
  }, [connection, cache]);
  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => refreshRef.current(), 30000);
    return () => clearInterval(timer);
  }, [connection, cache]);
  return { connection, live, events, revision, refresh, installConnection };
}
