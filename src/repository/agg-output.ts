/**
 * Cross-kit AggResult row-shape normalization.
 *
 * When an `AggRequest` includes `lookups` and `groupBy` references a
 * joined-alias path (e.g. `'department.code'`), the row that lands in
 * `AggResult.rows` carries the joined data as a NESTED object:
 *
 *   ```ts
 *   { status: 'pending', department: { code: 'ENG' }, count: 3 }
 *   ```
 *
 * Same convention `lookupPopulate` uses. Mongokit's `$project` with
 * dotted-key output naturally nests; sqlitekit gets flat-dotted keys
 * from Drizzle's SELECT alias map and runs results through
 * `nestDottedKeys` before returning.
 *
 * **Why nested over flat-dotted?**
 *   - Matches `lookupPopulate` precedent (single convention across
 *     all read primitives).
 *   - JSON-clean: `{ department: { code: 'ENG' } }` round-trips
 *     identically through `JSON.stringify` / `parse`.
 *   - Cleaner consumer code: `row.department.code` vs
 *     `row['department.code']`.
 *   - BSON allows nested but disallows literal `.` in field names —
 *     the only shape that works in mongo without BSON workarounds.
 *
 * **Out of scope**:
 *   - Multi-level dotted paths (`'a.b.c'`) — kits don't emit these
 *     today (single-level joins only). The helper handles them
 *     correctly by recursive descent so future depth is supported.
 *   - Conflicting flat + nested keys on the same row (e.g. both
 *     `department` and `department.code`). The flat-dotted side wins;
 *     a top-level `department` value gets overwritten when a
 *     `department.<x>` partner key is processed. In practice this
 *     never happens — kits emit one or the other per groupBy key.
 */

/**
 * Walk a row's top-level keys, splitting any that contain `.` into
 * nested objects. Keys without `.` pass through unchanged. Mutates a
 * fresh output object — the input is not modified.
 *
 * @example
 * ```ts
 * nestDottedKeys({ status: 'pending', 'department.code': 'ENG', count: 3 })
 * // → { status: 'pending', department: { code: 'ENG' }, count: 3 }
 * ```
 *
 * Multi-level paths (`a.b.c`) recurse:
 *
 * ```ts
 * nestDottedKeys({ 'a.b.c': 1 })
 * // → { a: { b: { c: 1 } } }
 * ```
 */
export function nestDottedKeys<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const dot = key.indexOf('.');
    if (dot < 0) {
      out[key] = value;
      continue;
    }
    setDeep(out, key.split('.'), value);
  }
  return out;
}

/**
 * Convenience wrapper for an array of rows. Returns a new array of
 * normalized rows; the input is not modified.
 */
export function nestDottedKeysAll<T extends Record<string, unknown>>(
  rows: readonly T[],
): Record<string, unknown>[] {
  return rows.map((r) => nestDottedKeys(r));
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

function setDeep(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string;
    const existing = cursor[segment];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
    }
  }
  cursor[path[path.length - 1] as string] = value;
}
