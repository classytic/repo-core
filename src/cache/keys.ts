/**
 * Cache key derivation. Builds stable keys from operation context so
 * any kit + arc + Express/Nest hosts compute the same key for the
 * same logical request — letting one Redis serve a mixed-kit fleet.
 *
 * **Key shape:**
 *   `<prefix>:<op>:<model>:v<version>:<paramsHash>:<scopeHash>`
 *
 *   - `prefix`     — tenant of the cache namespace (`'rc'` default)
 *   - `op`         — repository operation name (`getById`, `aggregate`, ...)
 *   - `model`      — the entity model name
 *   - `version`    — collection version (bumped on writes; orphans all
 *                    keys for the model in O(1)). Per-scope when the
 *                    plugin extracts a scopeKey.
 *   - `paramsHash` — fnv1a64 of stable-stringified call params
 *                    (filter, id, sort, kit-specific options like
 *                    `lean`). The plugin's per-op allowlist decides
 *                    which fields participate.
 *   - `scopeHash`  — short hash of the auto-extracted scope tags
 *                    (`org:<id>` / `user:<id>`). Keeps the key short
 *                    while preserving cross-tenant isolation.
 */

import { stableStringify } from './stable-stringify.js';

export interface BuildKeyInput {
  readonly prefix: string;
  readonly operation: string;
  readonly model: string;
  /** Collection version — `0` when version tracking is disabled. */
  readonly version: number;
  /**
   * Shape-affecting call parameters. The plugin extracts these via a
   * per-op allowlist so non-shape fields (request IDs, trace headers,
   * timestamps) don't pollute the cache key. Empty object when no
   * shape fields are set — keys still differ by op + model.
   *
   * Aggregate ops MUST strip operational slots (`cache`,
   * `executionHints`) from `params.aggRequest` before passing in —
   * the plugin handles this via `extractShapeFields`.
   */
  readonly params: Readonly<Record<string, unknown>>;
  /** Pre-extracted scope tags (`org:<id>`, `user:<id>`). */
  readonly scopeTags: readonly string[];
}

/** Build the canonical cache key. */
export function buildCacheKey(input: BuildKeyInput): string {
  const paramsHash = fnv1a64(stableStringify(input.params));
  const scopeHash = input.scopeTags.length > 0 ? fnv1a64(input.scopeTags.join('|')) : '0';
  return `${input.prefix}:${input.operation}:${input.model}:v${input.version}:${paramsHash}:${scopeHash}`;
}

/** Tag-index key — maps a tag to the set of cache keys carrying it. */
export function tagIndexKey(prefix: string, tag: string): string {
  return `${prefix}:tag:${tag}`;
}

/**
 * Collection-version key — bumped on writes to orphan all reads.
 *
 * Per-scope sharding when `scopeKey` is supplied — e.g. `'org:abc'`
 * keys to `<prefix>:ver:<model>:org:abc`, so writes inside `org:abc`
 * don't invalidate other tenants' cached reads. Without a scopeKey
 * the version is global (legacy semantic — invalidates all reads on
 * any write).
 */
export function versionKey(prefix: string, model: string, scopeKey?: string): string {
  return scopeKey ? `${prefix}:ver:${model}:${scopeKey}` : `${prefix}:ver:${model}`;
}

/**
 * Build a deterministic scope-key string from extracted scope tags.
 * Used to suffix `versionKey` so per-scope invalidation works.
 *
 * Returns `undefined` when no scope is present — caller falls back to
 * global version semantics.
 */
export function scopeKeyFromTags(scopeTags: readonly string[]): string | undefined {
  if (scopeTags.length === 0) return undefined;
  // Sort to dedupe order variations, then join with separator unlikely
  // to appear in scope identifiers.
  return [...scopeTags].sort().join('|');
}

/**
 * Merge two tag lists, preserving first-seen order and deduping. Used
 * by the plugin to combine caller-supplied tags with auto-derived
 * scope tags into a single index-able set.
 */
export function mergeTags(a: readonly string[], b: readonly string[]): readonly string[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of a) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  for (const t of b) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Extract scope tags from a hook context. Reads the canonical fields
 * multi-tenant + auth plugins inject (`organizationId`, `userId`).
 * Returns an empty array when no scope is present — public reads share
 * one cache slot.
 *
 * Looks at THREE locations in priority order:
 *   1. `context.filter.<field>`    — multi-tenant injects here
 *   2. `context.options.<field>`   — kit options bag (arc audit attribution)
 *   3. `context.<field>`           — top-level fallback
 */
export function extractScopeTags(context: Record<string, unknown> | undefined): string[] {
  if (!context) return [];
  const tags: string[] = [];
  const orgId = pickScopeField(context, 'organizationId');
  if (orgId) tags.push(`org:${orgId}`);
  const userId = pickScopeField(context, 'userId');
  if (userId) tags.push(`user:${userId}`);
  return tags;
}

function pickScopeField(context: Record<string, unknown>, field: string): string | undefined {
  const filter = context['filter'] as Record<string, unknown> | undefined;
  if (filter && typeof filter[field] === 'string') return filter[field] as string;
  const options = context['options'] as Record<string, unknown> | undefined;
  if (options && typeof options[field] === 'string') return options[field] as string;
  if (typeof context[field] === 'string') return context[field] as string;
  return undefined;
}

/**
 * FNV-1a 64-bit — non-cryptographic hash for cache-key shortening.
 * Emits stable base-36 strings (≤13 chars) for compact keys.
 *
 * **Why 64-bit, not 32-bit:** djb2 32-bit (~4B value space) hits ~50%
 * birthday-paradox collision probability around √(2^32) ≈ 65k distinct
 * keys — easily exceeded by a multi-tenant fleet. FNV-1a 64-bit pushes
 * that threshold to ~4B keys, which no realistic cache approaches.
 * Both are non-cryptographic; FNV-1a has better avalanche on short
 * ASCII strings (cache keys).
 *
 * BigInt is required — JS numbers lose precision past 2^53. The cost
 * is negligible at cache-key sizes (key strings are typically <1KB).
 */
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const FNV_MASK_64 = 0xffffffffffffffffn;
function fnv1a64(str: string): string {
  let hash = FNV_OFFSET_64;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME_64) & FNV_MASK_64;
  }
  return hash.toString(36);
}
