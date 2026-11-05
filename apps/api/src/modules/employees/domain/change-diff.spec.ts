import { diffFields } from './change-diff';

describe('diffFields', () => {
  it('reports only changed, listed fields and normalises dates', () => {
    const before = {
      a: 'x',
      b: null as string | null,
      c: new Date('2026-01-05T00:00:00Z'),
      secret: 's',
    };
    const changes = diffFields(
      before,
      { a: 'x', b: 'y', c: new Date('2026-02-01T00:00:00Z'), secret: 't' },
      ['a', 'b', 'c'],
    );
    expect(changes).toEqual([
      { field: 'b', oldValue: null, newValue: 'y' },
      { field: 'c', oldValue: '2026-01-05', newValue: '2026-02-01' },
    ]);
  });

  it('ignores fields absent from the update', () => {
    expect(diffFields({ a: 1 }, {}, ['a'])).toEqual([]);
  });
});
