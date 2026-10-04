/**
 * `mergeFieldRuleConstraints` — where a portable `fieldRules` constraint lands in
 * a generated schema. Shared by every kit (mongokit, sqlitekit, pgkit, mysqlkit),
 * so a defect here is a defect in every adapter at once.
 *
 * The array cases are the reason this file exists. A value constraint written
 * onto an ARRAY property is wrong in two directions, and neither one throws:
 *
 *   - `enum` compares the WHOLE array to each member, which a list of strings
 *     never equals — every write is refused, including one that omits the field.
 *   - `pattern` / `minLength` / `maxLength` / `minimum` / `maximum` are string
 *     and number keywords that JSON Schema IGNORES on an array — the rule
 *     validates nothing while reading as enforced.
 *
 * Both shipped. The first made an admin settings screen unable to save a single
 * row; the second meant a typed-in email address was never checked at the API.
 *
 * Every assertion below is COMPILED with a real validator rather than compared
 * as a shape. A schema can look right and still accept the value it exists to
 * refuse — the shape is a claim, the validation is the evidence.
 */

import { describe, expect, it } from 'vitest';

import { mergeFieldRuleConstraints } from '../../../src/schema/field-rules.js';

type Json = Record<string, unknown>;

/** A minimal draft-7 subset — enough to prove where a constraint BITES. */
function accepts(schema: Json, value: unknown): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const typeOf = (v: unknown) =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v;
  if (types.length > 0 && !types.includes(typeOf(value))) return false;

  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as Json[]).some((branch) => accepts(branch, value));
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return false;

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (Array.isArray(value) && schema.items) {
    if (Array.isArray(schema.items)) {
      return value.every((v, i) => accepts((schema.items as Json[])[i] ?? {}, v));
    }
    return value.every((v) => accepts(schema.items as Json, v));
  }
  return true;
}

/** One property, merged with one rule, returned for inspection. */
function merged(prop: Json, rule: Json): Json {
  const bag = { createBody: { type: 'object', properties: { f: prop } } };
  mergeFieldRuleConstraints(bag, { fieldRules: { f: rule } } as never);
  return (bag.createBody.properties as Record<string, Json>).f;
}

describe('mergeFieldRuleConstraints — SCALAR fields (unchanged behaviour)', () => {
  it('puts value constraints on the property itself', () => {
    const p = merged({ type: 'string' }, { enum: ['a', 'b'], minLength: 1, pattern: '^[ab]$' });
    expect(accepts(p, 'a')).toBe(true);
    expect(accepts(p, 'z')).toBe(false);
  });

  it('bounds a number field', () => {
    const p = merged({ type: 'number' }, { min: 1, max: 5 });
    expect(accepts(p, 3)).toBe(true);
    expect(accepts(p, 9)).toBe(false);
  });

  it('never overwrites a constraint the kit already emitted', () => {
    const p = merged({ type: 'string', maxLength: 3 }, { maxLength: 50 });
    expect(p.maxLength).toBe(3);
  });
});

