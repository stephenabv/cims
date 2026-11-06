import type {
  KioskSyncKey,
  KioskSyncResult,
  OfflinePunchPayload,
  PunchType,
  SyncItemStatus,
} from '@cims/shared';
import { MAX_SYNC_ITEMS } from '@cims/shared';
import { api } from '@/lib/api-client';

/**
 * Offline attendance outbox (spec §4, architecture §6).
 *
 * While the server is unreachable, a registered kiosk encrypts each punch (account number, PIN,
 * type, device time) with the server's RSA-OAEP public key and queues the ciphertext. The device
 * never stores PINs in readable form and cannot verify them itself; the server does on sync.
 */

export interface QueuedPunch {
  clientUuid: string;
  keyId: string;
  ciphertext: string;
  /**
   * Kept in clear only for the on-screen pending count and age; carries no credentials.
   * `AUTO`: unified button, the server decides time in or out when the punch is synced.
   */
  type: PunchType | 'AUTO';
  queuedAt: string;
}

/** Storage port so the outbox can be backed by IndexedDB in browsers and memory in tests. */
export interface OutboxStore {
  add(item: QueuedPunch): Promise<void>;
  all(): Promise<QueuedPunch[]>;
  remove(clientUuids: string[]): Promise<void>;
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly items = new Map<string, QueuedPunch>();
  async add(item: QueuedPunch): Promise<void> {
    this.items.set(item.clientUuid, item);
  }
  async all(): Promise<QueuedPunch[]> {
    return [...this.items.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }
  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.items.delete(id);
  }
}

const DB_NAME = 'cims-kiosk';
const STORE = 'outbox';

export class IndexedDbOutboxStore implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'clientUuid' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Cannot open offline storage'));
    });
    return this.db;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error ?? new Error('Offline storage error'));
      tx.onabort = () => reject(tx.error ?? new Error('Offline storage aborted'));
    });
  }

  async add(item: QueuedPunch): Promise<void> {
    await this.run('readwrite', (s) => s.add(item));
  }
  async all(): Promise<QueuedPunch[]> {
    const items =
      (await this.run('readonly', (s) => s.getAll() as IDBRequest<QueuedPunch[]>)) ?? [];
    return items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }
  async remove(ids: string[]): Promise<void> {
    await this.run('readwrite', (s) => {
      for (const id of ids) s.delete(id);
    });
  }
}

const KEY_CACHE = 'cims.kioskSyncKey';

/** The public key is not secret; caching it lets the kiosk keep working after a restart offline. */
export const syncKeyCache = {
  read(): KioskSyncKey | null {
    try {
      const raw = localStorage.getItem(KEY_CACHE);
      const v = raw ? (JSON.parse(raw) as Partial<KioskSyncKey>) : null;
      return v && typeof v.keyId === 'string' && typeof v.publicKeySpki === 'string'
        ? (v as KioskSyncKey)
        : null;
    } catch {
      return null;
    }
  },
  write(key: KioskSyncKey): void {
    localStorage.setItem(KEY_CACHE, JSON.stringify(key));
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY_CACHE);
    } catch {
      /* storage unavailable */
    }
  },
};

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function encryptPayload(
  key: KioskSyncKey,
  payload: OfflinePunchPayload,
): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(key.publicKeySpki),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return bytesToBase64(encrypted);
}

export interface FlushSummary {
  sent: number;
  counts: Partial<Record<SyncItemStatus, number>>;
}

export class KioskOutbox {
  constructor(
    private readonly store: OutboxStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Encrypts and queues a punch. The occurred-at time is this device's clock (validated on sync). */
  async enqueue(
    key: KioskSyncKey,
    punch: { accountNumber: string; pin: string; type?: PunchType },
  ): Promise<QueuedPunch> {
    const clientUuid = crypto.randomUUID();
    const at = this.now().toISOString();
    const { accountNumber, pin, type } = punch;
    const payload: OfflinePunchPayload = type
      ? { v: 1, clientUuid, occurredAt: at, accountNumber, pin, type }
      : { v: 2, clientUuid, occurredAt: at, accountNumber, pin };
    const ciphertext = await encryptPayload(key, payload);
    const item: QueuedPunch = {
      clientUuid,
      keyId: key.keyId,
      ciphertext,
      type: type ?? 'AUTO',
      queuedAt: at,
    };
    await this.store.add(item);
    return item;
  }

  pending(): Promise<QueuedPunch[]> {
    return this.store.all();
  }

  /**
   * Uploads queued punches oldest first. Every item the server answered for is removed except
   * DEFERRED ones (e.g. PIN temporarily locked), which stay for the next attempt. Network errors
   * propagate and leave the queue untouched.
   */
  async flush(deviceToken: string): Promise<FlushSummary> {
    const items = await this.store.all();
    const summary: FlushSummary = { sent: 0, counts: {} };
    for (let i = 0; i < items.length; i += MAX_SYNC_ITEMS) {
      const chunk = items.slice(i, i + MAX_SYNC_ITEMS);
      const res = await api<KioskSyncResult>('/kiosk/sync', {
        method: 'POST',
        csrf: false,
        headers: { 'X-Kiosk-Token': deviceToken },
        body: {
          items: chunk.map(({ clientUuid, keyId, ciphertext }) => ({
            clientUuid,
            keyId,
            ciphertext,
          })),
        },
      });
      const done = res.results.filter((r) => r.status !== 'DEFERRED').map((r) => r.clientUuid);
      await this.store.remove(done);
      summary.sent += chunk.length;
      for (const r of res.results) summary.counts[r.status] = (summary.counts[r.status] ?? 0) + 1;
    }
    return summary;
  }
}
