import { nextAccountStatus, revokesSessions } from './account-lifecycle';

describe('account lifecycle', () => {
  it.each([
    ['PENDING_ACTIVATION', 'activate', 'ACTIVE'],
    ['ACTIVE', 'suspend', 'SUSPENDED'],
    ['SUSPENDED', 'reactivate', 'ACTIVE'],
    ['DEACTIVATED', 'reactivate', 'ACTIVE'],
    ['ACTIVE', 'deactivate', 'DEACTIVATED'],
    ['SUSPENDED', 'deactivate', 'DEACTIVATED'],
    ['PENDING_ACTIVATION', 'deactivate', 'DEACTIVATED'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    expect(nextAccountStatus(from, action)).toBe(to);
  });

  it.each([
    ['ACTIVE', 'activate'],
    ['DEACTIVATED', 'suspend'],
    ['PENDING_ACTIVATION', 'suspend'],
    ['ACTIVE', 'reactivate'],
    ['DEACTIVATED', 'deactivate'],
  ] as const)('rejects %s --%s', (from, action) => {
    expect(nextAccountStatus(from, action)).toBeNull();
  });

  it('revokes sessions only for suspended or deactivated accounts', () => {
    expect(revokesSessions('SUSPENDED')).toBe(true);
    expect(revokesSessions('DEACTIVATED')).toBe(true);
    expect(revokesSessions('ACTIVE')).toBe(false);
  });
});
