/**
 * Update combinators — the typed builder API arc stores and plugin code
 * use instead of hand-constructing Mongo `$`-operator records.
 *
 * Every builder returns a frozen `UpdateSpec` so specs stay immutable in
 * transit. Combine multiple specs with `combineUpdates` (later-wins on
 * conflicts).
 */

import type { UpdateSpec } from './types.js';

// ──────────────────────────────────────────────────────────────────────
// Root builder
// ──────────────────────────────────────────────────────────────────────

/**
 * Compose an `UpdateSpec` from the four primitive mutations.
 *
 * ```ts
 * update({
 *   set:          { status: 'pending', visibleAt: new Date() },
 *   unset:        ['leaseOwner'],
 *   setOnInsert:  { createdAt: new Date() },
 *   inc:          { attempts: 1 },
 * });
 * ```
 *
 * Keys with `undefined` values in `set` / `setOnInsert` are dropped — a
 * common gotcha when spreading optional fields. To actually clear a field,
 * use `unset` instead (matches mongokit's `$set: { x: undefined }` / `$unset`
 * distinction).
 *
 * Throws if every mutation bucket is empty — an update with nothing to
 * do is always a caller bug.
 */
export function update(spec: {
  set?: Record<string, unknown>;
  unset?: readonly string[];
  setOnInsert?: Record<string, unknown>;
  inc?: Record<string, number>;
}): UpdateSpec {
  const set = stripUndefined(spec.set);
  const setOnInsert = stripUndefined(spec.setOnInsert);
  const inc = spec.inc ? Object.freeze({ ...spec.inc }) : undefined;
  const unset = spec.unset && spec.unset.length > 0 ? Object.freeze([...spec.unset]) : undefined;

  const hasAny =
    (set && Object.keys(set).length > 0) ||
    (setOnInsert && Object.keys(setOnInsert).length > 0) ||
    (inc && Object.keys(inc).length > 0) ||
    (unset && unset.length > 0);

  if (!hasAny) {
    throw new Error(
      'update(): spec is empty. At least one of `set`, `unset`, `setOnInsert`, or `inc` must be populated.',
    );
  }

  const node: UpdateSpec = {
    op: 'update',
    ...(set && { set }),
    ...(unset && { unset }),
    ...(setOnInsert && { setOnInsert }),
    ...(inc && { inc }),
  };
  return Object.freeze(node);
}

// ──────────────────────────────────────────────────────────────────────
// Single-mutation shorthands
// ──────────────────────────────────────────────────────────────────────

/** Sugar: `update({ set: fields })`. Most updates are simple assignments. */
export function setFields(fields: Record<string, unknown>): UpdateSpec {
  return update({ set: fields });
}

/** Sugar: `update({ unset: fields })`. */
export function unsetFields(...fields: string[]): UpdateSpec {
  return update({ unset: fields });
}

/** Sugar: `update({ inc: deltas })`. Each key's value is the delta (positive or negative). */
export function incFields(deltas: Record<string, number>): UpdateSpec {
  return update({ inc: deltas });
}

/** Sugar: `update({ setOnInsert: fields })`. Pairs with an upsert. */
export function setOnInsertFields(fields: Record<string, unknown>): UpdateSpec {
  return update({ setOnInsert: fields });
}

// ──────────────────────────────────────────────────────────────────────
// Composition
// ──────────────────────────────────────────────────────────────────────

/**
 * Merge multiple `UpdateSpec` values into one.
 *
 *   - `set` / `setOnInsert` / `inc`: shallow-merged, later entries win per
 *     key. For `inc`, later-wins is usually a bug — callers who want to
 *     stack deltas should pass `inc({ x: a + b })` directly.
 *   - `unset`: concatenated + de-duplicated.
 *
 * Empty input returns an identity-style spec with `set: {}`, which
 * `update()` would reject — so we throw here too. An empty combine is
 * always a caller bug.
 */
export function combineUpdates(...specs: readonly UpdateSpec[]): UpdateSpec {
  if (specs.length === 0) {
    throw new Error('combineUpdates(): at least one spec required.');
  }
  if (specs.length === 1) return specs[0] as UpdateSpec;

  const set: Record<string, unknown> = {};
  const setOnInsert: Record<string, unknown> = {};
  const inc: Record<string, number> = {};
  const unsetSet = new Set<string>();

  for (const s of specs) {
    if (s.set) Object.assign(set, s.set);
    if (s.setOnInsert) Object.assign(setOnInsert, s.setOnInsert);
    if (s.inc) Object.assign(inc, s.inc);
    if (s.unset) for (const f of s.unset) unsetSet.add(f);
  }

  return update({
    ...(Object.keys(set).length > 0 && { set }),
    ...(Object.keys(setOnInsert).length > 0 && { setOnInsert }),
    ...(Object.keys(inc).length > 0 && { inc }),
    ...(unsetSet.size > 0 && { unset: Array.from(unsetSet) }),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Internal
// ──────────────────────────────────────────────────────────────────────

function stripUndefined(
  record: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
}
