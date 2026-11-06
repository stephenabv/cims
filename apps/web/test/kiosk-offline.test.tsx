import { generateKeyPairSync } from 'node:crypto';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    onlineManager.setOnline(true);
  });

  function primeRegisteredKiosk() {
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
  }

  it('queues encrypted punches on a registered kiosk while the server is unreachable', async () => {
    primeRegisteredKiosk();
    goOffline();
    const outbox = new KioskOutbox(new MemoryOutboxStore());
    renderKiosk(outbox);

    expect(
      await screen.findByText(/Offline: punches are saved on this device/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Employee number'), '123');
    await userEvent.type(screen.getByLabelText('PIN'), '482915');
    await userEvent.click(screen.getByRole('button', { name: 'Record attendance' }));
    expect(await screen.findByText('Save attendance offline?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save offline' }));

    expect(await screen.findByText('Attendance saved offline')).toBeInTheDocument();
    expect(screen.getByText(/1 punch is waiting to be sent/)).toBeInTheDocument();
    const [queued] = await outbox.pending();
    // The server decides time in or out when it receives the press.
    expect(queued).toMatchObject({ keyId: KEY.keyId, type: 'AUTO' });
    expect(JSON.stringify(queued)).not.toContain('482915');
  });

  it('still queues when the browser itself reports no connection', async () => {
    // Regression: requests paused by the query library while offline must not hang the kiosk.
    primeRegisteredKiosk();
    goOffline();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onlineManager.setOnline(false);
    const outbox = new KioskOutbox(new MemoryOutboxStore());
    renderKiosk(outbox);

    expect(
      await screen.findByText(/Offline: punches are saved on this device/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Employee number'), '123');
    await userEvent.type(screen.getByLabelText('PIN'), '482915');
    await userEvent.click(screen.getByRole('button', { name: 'Record attendance' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save offline' }));
    expect(await screen.findByText('Attendance saved offline')).toBeInTheDocument();
    expect(await outbox.pending()).toHaveLength(1);
  });

  it('does not offer offline punching to a kiosk that never synced its key', async () => {
    goOffline();
    renderKiosk(new KioskOutbox(new MemoryOutboxStore()));
    expect(await screen.findByText('The attendance service is unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument();
  });
});
