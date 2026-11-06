import { describe, expect, it } from 'vitest';
import { navItemsFor } from '@/app/layout/navigation';

const labels = (granted: string[]) =>
  navItemsFor((...codes) => codes.every((c) => granted.includes(c))).map((i) => i.label);

describe('navigation', () => {
  it('shows only self-service items to staff', () => {
    expect(labels([])).toEqual([
      'Home',
      'My profile',
      'My attendance',
      'My leave',
      'Sign-in & security',
    ]);
  });
  it('shows the employee directory with either view scope', () => {
    expect(labels(['employees.view.department'])).toContain('Employees');
    expect(labels(['employees.view.all'])).toContain('Employees');
  });
  it('shows attendance admin screens only with their permissions', () => {
    expect(labels(['attendance.view.department'])).toContain('Attendance monitor');
    expect(labels(['schedules.manage'])).toContain('Schedules & holidays');
    expect(labels(['kiosk.manage'])).toContain('Kiosk devices');
    expect(labels(['attendance.resolve_conflicts'])).toContain('Sync conflicts');
    expect(labels([])).not.toEqual(expect.arrayContaining(['Attendance monitor', 'Kiosk devices']));
  });
  it('shows leave administration only with its permissions', () => {
    expect(labels(['leave.approve'])).toContain('Leave approvals');
    expect(labels(['leave.view.department'])).toContain('Leave records');
    expect(labels(['leave.configure'])).toContain('Leave settings');
    expect(labels([])).not.toEqual(expect.arrayContaining(['Leave approvals']));
  });
  it('shows overtime screens only with overtime permissions', () => {
    expect(labels(['overtime.approve'])).toContain('Overtime');
    expect(labels(['overtime.approve'])).not.toContain('Overtime & undertime');
    expect(labels(['overtime.view.department'])).toEqual(
      expect.arrayContaining(['Overtime', 'Overtime & undertime']),
    );
    expect(labels([])).not.toContain('Overtime');
  });
  it('shows pay screens only with payroll permissions', () => {
    expect(labels(['payroll.compensation.view'])).toContain('Pay setup');
    expect(labels(['payroll.compensation.view'])).not.toContain('Payroll settings');
    expect(labels(['payroll.configure'])).toContain('Payroll settings');
    expect(labels([])).not.toEqual(expect.arrayContaining(['Pay setup']));
  });
  it('shows organisation admin only with org.manage', () => {
    expect(labels(['org.manage'])).toContain('Departments & positions');
  });
});
