/**
 * Scalar coercion. URLs are strings; filters compare against typed fields.
 * The parser uses `fieldTypes` hints when provided, otherwise a safe
 * heuristic that avoids the classic footguns (string SKUs becoming
 * numbers, numeric-looking strings becoming Dates).
 */

import type { QueryParserOptions } from './types.js';

const BOOLEAN_STRINGS = new Set(['true', '1', 'yes', 'on']);
const FALSEY_STRINGS = new Set(['false', '0', 'no', 'off']);
// Tight ISO-8601 — catches 2026-04-19, 2026-04-19T10:00:00Z, millisecond precision.
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Coerce a single URL value to its field-declared type, or to a best-guess
 * scalar when no hint exists. Always returns `string`, `number`, `boolean`,
 * `Date`, or `null` — never `undefined`.
 */
export function coerceValue(
  rawValue: string,
  fieldType: QueryParserOptions['fieldTypes'] extends infer T
    ? T extends Record<string, infer V>
      ? V | undefined
      : undefined
    : undefined,
): unknown {
  if (rawValue === 'null') return null;

  switch (fieldType) {
    case 'number': {
      const n = Number(rawValue);
      return Number.isFinite(n) ? n : rawValue;
    }
    case 'boolean':
      return BOOLEAN_STRINGS.has(rawValue.toLowerCase());
    case 'date': {
      const d = new Date(rawValue);
      return Number.isNaN(d.getTime()) ? rawValue : d;
    }
    case 'string':
      return rawValue;
    default:
      return heuristicCoerce(rawValue);
  }
}

/**
 * Heuristic used when no field-type hint applies. Deliberately conservative:
 *
 * - Pure boolean strings ("true", "false") → boolean.
 * - Unambiguous ISO-8601 dates → Date.
 * - Integers that don't start with 0 (unless literal "0") → number.
 * - Floats → number.
 * - Anything else stays a string.
 *
 * We do NOT coerce arbitrary-looking numeric strings ("12345") because
 * they're routinely SKUs, order IDs, or phone numbers. Callers needing
 * reliable numeric coercion pass `fieldTypes: { age: 'number' }`.
 */
function heuristicCoerce(value: string): unknown {
  if (BOOLEAN_STRINGS.has(value) && value.length <= 5) {
    // only "true" / "1" / "yes" / "on" qualify; "yes" as a name is rare.
    if (value === 'true' || value === 'false') return value === 'true';
  }
  if (FALSEY_STRINGS.has(value) && (value === 'false' || value === 'true')) {
    return value === 'true';
  }
  if (ISO_DATE_RE.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Float pattern — require a dot to avoid coercing integer-like SKUs.
  if (/^-?\d+\.\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

/**
 * Split a comma-separated URL value into an array of coerced scalars.
 * Used by `in`/`nin`/`between` which accept `field[in]=a,b,c`.
 */
export function coerceList(
  rawValue: string,
  fieldType: Parameters<typeof coerceValue>[1],
): unknown[] {
  if (rawValue.length === 0) return [];
  return rawValue.split(',').map((v) => coerceValue(v.trim(), fieldType));
}
