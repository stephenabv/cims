export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

function serialise(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Field-level differences between two records, limited to `fields`, for the change history. */
export function diffFields<T extends object>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    const oldValue = serialise(before[field]);
    const newValue = serialise(after[field]);
    if (oldValue !== newValue) changes.push({ field, oldValue, newValue });
  }
  return changes;
}
