/**
 * URL parameter keys reserved by the framework — never parsed as
 * filter predicates. Two categories:
 *
 * 1. **Pagination / list-control params** — `page`, `limit`, `after`,
 *    `sort`, `select`, `populate`, `search`. Universal across kits;
 *    every backend agrees on their meaning.
 *
 * 2. **Resource-dispatch verbs** — `_count`, `_distinct`, `_exists`.
 *    Arc-style frameworks pick the repo method from these URL keys
 *    (list vs count vs distinct vs exists).
 *
 * **Why an explicit allowlist, not a `_*` namespace.** MongoDB's `_id`
 * (and every kit's analog) is a legitimate filter field; user-defined
 * `_internal`, `_meta`, `_v` fields are common in real schemas. A
 * blanket `key.startsWith('_')` rule silently drops filters on these.
 * Adding a new dispatch verb here is a deliberate ecosystem-wide
 * change — small, audited, and only needed every few major versions.
 */

/**
 * Reserved top-level URL keys handled outside the filter pipeline.
 * Pagination + sort + select + populate + search + resource-dispatch
 * verbs (`_count`, `_distinct`, `_exists`).
 */
export const STANDARD_RESERVED_PARAMS: ReadonlySet<string> = new Set([
  // Pagination + list control
  'page',
  'limit',
  'after',
  'sort',
  'select',
  'populate',
  'search',
  // Resource-dispatch verbs (consumed by arc-style frameworks; kits
  // skip them at filter parse time)
  '_count',
  '_distinct',
  '_exists',
]);

/**
 * True when `key` is a framework-reserved URL parameter and should be
 * skipped during filter parsing.
 *
 * Use in any URL-parser implementation that decides "is this a filter
 * predicate or a control flag?":
 *
 * ```ts
 * for (const [key, value] of params.entries()) {
 *   if (isControlParam(key)) continue;  // skip page, limit, _count, ...
 *   // … parse as filter predicate
 * }
 * ```
 */
export function isControlParam(key: string): boolean {
  return STANDARD_RESERVED_PARAMS.has(key);
}
