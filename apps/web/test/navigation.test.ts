import { describe, expect, it } from 'vitest';
import { navItemsFor } from '@/app/layout/navigation';

const labels = (granted: string[]) =>
  navItemsFor((...codes) => codes.every((c) => granted.includes(c))).map((i) => i.label);

describe('navigation', () => {
  it('shows only self-service items to staff', () => {
    expect(labels([])).toEqual(['Home', 'My profile', 'Sign-in & security']);
  });
  it('shows the employee directory with either view scope', () => {
    expect(labels(['employees.view.department'])).toContain('Employees');
    expect(labels(['employees.view.all'])).toContain('Employees');
  });
  it('shows organisation admin only with org.manage', () => {
    expect(labels(['org.manage'])).toContain('Departments & positions');
  });
});
