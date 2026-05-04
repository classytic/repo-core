/**
 * In-memory Filter evaluator.
 *
 * Compiles a Filter IR into a predicate `(doc) => boolean`. Used by:
 *
 * - Arc's default `matchesFilter` (drops the "MongoDB-style" caveat in
 *   `DataAdapter.matchesFilter` — any backend's IR evaluates uniformly).
 * - Sqlitekit's / pgkit's test harnesses to verify compiler correctness
 *   without a real DB round-trip.
 * - Client-side filtering in UI layers (arc-next, fluid) when a filter
 *   is already loaded in memory.
 *
 * Semantics:
 * - Field access supports dot notation (`'address.city'`). Undefined path
 *   segments evaluate to `undefined`.
 * - Comparators use JavaScript's strict `<`/`>`/`===`. `Date` instances
 *   compare by `getTime()` (so two `Date` values with the same instant
 *   are `eq`).
 * - `in` / `nin` use SameValueZero equality (`Array.prototype.includes`).
 * - `like` interprets `%` as `.*` and `_` as `.` — matching SQL `LIKE`.
 * - Regex dialect is JavaScript's RegExp; kits targeting different
 *   dialects compile to their native matcher instead of using this.
 */

import type { Filter } from './types.js';

/** Evaluate a filter against a single document. Returns true iff the doc matches. */
export function matchFilter(doc: unknown, filter: Filter): boolean {
  switch (filter.op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'and':
      return filter.children.every((child) => matchFilter(doc, child));
    case 'or':
      return filter.children.some((child) => matchFilter(doc, child));
    case 'not':
      return !matchFilter(doc, filter.child);
    case 'eq':
      return equals(getField(doc, filter.field), filter.value);
    case 'ne':
      return !equals(getField(doc, filter.field), filter.value);
    case 'gt':
      return compare(getField(doc, filter.field), filter.value) > 0;
    case 'gte':
      return compare(getField(doc, filter.field), filter.value) >= 0;
    case 'lt':
      return compare(getField(doc, filter.field), filter.value) < 0;
    case 'lte':
      return compare(getField(doc, filter.field), filter.value) <= 0;
    case 'in': {
      const v = getField(doc, filter.field);
      return filter.values.some((candidate) => equals(v, candidate));
    }
    case 'nin': {
      const v = getField(doc, filter.field);
      return !filter.values.some((candidate) => equals(v, candidate));
    }
    case 'exists': {
      const v = getField(doc, filter.field);
      const present = v !== undefined && v !== null;
      return filter.exists ? present : !present;
    }
    case 'like': {
      const v = getField(doc, filter.field);
      if (typeof v !== 'string') return false;
      const flags = filter.caseSensitivity === 'sensitive' ? '' : 'i';
      return getOrCompileLike(filter.pattern, flags).test(v);
    }
    case 'regex': {
      const v = getField(doc, filter.field);
      if (typeof v !== 'string') return false;
      return getOrCompileRegex(filter.pattern, filter.flags).test(v);
    }
    case 'raw':
      // `raw` embeds a driver-native fragment we can't evaluate in JS.
      // Callers who rely on in-memory filtering must avoid `raw` inside
      // those predicates (or wrap with a custom evaluator we don't offer yet).
      return false;
  }
}

/**
 * Lift a Filter into a standalone predicate closure. Handy for
 * `array.filter(asPredicate(myFilter))`.
 */
export function asPredicate<T>(filter: Filter): (doc: T) => boolean {
  return (doc) => matchFilter(doc, filter);
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

function getField(doc: unknown, path: string): unknown {
  if (!doc || typeof doc !== 'object') return undefined;
  const segments = path.split('.');
  let cursor: unknown = doc;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function equals(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string') return a.toISOString() === b;
  if (b instanceof Date && typeof a === 'string') return b.toISOString() === a;
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const aNum = toComparable(a);
  const bNum = toComparable(b);
  if (aNum === undefined || bNum === undefined) return Number.NaN;
  if (aNum < bNum) return -1;
  if (aNum > bNum) return 1;
  return 0;
}

function toComparable(value: unknown): number | string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return undefined;
}

/**
 * Compiled-RegExp caches keyed by `pattern|flags`. Without these, a
 * filter run via `asPredicate(filter)` over an N-doc array compiles a
 * fresh `new RegExp(...)` on every doc — at 100k docs and a non-trivial
 * pattern, that's measurable. Bounded LRU eviction keeps the cache
 * from growing unboundedly when callers hand us thousands of distinct
 * patterns (e.g. "name LIKE %" personalization at scale).
 */
const REGEX_CACHE_LIMIT = 256;
const likeCache = new Map<string, RegExp>();
const regexCache = new Map<string, RegExp>();

function getOrCompileLike(pattern: string, flags: string): RegExp {
  const key = `${flags}|${pattern}`;
  let re = likeCache.get(key);
  if (re) return re;
  re = new RegExp(`^${likeToRegex(pattern)}$`, flags);
  if (likeCache.size >= REGEX_CACHE_LIMIT) {
    const oldest = likeCache.keys().next().value;
    if (oldest !== undefined) likeCache.delete(oldest);
  }
  likeCache.set(key, re);
  return re;
}

function getOrCompileRegex(pattern: string, flags: string | undefined): RegExp {
  const f = flags ?? '';
  const key = `${f}|${pattern}`;
  let re = regexCache.get(key);
  if (re) return re;
  re = new RegExp(pattern, f);
  if (regexCache.size >= REGEX_CACHE_LIMIT) {
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) regexCache.delete(oldest);
  }
  regexCache.set(key, re);
  return re;
}

/** SQL `LIKE` pattern → JS regex body. Escapes regex metachars; `%` → `.*`, `_` → `.`. */
function likeToRegex(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '%') {
      out += '.*';
    } else if (ch === '_') {
      out += '.';
    } else if (/[.*+?^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}
