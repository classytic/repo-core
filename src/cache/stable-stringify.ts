/**
 * Deterministic JSON stringify — equivalent values produce identical output.
 *
 * Used by kits that build cache keys from hook contexts so
 * `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }` hash to the same bucket. Arrays
 * preserve order (order is part of array identity).
 *
 * Extracted from the mongokit / sqlitekit cache plugins into repo-core so
 * every kit's cachePlugin uses the same keying rule — cross-kit caches
 * remain bucket-compatible.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
