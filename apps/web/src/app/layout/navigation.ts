import type { PermissionCode } from '@cims/shared';

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** All listed permissions are required for the item to appear (UX only). */
  requires?: PermissionCode[];
}

/** Single source for the sidebar. Modules add entries here as they ship. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'Home', end: true },
  { to: '/app/security', label: 'Sign-in & security' },
];

export function navItemsFor(can: (...codes: PermissionCode[]) => boolean): NavItem[] {
  return NAV_ITEMS.filter((i) => !i.requires || can(...i.requires));
}
