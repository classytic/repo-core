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
    // Field leaf ops resolve the path to a value SET (dot-paths fan out
    // over arrays — `items.sku` on `[{sku},{sku}]` yields every `sku`),
    // then match if ANY value — or any ELEMENT of a leaf array value
    // (`tags`, `scores`) — satisfies the scalar predicate. A non-array
    // path with no array yields a single value, so scalar behavior is
    // unchanged. All array unwrapping lives in `someValue`; the
    // predicates (`equals`/`compare`/regex) stay pure scalar.
    case 'eq':
      return someValue(resolve(doc, filter.field), (v) => equals(v, filter.value));
    case 'ne':
      return !someValue(resolve(doc, filter.field), (v) => equals(v, filter.value));
    case 'gt':
      return someValue(resolve(doc, filter.field), (v) => compare(v, filter.value) > 0);
    case 'gte':
      return someValue(resolve(doc, filter.field), (v) => compare(v, filter.value) >= 0);
    case 'lt':
      return someValue(resolve(doc, filter.field), (v) => compare(v, filter.value) < 0);
    case 'lte':
      return someValue(resolve(doc, filter.field), (v) => compare(v, filter.value) <= 0);
    case 'in': {
      const vs = resolve(doc, filter.field);
      return someValue(vs, (v) => filter.values.some((candidate) => equals(v, candidate)));
    }
    case 'nin': {
      const vs = resolve(doc, filter.field);
      return !someValue(vs, (v) => filter.values.some((candidate) => equals(v, candidate)));
    }
    case 'exists': {
      const present = fieldPresent(doc, filter.field);
      return filter.exists ? present : !present;
    }
    case 'like': {
      const flags = filter.caseSensitivity === 'sensitive' ? '' : 'i';
      const re = getOrCompileLike(filter.pattern, flags);
      return someValue(resolve(doc, filter.field), (v) => regexTest(re, v));
    }
    case 'regex': {
      const re = getOrCompileRegex(filter.pattern, filter.flags);
      return someValue(resolve(doc, filter.field), (v) => regexTest(re, v));
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

/**
 * Resolve a dot-path to the SET of values it reaches, fanning out over
 * arrays on intermediate segments (Mongo/JSON-path array semantics):
 * `items.sku` on `{ items: [{ sku: 1 }, { sku: 2 }] }` → `[1, 2]`. A path
 * with no array yields a single-element list, so scalar leaf ops behave
 * exactly as before. A leaf array field (`tags`) is returned as one value
 * (the array) so `equals`'s array-contains handles it.
 */
/**
 * Path segments that must never be resolved — reading them can surface an
 * inherited member (or, for a JSON-parsed doc where `JSON.parse('{"__proto__":
 * …}')` created a real OWN `__proto__`, a crafted value) and produce a WRONG
 * authorization answer. Denied string-normalized (the object-path CVE-2021-23434
 * lesson: an array-typed segment bypassed a `===` check). Fail closed: any
 * path touching one of these resolves to no values → no match.
 */
const DANGEROUS_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function resolve(doc: unknown, path: string): unknown[] {
  let frontier: unknown[] = [doc];
  for (const segment of path.split('.')) {
    if (DANGEROUS_SEGMENTS.has(String(segment))) return [];
    const next: unknown[] = [];
    for (const node of frontier) {
      if (node === null || node === undefined || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        // Traversing INTO an array — Mongo resolves both interpretations of
        // a segment (it tries index AND key):
        //   1. POSITIONAL index (`items.0`) when the segment is a
        //      non-negative integer in range.
        const idx = Number(segment);
        if (Number.isInteger(idx) && idx >= 0 && idx < node.length) {
          next.push(node[idx]);
        }
        //   2. FAN OUT across elements (`items.sku`). (A leaf array value
        //      is pushed by the previous segment and the loop ends;
        //      `someValue` unwraps it at match time.)
        for (const el of node) {
          if (el && typeof el === 'object' && Object.hasOwn(el, segment)) {
            next.push((el as Record<string, unknown>)[segment]);
          }
        }
      } else if (Object.hasOwn(node, segment)) {
        // OWN properties only — never traverse the prototype chain, so a
        // crafted `{ '__proto__.x': ... }` / `{ constructor: ... }` filter
        // can't match inherited members (prototype-pollution-safe reads).
        next.push((node as Record<string, unknown>)[segment]);
      }
    }
    if (next.length === 0) return [];
    frontier = next;
  }
  return frontier;
}

/** Is any value reachable at `path` present (defined + non-null)? */
function fieldPresent(doc: unknown, path: string): boolean {
  const values = resolve(doc, path);
  return values.some((v) => v !== undefined && v !== null);
}

/**
 * Apply a scalar predicate to a resolved value SET, unwrapping leaf array
 * values so a scalar condition on an array field (`tags`, `scores`)
 * matches when ANY element satisfies it — Mongo + SQL array semantics,
 * concentrated in ONE place so `equals`/`compare`/regex stay pure scalar.
 */
function someValue(values: unknown[], pred: (v: unknown) => boolean): boolean {
  for (const v of values) {
    if (Array.isArray(v)) {
      if (v.some(pred)) return true;
    } else if (pred(v)) {
      return true;
    }
  }
  return false;
}

function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN equals NaN for MATCH purposes (Mongo `$eq: NaN` matches stored NaN);
  // `===` says false, so handle it explicitly (Object.is semantics).
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string') return a.toISOString() === b;
  if (b instanceof Date && typeof a === 'string') return b.toISOString() === a;
  // Id-like coercion: compare an id/decimal object (ObjectId, Buffer,
  // Decimal128 — anything with a MEANINGFUL toString) against its string
  // form, so a Mongo `ObjectId` matches its hex string and driver id types
  // match uniformly. Plain objects (`[object Object]`) are excluded — deep
  // equality is not a policy-filter concern.
  const as = idString(a);
  const bs = idString(b);
  if (as !== undefined && bs !== undefined) return as === bs;
  return false;
}