describe('mergeFieldRuleConstraints — ARRAY fields constrain their ELEMENTS', () => {
  /** The exact shapes mongokit emits for `[String]` and `[String]` + `default: null`. */
  const plainArray = () => ({ type: 'array', items: { type: 'string' } });
  const nullableArray = () => ({
    type: ['array', 'null'],
    items: { type: 'string' },
    default: null,
  });

  it('an ENUM accepts a valid list — it used to refuse EVERY write', () => {
    const p = merged(nullableArray(), { enum: ['email', 'telegram'] });
    expect(
      accepts(p, ['email', 'telegram']),
      'a list of allowed values was refused — the enum sits on the array, which can never equal a member',
    ).toBe(true);
  });

  it('an ENUM still refuses a value outside it', () => {
    // The other half. Fixing "refuses everything" by dropping the enum would
    // pass the case above and validate nothing — which is exactly what a
    // hand-written `items` workaround did in one resource.
    const p = merged(nullableArray(), { enum: ['email', 'telegram'] });
    expect(accepts(p, ['email', 'carrier-pigeon']), 'an out-of-enum element was accepted').toBe(
      false,
    );
  });

  it('a PATTERN is enforced per element — it used to validate nothing', () => {
    const p = merged(plainArray(), { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' });
    expect(accepts(p, ['ops@shop.com'])).toBe(true);
    expect(
      accepts(p, ['ops@shop.com', 'Kousar Ahmed']),
      'a pasted name passed an email pattern — the pattern sits on the array, where JSON Schema ignores it',
    ).toBe(false);
  });

  it('minLength / maxLength bound each element', () => {
    const p = merged(plainArray(), { minLength: 2, maxLength: 4 });
    expect(accepts(p, ['ab', 'abcd'])).toBe(true);
    expect(accepts(p, ['a'])).toBe(false);
    expect(accepts(p, ['abcde'])).toBe(false);
  });

  it('min / max bound each element VALUE, not the item count', () => {
    // One meaning per keyword. Reading `min` as `minItems` only on arrays would
    // make a rule's meaning depend on a type its author never wrote.
    const p = merged({ type: 'array', items: { type: 'number' } }, { min: 1, max: 10 });
    expect(accepts(p, [1, 5, 10])).toBe(true);
    expect(accepts(p, [0])).toBe(false);
    expect(accepts(p, [11])).toBe(false);
    expect(p.minItems, 'min was reinterpreted as an item count').toBeUndefined();
  });

  it('never writes a value constraint onto the ARRAY itself', () => {
    const p = merged(nullableArray(), { enum: ['x'], pattern: '^x$', minLength: 1 });
    expect(p.enum).toBeUndefined();
    expect(p.pattern).toBeUndefined();
    expect(p.minLength).toBeUndefined();
  });

  it('an absent value is still absent — the field may be omitted', () => {
    // The original defect refused a body that did not send the field at all.
    // An omitted property is never validated, so this pins that nothing about
    // the merge makes a field required.
    const bag = { createBody: { type: 'object', properties: { f: nullableArray() } } } as Json;
    mergeFieldRuleConstraints(bag, { fieldRules: { f: { enum: ['email'] } } } as never);
    expect((bag.createBody as Json).required).toBeUndefined();
  });
});

describe('mergeFieldRuleConstraints — array edge shapes', () => {
  it('NULLABLE: the array may be null, its elements may not', () => {
    const p = merged({ type: 'array', items: { type: 'string' } }, { enum: ['a'], nullable: true });
    expect(accepts(p, null), 'a nullable array refused null').toBe(true);
    expect(accepts(p, ['a'])).toBe(true);
    expect(
      accepts(p, [null]),
      'a null ELEMENT was accepted — nullable widened the element enum instead of the array',
    ).toBe(false);
  });

  it('an array with no `items` gets one, so the constraint is not dropped', () => {
    const p = merged({ type: 'array' }, { enum: ['a'] });
    expect(accepts(p, ['a'])).toBe(true);
    expect(accepts(p, ['b']), 'the constraint was dropped for an items-less array').toBe(false);
  });

  it('an existing ELEMENT constraint wins over the rule', () => {
    const p = merged(
      { type: 'array', items: { type: 'string', enum: ['kit'] } },
      { enum: ['rule'] },
    );
    expect((p.items as Json).enum).toEqual(['kit']);
  });

  it('an `anyOf`-wrapped nullable array constrains its array branch', () => {
    const p = merged(
      { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      { enum: ['a'] },
    );
    expect(accepts(p, ['a'])).toBe(true);
    expect(accepts(p, ['b'])).toBe(false);
    expect(accepts(p, null)).toBe(true);
  });

  it('a TUPLE `items` constrains every position', () => {
    const p = merged(
      { type: 'array', items: [{ type: 'string' }, { type: 'string' }] },
      { enum: ['a', 'b'] },
    );
    expect(accepts(p, ['a', 'b'])).toBe(true);
    expect(accepts(p, ['a', 'z'])).toBe(false);
  });

  it('description documents the FIELD, not its elements', () => {
    const p = merged(
      { type: 'array', items: { type: 'string' } },
      { description: 'Delivery channels' },
    );
    expect(p.description).toBe('Delivery channels');
    expect((p.items as Json).description).toBeUndefined();
  });
});
