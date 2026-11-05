import { describe, expect, it } from 'vitest';
import { navItemsFor } from '@/app/layout/navigation';

const labels = (granted: string[]) =>
  navItemsFor((...codes) => codes.every((c) => granted.includes(c))).map((i) => i.label);

describe('navigation', () => {
  it('shows only self-service items to staff', () => {
    expect(labels([])).toEqual(['Home', 'My profile', 'My attendance', 'Sign-in & security']);
  });
  it('shows the employee directory with either view scope', () => {
    expect(labels(['employees.view.department'])).toContain('Employees');
    expect(labels(['employees.view.all'])).toContain('Employees');
  });
  it('shows attendance admin screens only with their permissions', () => {
    expect(labels(['attendance.view.department'])).toContain('Attendance monitor');
    expect(labels(['schedules.manage'])).toContain('Schedules & holidays');
    expect(labels(['kiosk.manage'])).toContain('Kiosk devices');
    expect(labels([])).not.toEqual(expect.arrayContaining(['Attendance monitor', 'Kiosk devices']));
  });
  it('shows organisation admin only with org.manage', () => {
    expect(labels(['org.manage'])).toContain('Departments & positions');
  });
});
