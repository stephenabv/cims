import type { KioskSyncKey, PunchType } from '@cims/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NetworkError, api } from '@/lib/api-client';
import {
  IndexedDbOutboxStore,
  KioskOutbox,
  MemoryOutboxStore,
  type QueuedPunch,
  syncKeyCache,
} from './offline-outbox';

/** How often a kiosk with queued punches retries while it believes it is online. */
const RETRY_MS = 30_000;

const browserOutbox = new KioskOutbox(
  typeof indexedDB === 'undefined' ? new MemoryOutboxStore() : new IndexedDbOutboxStore(),
);

/** Lets tests supply an isolated outbox; the app uses the browser's IndexedDB. */
export const KioskOutboxContext = createContext<KioskOutbox>(browserOutbox);

export interface OfflineKiosk {
  /** Punches waiting to be sent. */
  pending: number;
  syncing: boolean;
  /** False while the browser reports no connection or the server could not be reached. */
  reachable: boolean;
  /** True when this device can record punches without the server. */
  canQueue: boolean;
  /** Queues a press; without `type` the server decides time in or out on sync. */
  queue(punch: { accountNumber: string; pin: string; type?: PunchType }): Promise<QueuedPunch>;
  /** Sends queued punches now; network failures are swallowed (the queue is kept). */
  flush(): Promise<void>;
}

/**
 * Offline support for a registered kiosk: keeps the server's public key cached, queues punches
 * while offline and sends them when the connection returns (on reconnect and periodically).
 */
export function useOfflineKiosk(token: string | null, registered: boolean): OfflineKiosk {
  const outbox = useContext(KioskOutboxContext);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [reachable, setReachable] = useState(() => navigator.onLine);
  const [key, setKey] = useState<KioskSyncKey | null>(() => syncKeyCache.read());
  const inFlight = useRef<Promise<void> | null>(null);

  const refreshCount = useCallback(
    async () => setPending((await outbox.pending()).length),
    [outbox],
  );

  const flush = useCallback(async () => {
    if (!token) return;
    // One upload at a time: overlapping uploads would only produce DUPLICATE answers.
    inFlight.current ??= (async () => {
      if ((await outbox.pending()).length === 0) return;
      setSyncing(true);
      try {
        await outbox.flush(token);
        setReachable(true);
      } catch (err) {
        if (err instanceof NetworkError) setReachable(false);
        else console.warn('Offline attendance sync failed', err);
      } finally {
        setSyncing(false);
        await refreshCount();
      }
    })().finally(() => {
      inFlight.current = null;
    });
    await inFlight.current;
  }, [outbox, token, refreshCount]);

  // Fetch (or refresh) the public key whenever the device is registered and reachable.
  useEffect(() => {
    if (!token || !registered) return;
    let cancelled = false;
    api<KioskSyncKey>('/kiosk/sync-key', { headers: { 'X-Kiosk-Token': token } })
      .then((k) => {
        if (cancelled) return;
        syncKeyCache.write(k);
        setKey(k);
      })
      .catch(() => {
        /* offline or not registered: keep the cached key */
      });
    return () => {
      cancelled = true;
    };
  }, [token, registered]);

  useEffect(() => {
    void refreshCount().then(() => flush());
    const onOnline = () => {
      setReachable(true);
      void flush();
    };
    const onOffline = () => setReachable(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = setInterval(() => void flush(), RETRY_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearInterval(timer);
    };
  }, [flush, refreshCount]);

  const queue = useCallback<OfflineKiosk['queue']>(
    async (punch) => {
      if (!key) throw new Error('This kiosk is not set up for offline use yet.');
      const item = await outbox.enqueue(key, punch);
      // Punches are only queued after the server could not be reached.
      setReachable(false);
      await refreshCount();
      return item;
    },
    [key, outbox, refreshCount],
  );

  return { pending, syncing, reachable, canQueue: !!token && !!key, queue, flush };
}
