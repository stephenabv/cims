/**
 * Canonical permission codes. Roles are data (editable in the database); these codes are the
 * stable contract between the API (enforcement) and the web client (UX gating only).
 *
 * Format: `<module>.<action>[.<scope>]`. A `.all` scope grants company-wide access; a
 * `.department` scope restricts access to departments the actor manages; no scope = own records.
 */
export const PERMISSIONS = {
  // Access & security
  ACCESS_MANAGE: 'access.manage',
  AUDIT_VIEW: 'audit.view',
  SETTINGS_MANAGE: 'settings.manage',
  KIOSK_MANAGE: 'kiosk.manage',

  // Employees & accounts
  EMPLOYEES_VIEW_ALL: 'employees.view.all',
  EMPLOYEES_VIEW_DEPARTMENT: 'employees.view.department',
  EMPLOYEES_CREATE: 'employees.create',
  EMPLOYEES_EDIT_EMPLOYMENT: 'employees.edit.employment',
  EMPLOYEES_EDIT_PERSONAL: 'employees.edit.personal',
  EMPLOYEES_LIFECYCLE: 'employees.lifecycle',
  ACCOUNTS_RESET_CREDENTIALS: 'accounts.reset_credentials',
  ORG_MANAGE: 'org.manage',

  // Attendance
  ATTENDANCE_VIEW_ALL: 'attendance.view.all',
  ATTENDANCE_VIEW_DEPARTMENT: 'attendance.view.department',
  ATTENDANCE_ADJUST: 'attendance.adjust',
  ATTENDANCE_RESOLVE_CONFLICTS: 'attendance.resolve_conflicts',
  SCHEDULES_MANAGE: 'schedules.manage',

  // Leave
  LEAVE_VIEW_ALL: 'leave.view.all',
  LEAVE_VIEW_DEPARTMENT: 'leave.view.department',
  LEAVE_APPROVE: 'leave.approve',
  LEAVE_CANCEL_ANY: 'leave.cancel_any',
  LEAVE_CONFIGURE: 'leave.configure',

  // Overtime / undertime
  OVERTIME_VIEW_ALL: 'overtime.view.all',
  OVERTIME_VIEW_DEPARTMENT: 'overtime.view.department',
  OVERTIME_APPROVE: 'overtime.approve',

  // Payroll
  PAYROLL_VIEW_ALL: 'payroll.view.all',
  PAYROLL_VIEW_SUMMARY: 'payroll.view.summary',
  PAYROLL_PREPARE: 'payroll.prepare',
  PAYROLL_REVIEW: 'payroll.review',
  PAYROLL_FINALIZE: 'payroll.finalize',
  PAYROLL_ADJUST: 'payroll.adjust',
  PAYROLL_CONFIGURE: 'payroll.configure',
  COMPENSATION_VIEW: 'payroll.compensation.view',
  COMPENSATION_EDIT: 'payroll.compensation.edit',

  // Projects
  PROJECTS_VIEW_ALL: 'projects.view.all',
  PROJECTS_MANAGE: 'projects.manage',

  // Reports & dashboards
  REPORTS_VIEW: 'reports.view',
  DASHBOARD_HR: 'dashboard.hr',
  DASHBOARD_EXECUTIVE: 'dashboard.executive',
  DASHBOARD_CEO: 'dashboard.ceo',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSION_CODES: readonly PermissionCode[] = Object.freeze(
  Object.values(PERMISSIONS),
);

export function isPermissionCode(value: string): value is PermissionCode {
  return (ALL_PERMISSION_CODES as readonly string[]).includes(value);
}

/** Built-in role keys seeded at install time. Additional roles may be created at runtime. */
export const SYSTEM_ROLES = {
  CEO: 'CEO',
  EXECUTIVE: 'EXECUTIVE',
  HR: 'HR',
  IT_ADMIN: 'IT_ADMIN',
  STAFF: 'STAFF',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];
