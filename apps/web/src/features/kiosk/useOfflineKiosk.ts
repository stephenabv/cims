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
  /** True when this device can record punches without the server. */
  canQueue: boolean;
  queue(punch: { accountNumber: string; pin: string; type: PunchType }): Promise<QueuedPunch>;
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
      } catch (err) {
        if (!(err instanceof NetworkError)) console.warn('Offline attendance sync failed', err);
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
    const onOnline = () => void flush();
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => void flush(), RETRY_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [flush, refreshCount]);

  const queue = useCallback<OfflineKiosk['queue']>(
    async (punch) => {
      if (!key) throw new Error('This kiosk is not set up for offline use yet.');
      const item = await outbox.enqueue(key, punch);
      await refreshCount();
      return item;
    },
    [key, outbox, refreshCount],
  );

  return { pending, syncing, canQueue: !!token && !!key, queue, flush };
}
