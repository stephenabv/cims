import { PERMISSIONS, type PermissionCode } from '@cims/shared';

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** All listed permissions are required for the item to appear (UX only). */
  requires?: PermissionCode[];
  /** Alternative to `requires`: any one of these permissions is enough. */
  requiresAny?: PermissionCode[];
}

/** Single source for the sidebar. Modules add entries here as they ship. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'Home', end: true },
  { to: '/app/profile', label: 'My profile' },
  { to: '/app/attendance', label: 'My attendance', end: true },
  {
    to: '/app/attendance/monitor',
    label: 'Attendance monitor',
    requiresAny: [PERMISSIONS.ATTENDANCE_VIEW_ALL, PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT],
  },
  {
    to: '/app/attendance/conflicts',
    label: 'Sync conflicts',
    requires: [PERMISSIONS.ATTENDANCE_RESOLVE_CONFLICTS],
  },
  {
    to: '/app/employees',
    label: 'Employees',
    requiresAny: [PERMISSIONS.EMPLOYEES_VIEW_ALL, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT],
  },
  { to: '/app/org', label: 'Departments & positions', requires: [PERMISSIONS.ORG_MANAGE] },
  { to: '/app/schedules', label: 'Schedules & holidays', requires: [PERMISSIONS.SCHEDULES_MANAGE] },
  { to: '/app/kiosk-devices', label: 'Kiosk devices', requires: [PERMISSIONS.KIOSK_MANAGE] },
  { to: '/app/security', label: 'Sign-in & security' },
];

export function navItemsFor(can: (...codes: PermissionCode[]) => boolean): NavItem[] {
  return NAV_ITEMS.filter(
    (i) =>
      (!i.requires || can(...i.requires)) && (!i.requiresAny || i.requiresAny.some((p) => can(p))),
  );
}
