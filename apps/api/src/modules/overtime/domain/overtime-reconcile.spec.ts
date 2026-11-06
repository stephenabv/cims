import { reconcileOvertime } from './overtime-reconcile';

const rec = (
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'VOIDED',
  actualMinutes = 60,
  hasHistory = false,
) => ({
  status,
  actualMinutes,
  hasHistory,
});

describe('reconcileOvertime', () => {
  it('creates a record only at or above the minimum', () => {
    expect(reconcileOvertime(null, 29, 30)).toEqual({ kind: 'none' });
    expect(reconcileOvertime(null, 30, 30)).toEqual({ kind: 'create', actualMinutes: 30 });
    expect(reconcileOvertime(null, null, 30)).toEqual({ kind: 'none' });
    expect(reconcileOvertime(null, 0, 0)).toEqual({ kind: 'none' });
    expect(reconcileOvertime(null, 1, 0)).toEqual({ kind: 'create', actualMinutes: 1 });
  });

  it('tracks an undecided record and drops it when the overtime goes away', () => {
    expect(reconcileOvertime(rec('PENDING', 60), 60, 30)).toEqual({ kind: 'none' });
    expect(reconcileOvertime(rec('PENDING', 60), 75, 30)).toEqual({
      kind: 'update',
      actualMinutes: 75,
    });
    expect(reconcileOvertime(rec('PENDING', 60), 10, 30)).toEqual({ kind: 'delete' });
    expect(reconcileOvertime(rec('PENDING', 60), null, 30)).toEqual({ kind: 'delete' });
  });

  it('keeps history: a reopened record that loses its overtime is voided, not deleted', () => {
    expect(reconcileOvertime(rec('PENDING', 60, true), 0, 30)).toEqual({
      kind: 'void',
      previousMinutes: 60,
    });
  });

  it('reopens a decision when the minutes change, and voids it when they vanish', () => {
    for (const status of ['APPROVED', 'REJECTED'] as const) {
      expect(reconcileOvertime(rec(status, 60, true), 60, 30)).toEqual({ kind: 'none' });
      expect(reconcileOvertime(rec(status, 60, true), 90, 30)).toEqual({
        kind: 'reopen',
        actualMinutes: 90,
        previousMinutes: 60,
      });
      expect(reconcileOvertime(rec(status, 60, true), null, 30)).toEqual({
        kind: 'void',
        previousMinutes: 60,
      });
    }
  });

  it('brings a voided record back when overtime returns', () => {
    expect(reconcileOvertime(rec('VOIDED', 60, true), 0, 30)).toEqual({ kind: 'none' });
    expect(reconcileOvertime(rec('VOIDED', 60, true), 60, 30)).toEqual({
      kind: 'reopen',
      actualMinutes: 60,
      previousMinutes: 60,
    });
  });
});
