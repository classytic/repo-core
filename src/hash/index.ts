/**
 * Content-addressing — a stable cryptographic hash of any JSON-serializable value.
 *
 * `contentHash(value)` produces the SAME hex digest for structurally-equal values
 * regardless of object key order, so it's suitable for content-addressing:
 * reproducibility snapshots, idempotency keys, ETags, and dedupe. It builds on
 * {@link stableStringify} (canonical JSON) and SHA-256.
 *
 * This is DISTINCT from the cache module's `fnv1a64`: that is a fast,
 * collision-tolerant NON-cryptographic hash for cache-key bucketing. Use
 * `contentHash` when a collision would be a correctness or integrity problem
 * (e.g. "does this recomputation match the stored result?").
 *
 * `Date` values serialize via their ISO string (JSON.stringify default), so a
 * value carrying dates hashes stably across a JSON round-trip.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../cache/stable-stringify.js';

export { stableStringify } from '../cache/stable-stringify.js';

/**
 * SHA-256 hex digest of a value's canonical (key-order-independent) JSON form.
 * Equivalent inputs → identical digest. `algorithm` may be any hash Node's
 * `crypto` supports (default `'sha256'`); `encoding` the digest format
 * (default `'hex'`).
 */
export function contentHash(
  value: unknown,
  options: { algorithm?: string; encoding?: 'hex' | 'base64' | 'base64url' } = {},
): string {
  const { algorithm = 'sha256', encoding = 'hex' } = options;
  return createHash(algorithm).update(stableStringify(value)).digest(encoding);
}
