/**
 * Deterministic JSON stringify — equivalent values produce identical output, different values
 * never do. Every cache key and `contentHash` is built on it.
 *
 * WIRE semantics, so a value built in memory serialises like the same value after a JSON round
 * trip: `toJSON` is applied (a `Date` is its ISO string, an ObjectId its hex), an `undefined`
 * property is absent and an `undefined` array slot is `null`. A `RegExp` — which JSON would render
 * `{}`, colliding every pattern — is `{"$regex","$options"}`. Keys sort by code unit, never by
 * locale: a key that moves with the server's ICU data changes every digest. Arrays keep order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof RegExp) {
    return `{"$options":${JSON.stringify(value.flags)},"$regex":${JSON.stringify(value.source)}}`;
  }
  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON === 'function') return stableStringify(toJSON.call(value));
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}