/** String form of an id-like value for coercing comparison; else undefined. */
function idString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return undefined;
  const s = String(value);
  return s === '[object Object]' ? undefined : s;
}

function compare(a: unknown, b: unknown): number {
  // Date ⇄ ISO-string range: coerce the STRING side to the date instant so
  // a `Date` field compares against a JSON-carried ISO string (consistent
  // with `equals`'s Date⇄string handling). Only triggers when one side is a
  // genuine Date — string-vs-string stays lexical, number-vs-number stays
  // numeric, so no surprises for version strings etc.
  if (a instanceof Date && typeof b === 'string') {
    const t = Date.parse(b);
    if (!Number.isNaN(t)) b = new Date(t);
  } else if (b instanceof Date && typeof a === 'string') {
    const t = Date.parse(a);
    if (!Number.isNaN(t)) a = new Date(t);
  }
  const aNum = toComparable(a);
  const bNum = toComparable(b);
  if (aNum === undefined || bNum === undefined) return Number.NaN;
  // Never claim ordering across a number/string type boundary — JS would
  // coerce and give nonsense (`5 < 'abc'` etc.). Return NaN so range ops
  // fail closed instead of matching spuriously.
  if (typeof aNum !== typeof bNum) return Number.NaN;
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

/**
 * Max string length fed to a regex `.test()`. ReDoS is `pattern × input`;
 * even a benign developer-written pattern can go quadratic on a pathological
 * INPUT string — and in a realtime fan-out the matcher runs once per
 * subscriber per record, so one slow match blocks the event loop and
 * amplifies across the whole subscriber set. A field value longer than this
 * is treated as NO MATCH (fail closed) rather than risking a stall; policy
 * filters never regex-test megabyte fields. (Trusted-source patterns make
 * pattern-side ReDoS a non-issue; this caps the input side.)
 */
const MAX_REGEX_INPUT = 64 * 1024;

/** Guarded regex test: string-only, input-length-capped (see MAX_REGEX_INPUT). */
function regexTest(re: RegExp, v: unknown): boolean {
  return typeof v === 'string' && v.length <= MAX_REGEX_INPUT && re.test(v);
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
