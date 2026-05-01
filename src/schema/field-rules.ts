/**
 * Pure field-rule helpers — driver-free logic that operates on
 * `SchemaBuilderOptions.fieldRules` + explicit omit lists.
 *
 * Every kit's schema builder calls these helpers for the exact same policy
 * semantics (immutable / systemManaged / optional / explicit omit), so the
 * produced CRUD schemas behave identically across mongokit, sqlitekit, etc.
 *
 * The kit-specific half — walking Mongoose `paths` or Drizzle columns to
 * produce JSON Schemas from native types — stays in the owning kit. Only
 * the policy layer lives here.
 */

import type { JsonSchema, SchemaBuilderOptions, ValidationResult } from './types.js';

/**
 * Collect the set of fields that must NOT appear in a generated schema.
 *
 * Three purposes have three different policies:
 *
 *   - `'create'` / `'update'` (request-body schemas):
 *     1. Always-hidden system fields (`createdAt`, `updatedAt`, `__v`).
 *     2. `fieldRules[field].systemManaged` → hidden from both.
 *     3. `'update'` only: `fieldRules[field].immutable` /
 *        `immutableAfterCreate` → hidden from update.
 *     4. `options.create.omitFields` / `options.update.omitFields` —
 *        explicit caller-provided omit list for the matching purpose.
 *
 *   - `'response'` (response-shape schema):
 *     1. `fieldRules[field].hidden: true` ONLY — passwords, secrets,
 *        internal scoring. Server-set fields (`createdAt`, `updatedAt`,
 *        `_id`, systemManaged, immutable / readonly) ARE returned to
 *        clients and so ARE included in the response shape.
 *     2. `options.response?.omitFields` — explicit caller-provided omit
 *        list when the host wants to strip extra fields from responses
 *        without marking them `hidden` globally.
 *
 * Returns a fresh `Set<string>` so callers can freely mutate.
 */
export function collectFieldsToOmit(
  options: SchemaBuilderOptions,
  purpose: 'create' | 'update' | 'response',
): Set<string> {
  const rules = options?.fieldRules ?? {};

  // Global `excludeFields` applies to every purpose — request bodies AND
  // response. Pre-seed the set so per-purpose logic builds on it.
  const globalExcludes = options?.excludeFields ?? [];

  if (purpose === 'response') {
    // Response policy: keep server-set fields, strip only `hidden`.
    const result = new Set<string>(globalExcludes);
    for (const [field, rule] of Object.entries(rules)) {
      if (rule.hidden) result.add(field);
    }
    const explicit = options?.response?.omitFields;
    if (explicit) {
      for (const f of explicit) result.add(f);
    }
    return result;
  }

  // Request-body policy (create + update).
  const result = new Set(['createdAt', 'updatedAt', '__v', ...globalExcludes]);
  for (const [field, rule] of Object.entries(rules)) {
    if (rule.systemManaged) result.add(field);
    if (purpose === 'update' && (rule.immutable || rule.immutableAfterCreate)) {
      result.add(field);
    }
  }

  const explicit = purpose === 'create' ? options?.create?.omitFields : options?.update?.omitFields;
  if (explicit) {
    for (const f of explicit) result.add(f);
  }

  return result;
}

/**
 * Apply omissions + `optional` overrides to a built JSON Schema in place.
 *
 * Deletes each omitted field from `schema.properties` AND removes it from
 * `schema.required`. Also honors `fieldRules[field].optional` by stripping
 * matching names from `required`.
 *
 * In-place mutation is deliberate: every kit's builder constructs a fresh
 * schema immediately before calling this helper, so there is no risk of
 * aliasing a schema the caller still holds.
 */
export function applyFieldRules(
  schema: JsonSchema,
  fieldsToOmit: Set<string>,
  options: SchemaBuilderOptions,
): void {
  for (const field of fieldsToOmit) {
    if (schema.properties?.[field]) {
      delete (schema.properties as Record<string, unknown>)[field];
    }
    if (schema.required) {
      schema.required = schema.required.filter((k) => k !== field);
    }
  }

  const rules = options?.fieldRules ?? {};
  for (const [field, rule] of Object.entries(rules)) {
    if (rule.optional && schema.required) {
      schema.required = schema.required.filter((k) => k !== field);
    }
  }
}

/**
 * List of fields that cannot be mutated through an update body.
 *
 * Union of:
 *   - Every `fieldRules[field].immutable` / `immutableAfterCreate` entry.
 *   - Every `options.update.omitFields` entry (explicit exclusion still
 *     counts as immutable from the caller's perspective).
 *
 * Returns a deduplicated array; insertion order follows rules-then-omitFields.
 */
export function getImmutableFields(options: SchemaBuilderOptions = {}): string[] {
  const immutable: string[] = [];
  const rules = options?.fieldRules ?? {};

  for (const [field, rule] of Object.entries(rules)) {
    if (rule.immutable || rule.immutableAfterCreate) {
      immutable.push(field);
    }
  }

  for (const f of options?.update?.omitFields ?? []) {
    if (!immutable.includes(f)) immutable.push(f);
  }

  return immutable;
}

/**
 * List of fields that cannot be set by clients on either create or update.
 * These are typically stamps written by the server (audit trail, computed
 * state) regardless of method.
 */
export function getSystemManagedFields(options: SchemaBuilderOptions = {}): string[] {
  const systemManaged: string[] = [];
  const rules = options?.fieldRules ?? {};

  for (const [field, rule] of Object.entries(rules)) {
    if (rule.systemManaged) systemManaged.push(field);
  }

  return systemManaged;
}

/**
 * Convenience: is `fieldName` allowed in an update body?
 *
 * Equivalent to `!getImmutableFields(...).includes(fieldName) &&
 * !getSystemManagedFields(...).includes(fieldName)` — the exact semantics
 * enforced by `validateUpdateBody`.
 */
export function isFieldUpdateAllowed(
  fieldName: string,
  options: SchemaBuilderOptions = {},
): boolean {
  return (
    !getImmutableFields(options).includes(fieldName) &&
    !getSystemManagedFields(options).includes(fieldName)
  );
}

/**
 * Validate an update body against `fieldRules`. Returns every violation so
 * callers can surface a structured error (per-field message) without
 * walking the rules themselves.
 */
export function validateUpdateBody(
  body: Record<string, unknown> = {},
  options: SchemaBuilderOptions = {},
): ValidationResult {
  const violations: NonNullable<ValidationResult['violations']> = [];
  const immutableFields = getImmutableFields(options);
  const systemManagedFields = getSystemManagedFields(options);

  for (const field of Object.keys(body)) {
    if (immutableFields.includes(field)) {
      violations.push({ field, reason: 'Field is immutable' });
    } else if (systemManagedFields.includes(field)) {
      violations.push({ field, reason: 'Field is system-managed' });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
