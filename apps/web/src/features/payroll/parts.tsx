import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ApiError, errorMessage } from '@/lib/api-client';

/** Server validation errors keyed by field, or a single form-level message. */
export function serverErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError) {
    const fields = err.fieldErrors();
    if (Object.keys(fields).length) return fields;
  }
  return { form: errorMessage(err) };
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

export function SectionHeader({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function DialogActions({
  onCancel,
  pending,
  label,
}: {
  onCancel: () => void;
  pending: boolean;
  label: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" loading={pending}>
        {label}
      </Button>
    </div>
  );
}

export function ConfirmDialog({
  title,
  confirmLabel,
  pending,
  error,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  confirmLabel: string;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onClose={onClose} title={title}>
      <div className="grid gap-3">
        <p className="text-sm text-slate-600 dark:text-slate-400">{children}</p>
        {error ? <FormError message={errorMessage(error)} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
