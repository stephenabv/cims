import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Spinner } from '@/components/ui/Spinner';
import { useKioskStatus } from '@/features/kiosk/api';
import { errorMessage } from '@/lib/api-client';

export function Loading() {
  return (
    <div className="flex justify-center py-12 text-brand-700">
      <Spinner />
    </div>
  );
}

/** Company timezone (from the public kiosk status), so times and "today" match the office. */
export function WithCompanyTimezone({ children }: { children: (timezone: string) => ReactNode }) {
  const company = useKioskStatus(null);
  if (company.isError) return <Alert tone="error">{errorMessage(company.error)}</Alert>;
  if (!company.data) return <Loading />;
  return <>{children(company.data.timezone)}</>;
}

/** Filters and paging kept in the URL, so a page can be bookmarked and the back button works. */
export function useQueryState() {
  const [params, setParams] = useSearchParams();
  const update = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  };
  return { params, update };
}
