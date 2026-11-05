import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { saveDeviceToken } from '../kiosk/device-token';
import { type KioskDevice, useKioskDeviceMutations, useKioskDevices } from './api';

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

/** IT administration of attendance terminals. Device keys are shown once, at registration. */
export function KioskDevicesPage() {
  const devices = useKioskDevices();
  const { register, revoke } = useKioskDeviceMutations();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [usedHere, setUsedHere] = useState(false);
  const [revoking, setRevoking] = useState<KioskDevice | null>(null);

  return (
    <>
      <PageHeader
        title="Kiosk devices"
        description="Only registered devices can record attendance. Revoke a device if it is lost or replaced."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card title="Register a device">
          <form
            noValidate
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (trimmed.length < 2) return setNameError('Enter a name of at least 2 characters.');
              setNameError(undefined);
              register.mutate(trimmed, {
                onSuccess: (d) => {
                  setIssued({ name: d.name, token: d.token });
                  setUsedHere(false);
                  setName('');
                },
                onError: (err) => err instanceof ApiError && setNameError(err.fieldErrors().name),
              });
            }}
          >
            <TextField
              label="Device name"
              placeholder="Lobby tablet"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              error={nameError}
            />
            <Button type="submit" loading={register.isPending}>
              Register device
            </Button>
            {register.isError && !nameError && (
              <Alert tone="error">{errorMessage(register.error)}</Alert>
            )}
          </form>
        </Card>

        <Card title="Registered devices">
          {devices.isError ? (
            <Alert tone="error">{errorMessage(devices.error)}</Alert>
          ) : devices.data?.length === 0 ? (
            <EmptyState
              title="No devices yet"
              description="Register the tablet or PC used for attendance."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {(devices.data ?? []).map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-xs text-slate-500">
                      Registered {dateTime(d.createdAt)} ·{' '}
                      {d.lastSeenAt ? `last seen ${dateTime(d.lastSeenAt)}` : 'not used yet'}
                    </p>
                  </div>
                  {d.revokedAt ? (
                    <Badge tone="danger">Revoked</Badge>
                  ) : (
                    <Button variant="secondary" onClick={() => setRevoking(d)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Dialog
        open={issued !== null}
        onClose={() => setIssued(null)}
        title={`Device key for ${issued?.name ?? ''}`}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Copy this key now. It is shown only once; if it is lost, revoke the device and register it
          again.
        </p>
        <p className="mt-3 rounded-lg bg-slate-100 p-3 font-mono text-xs break-all select-all dark:bg-slate-800">
          {issued?.token}
        </p>
        {usedHere && (
          <div className="mt-3">
            <Alert tone="success">
              This browser is now the attendance kiosk. Open the home page (/) to use it.
            </Alert>
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => issued && void navigator.clipboard?.writeText(issued.token)}
          >
            Copy key
          </Button>
          <Button
            variant="secondary"
            disabled={usedHere}
            onClick={() => {
              if (!issued) return;
              saveDeviceToken(issued.token);
              setUsedHere(true);
            }}
          >
            Use this browser as the kiosk
          </Button>
          <Button onClick={() => setIssued(null)}>Done</Button>
        </div>
      </Dialog>

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke this device?"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {revoking?.name} will stop accepting attendance immediately. This cannot be undone;
          register the device again to reuse it.
        </p>
        {revoke.isError && (
          <div className="mt-3">
            <Alert tone="error">{errorMessage(revoke.error)}</Alert>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRevoking(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={revoke.isPending}
            onClick={() =>
              revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })
            }
          >
            Revoke device
          </Button>
        </div>
      </Dialog>
    </>
  );
}
