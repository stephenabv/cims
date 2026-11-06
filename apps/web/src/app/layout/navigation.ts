import { PERMISSIONS, type PermissionCode } from '@cims/shared';

export type NavSection = 'Me' | 'Team & approvals' | 'HR & payroll' | 'Administration';

export interface NavItem {
  to: string;
  label: string;
  /** Sidebar group; items keep their listed order within a group. */
  section: NavSection;
  end?: boolean;
  /** All listed permissions are required for the item to appear (UX only). */
  requires?: PermissionCode[];
  /** Alternative to `requires`: any one of these permissions is enough. */
  requiresAny?: PermissionCode[];
}

/** Single source for the sidebar. Modules add entries here as they ship. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'Home', section: 'Me', end: true },
  { to: '/app/profile', label: 'My profile', section: 'Me' },
  { to: '/app/attendance', label: 'My attendance', section: 'Me', end: true },
  { to: '/app/attendance/corrections', label: 'Attendance corrections', section: 'Me' },
  {
    to: '/app/attendance/monitor',
    label: 'Attendance monitor',
    section: 'Team & approvals',
    requiresAny: [PERMISSIONS.ATTENDANCE_VIEW_ALL, PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT],
  },
  {
    to: '/app/attendance/conflicts',
    label: 'Sync conflicts',
    section: 'HR & payroll',
    requires: [PERMISSIONS.ATTENDANCE_RESOLVE_CONFLICTS],
  },
  { to: '/app/leave', label: 'My leave', section: 'Me', end: true },
  {
    to: '/app/leave/approvals',
    label: 'Leave approvals',
    section: 'Team & approvals',
    requires: [PERMISSIONS.LEAVE_APPROVE],
  },
  {
    to: '/app/leave/requests',
    label: 'Leave records',
    section: 'Team & approvals',
    requiresAny: [PERMISSIONS.LEAVE_VIEW_ALL, PERMISSIONS.LEAVE_VIEW_DEPARTMENT],
  },
  {
    to: '/app/leave/settings',
    label: 'Leave settings',
    section: 'HR & payroll',
    requires: [PERMISSIONS.LEAVE_CONFIGURE],
  },
  {
    to: '/app/overtime',
    label: 'Overtime',
    section: 'Team & approvals',
    end: true,
    requiresAny: [
      PERMISSIONS.OVERTIME_APPROVE,
      PERMISSIONS.OVERTIME_VIEW_ALL,
      PERMISSIONS.OVERTIME_VIEW_DEPARTMENT,
    ],
  },
  {
    to: '/app/overtime/summary',
    label: 'Overtime & undertime',
    section: 'Team & approvals',
    requiresAny: [PERMISSIONS.OVERTIME_VIEW_ALL, PERMISSIONS.OVERTIME_VIEW_DEPARTMENT],
  },
  {
    to: '/app/payroll/employees',
    label: 'Pay setup',
    section: 'HR & payroll',
    requires: [PERMISSIONS.COMPENSATION_VIEW],
  },
  {
    to: '/app/payroll/settings',
    label: 'Payroll settings',
    section: 'HR & payroll',
    requires: [PERMISSIONS.PAYROLL_CONFIGURE],
  },
  {
    to: '/app/employees',
    label: 'Employees',
    section: 'Team & approvals',
    requiresAny: [PERMISSIONS.EMPLOYEES_VIEW_ALL, PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT],
  },
  {
    to: '/app/org',
    label: 'Departments & positions',
    section: 'Administration',
    requires: [PERMISSIONS.ORG_MANAGE],
  },
  {
    to: '/app/schedules',
    label: 'Schedules & holidays',
    section: 'HR & payroll',
    requires: [PERMISSIONS.SCHEDULES_MANAGE],
  },
  {
    to: '/app/kiosk-devices',
    label: 'Kiosk devices',
    section: 'Administration',
    requires: [PERMISSIONS.KIOSK_MANAGE],
  },
  { to: '/app/security', label: 'Sign-in & security', section: 'Me' },
];

export const NAV_SECTIONS: readonly NavSection[] = [
  'Me',
  'Team & approvals',
  'HR & payroll',
  'Administration',
];

export function navItemsFor(can: (...codes: PermissionCode[]) => boolean): NavItem[] {
  return NAV_ITEMS.filter(
    (i) =>
      (!i.requires || can(...i.requires)) && (!i.requiresAny || i.requiresAny.some((p) => can(p))),
  );
}
