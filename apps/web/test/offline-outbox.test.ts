import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KioskOutbox, MemoryOutboxStore } from '@/features/kiosk/offline-outbox';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = {
  keyId: '00000000-0000-4000-8000-0000000000aa',
  publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
};
const decrypt = (b64: string) =>
  JSON.parse(
    privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(b64, 'base64'),
    ).toString(),
  );

describe('KioskOutbox', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores only ciphertext the server can decrypt, bound to the item id and device time', async () => {
    const now = new Date('2026-11-04T00:05:00.000Z');
    const outbox = new KioskOutbox(new MemoryOutboxStore(), () => now);
    const item = await outbox.enqueue(key, {
      accountNumber: 'EMP-000123',
      pin: '482915',
      type: 'TIME_IN',
    });
    expect(JSON.stringify(item)).not.toContain('482915');
    expect(JSON.stringify(item)).not.toContain('EMP-000123');
    expect(decrypt(item.ciphertext)).toEqual({
      v: 1,
      clientUuid: item.clientUuid,
      accountNumber: 'EMP-000123',
      pin: '482915',
      type: 'TIME_IN',
      occurredAt: now.toISOString(),
    });
  });

  it('removes answered items after sync but keeps deferred ones and everything on network failure', async () => {
    const store = new MemoryOutboxStore();
    const outbox = new KioskOutbox(store);
    const a = await outbox.enqueue(key, {
      accountNumber: 'EMP-000001',
      pin: '111111',
      type: 'TIME_IN',
    });
    const b = await outbox.enqueue(key, {
      accountNumber: 'EMP-000002',
      pin: '222222',
      type: 'TIME_IN',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(outbox.flush('kio_token')).rejects.toThrow(/Unable to reach the server/);
    expect(await outbox.pending()).toHaveLength(2);

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { items: { clientUuid: string }[] };
      expect(body.items.map((i) => Object.keys(i).sort())).toEqual([
        ['ciphertext', 'clientUuid', 'keyId'],
        ['ciphertext', 'clientUuid', 'keyId'],
      ]);
      expect((init.headers as Record<string, string>)['X-Kiosk-Token']).toBe('kio_token');
      expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
      return new Response(
        JSON.stringify({
          results: [
            { clientUuid: a.clientUuid, status: 'APPLIED' },
            { clientUuid: b.clientUuid, status: 'DEFERRED', reason: 'PIN_LOCKED' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const summary = await outbox.flush('kio_token');
    expect(summary).toEqual({ sent: 2, counts: { APPLIED: 1, DEFERRED: 1 } });
    expect((await outbox.pending()).map((i) => i.clientUuid)).toEqual([b.clientUuid]);
  });
});
