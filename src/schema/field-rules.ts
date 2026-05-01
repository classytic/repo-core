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

type AnyObj = Record<string, unknown>;

/**
 * Merge constraint-style `fieldRules` into a generated schema bag in place.
 *
 * Operates on the three slots that carry property maps — `createBody`,
 * `updateBody`, `response`. `listQuery` and `params` are skipped (their
 * constraint vocabulary is owned by the kit's query parser).
 *
 * Existing constraints on a property always win — the merge only fills in
 * gaps. Kits that already walk `fieldRules` during base-schema assembly
 * can call this helper for free (the checks are no-ops when constraints
 * already exist).
 *
 * Schema slot type is intentionally loose (`Record<string, unknown> | null
 * | undefined`) so adapters can pass either an `OpenApiSchemas`-shaped bag
 * or a kit-native bag without coercion.
 */
export function mergeFieldRuleConstraints(
  schemas: Record<string, unknown> | null | undefined,
  schemaOptions?: SchemaBuilderOptions,
): void {
  if (!schemas || typeof schemas !== 'object') return;
  const rules = schemaOptions?.fieldRules;
  if (!rules || Object.keys(rules).length === 0) return;

  for (const slot of ['createBody', 'updateBody', 'response'] as const) {
    const slotSchema = (schemas as AnyObj)[slot];
    if (!slotSchema || typeof slotSchema !== 'object') continue;
    const properties = (slotSchema as AnyObj)['properties'] as Record<string, AnyObj> | undefined;
    if (!properties) continue;

    for (const [field, rule] of Object.entries(rules)) {
      const prop = properties[field];
      if (!prop || typeof prop !== 'object') continue;

      if (rule.minLength != null && prop['minLength'] == null) prop['minLength'] = rule.minLength;
      if (rule.maxLength != null && prop['maxLength'] == null) prop['maxLength'] = rule.maxLength;
      if (rule.min != null && prop['minimum'] == null) prop['minimum'] = rule.min;
      if (rule.max != null && prop['maximum'] == null) prop['maximum'] = rule.max;
      if (rule.pattern != null && prop['pattern'] == null) prop['pattern'] = rule.pattern;
      if (rule.enum != null && prop['enum'] == null) prop['enum'] = rule.enum as unknown[];
      if (rule.description != null && prop['description'] == null) {
        prop['description'] = rule.description as string;
      }
      if (rule.nullable === true) applyNullable(prop);
    }
  }
}

/**
 * Widen a JSON Schema property to also accept `null`.
 *
 * Handles the three ways a property can be typed:
 *   - `type: 'string'`     → `type: ['string', 'null']`
 *   - `type: [...]`        → append `'null'` if missing
 *   - `anyOf: [...]`       → append `{ type: 'null' }` branch if missing
 *
 * **Enum interaction:** when the widened prop also carries `enum: [...]`,
 * `null` is appended to the enum list too. AJV's `enum` keyword rejects
 * values not in the list regardless of the widened `type`, so
 * `{ type: ['string','null'], enum: ['a','b'] }` alone would still reject
 * `null`. The fix is `enum: ['a','b', null]`. (The `anyOf` branch dodges
 * this entirely — each branch scopes its own enum.)
 *
 * No-op when the schema already admits null (don't double-wrap) or has
 * no `type` / `anyOf` anchor to widen (e.g. Mixed — already accepts null).
 *
 * Mutates in place — callers already treat the slot schema as owned.
 * Exported so adapters that walk `fieldRules` inline can reuse the same
 * widening logic.
 */
export function applyNullable(prop: Record<string, unknown>): void {
  // anyOf branching: `anyOf: [{...}, {...}]` → add null branch.
  // Check this first so we don't also touch a sibling `type` that's part
  // of an outer composite schema (rare but possible).
  if (Array.isArray(prop['anyOf'])) {
    const hasNull = prop['anyOf'].some(
      (b: unknown) =>
        b !== null &&
        typeof b === 'object' &&
        ((b as AnyObj)['type'] === 'null' || (b as AnyObj)['const'] === null),
    );
    if (!hasNull) prop['anyOf'].push({ type: 'null' });
    return;
  }

  // Array tuple form: `type: ['string', 'null']`
  if (Array.isArray(prop['type'])) {
    if (!prop['type'].includes('null')) prop['type'].push('null');
    widenEnumToIncludeNull(prop);
    return;
  }

  // Single-string form: `type: 'string'` → widen to tuple
  if (typeof prop['type'] === 'string') {
    prop['type'] = [prop['type'], 'null'];
    widenEnumToIncludeNull(prop);
    return;
  }

  // No type anchor — leave untouched. Untyped schemas already match null.
}

/**
 * Append `null` to `enum` when present. Required because AJV's `enum`
 * keyword is independent of `type` — a value must appear in the enum
 * array verbatim even if the widened type says null is allowed.
 */
function widenEnumToIncludeNull(prop: Record<string, unknown>): void {
  if (!Array.isArray(prop['enum'])) return;
  if (prop['enum'].includes(null)) return;
  prop['enum'] = [...prop['enum'], null];
}
