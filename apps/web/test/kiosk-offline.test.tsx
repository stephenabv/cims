import { generateKeyPairSync } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/App';
import { KioskOutbox, MemoryOutboxStore } from '@/features/kiosk/offline-outbox';
import { KioskOutboxContext } from '@/features/kiosk/useOfflineKiosk';
import { AuthProvider } from '@/lib/auth';

const TOKEN = `kio_${'b'.repeat(43)}`;
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  keyId: '00000000-0000-4000-8000-0000000000bb',
  publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
};

/** Every request fails as if the network were down. */
function goOffline() {
  const fn = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderKiosk(outbox: KioskOutbox) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KioskOutboxContext.Provider value={outbox}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/']}>
            <AppRoutes />
          </MemoryRouter>
        </AuthProvider>
      </KioskOutboxContext.Provider>
    </QueryClientProvider>,
  );
}

describe('attendance kiosk offline', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('queues encrypted punches on a registered kiosk while the server is unreachable', async () => {
    localStorage.setItem('cims.kioskSyncKey', JSON.stringify(KEY));
    localStorage.setItem(
      'cims.kioskStatus',
      JSON.stringify({
        device: { name: 'Lobby tablet' },
        acceptsPunches: true,
        companyName: 'Acme Corp',
        timezone: 'Asia/Manila',
        serverTime: '2026-11-01T00:00:00.000Z',
      }),
    );
    goOffline();
    const outbox = new KioskOutbox(new MemoryOutboxStore());
    renderKiosk(outbox);

    expect(
      await screen.findByText(/Offline: punches are saved on this device/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Account number'), '123');
    await userEvent.type(screen.getByLabelText('PIN'), '482915');
    await userEvent.click(screen.getByRole('button', { name: 'Time in' }));

    expect(await screen.findByText('Time in saved offline')).toBeInTheDocument();
    expect(screen.getByText(/1 punch is waiting to be sent/)).toBeInTheDocument();
    const [queued] = await outbox.pending();
    expect(queued).toMatchObject({ keyId: KEY.keyId, type: 'TIME_IN' });
    expect(JSON.stringify(queued)).not.toContain('482915');
  });

  it('does not offer offline punching to a kiosk that never synced its key', async () => {
    goOffline();
    renderKiosk(new KioskOutbox(new MemoryOutboxStore()));
    expect(await screen.findByText('The attendance service is unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument();
  });
});
