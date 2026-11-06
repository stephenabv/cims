import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useMarkNotificationsRead, useNotifications } from '@/features/notifications/api';
import { useAuth } from '@/lib/auth';
import { NAV_SECTIONS, type NavItem, navItemsFor } from './navigation';

export function AppShell() {
  const { user, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setOpen(false), [location.pathname]);

  const items = navItemsFor(can);
  const nav = <SideNav items={items} />;

  return (
    <div className="flex min-h-full">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-sun-400 px-4 py-2 font-semibold text-brand-950 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto bg-brand-950 text-brand-100 md:flex">
        <Brand />
        {nav}
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            type="button"
            className="absolute inset-0 bg-brand-950/60"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
          <aside className="relative flex h-full w-72 max-w-[80%] flex-col overflow-y-auto bg-brand-950 text-brand-100 shadow-xl">
            <Brand />
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-2 border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur sm:px-6 dark:border-slate-800 dark:bg-brand-950/90">
          <button
            type="button"
            className="rounded-full p-2 text-slate-700 hover:bg-slate-100 md:hidden dark:text-slate-200 dark:hover:bg-slate-800"
            aria-label="Open navigation"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <svg className="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h14v2H3z" />
            </svg>
          </button>
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800 sm:flex dark:bg-brand-800 dark:text-brand-100"
            >
              {initials(user?.fullName)}
            </span>
            <span className="min-w-0 truncate text-sm">
              <span className="font-semibold text-brand-950 dark:text-white">{user?.fullName}</span>
              <span className="hidden text-slate-500 sm:inline dark:text-slate-400">
                {' '}
                · <span className="font-mono">{user?.accountNumber}</span>
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell enabled={!!user} />
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await logout();
                navigate('/login', { replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SideNav({ items }: { items: NavItem[] }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {NAV_SECTIONS.map((section) => {
        const inSection = items.filter((i) => i.section === section);
        if (inSection.length === 0) return null;
        return (
          <div key={section}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-brand-300 uppercase">
              {section}
            </p>
            <ul className="grid gap-0.5">
              {inSection.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      clsx(
                        'relative flex min-h-10 items-center rounded-xl px-3 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-white/10 text-white before:absolute before:top-2 before:bottom-2 before:left-0 before:w-1 before:rounded-full before:bg-sun-400'
                          : 'text-brand-100 hover:bg-white/5 hover:text-white',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function NotificationBell({ enabled }: { enabled: boolean }) {
  const list = useNotifications(enabled);
  const markRead = useMarkNotificationsRead();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const unread = list.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => {
          setOpen((o) => !o);
          if (!open && unread > 0) markRead.mutate();
        }}
        className="relative rounded-full p-2 text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M6 9a6 6 0 1 1 12 0c0 4 1.5 6 2 7H4c.5-1 2-3 2-7Zm4 10a2 2 0 0 0 4 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-5 items-center justify-center rounded-full bg-sun-400 px-1 text-[11px] font-bold text-brand-950">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-2rem))] animate-pop overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-lift)] ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
        >
          <p className="border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">
            Notifications
          </p>
          {list.data?.data.length ? (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {list.data.data.map((n) => (
                <li key={n.id}>
                  <Link
                    to={n.link ?? '/app'}
                    onClick={() => setOpen(false)}
                    className="block px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {!n.readAt && (
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full bg-sun-500"
                        />
                      )}
                      {n.title}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-600 dark:text-slate-400">
                      {n.body}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-slate-500">You’re all caught up.</p>
          )}
        </div>
      )}
    </div>
  );
}

function initials(name: string | undefined): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

function Brand() {
  return (
    <div className="flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-5">
      <img src="/icon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <p className="font-bold tracking-tight text-white">CIMS</p>
        <p className="text-[11px] text-brand-300">Company Information</p>
      </div>
    </div>
  );
}
