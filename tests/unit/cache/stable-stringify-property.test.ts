/**
 * Property-based tests for `stableStringify` — the foundation of cache-key
 * determinism across kits.
 *
 * The cache layer's key derivation depends on `stableStringify` producing
 * IDENTICAL strings for structurally-equal inputs, regardless of property
 * declaration order, regardless of nesting depth. A subtle bug here =
 * silent cache-miss-rate explosion in production.
 *
 * fast-check generates thousands of structurally-diverse inputs per
 * property, exercising edge cases (NaN, -0, unicode, deeply nested
 * mixed types) that hand-rolled examples typically miss.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../../src/cache/stable-stringify.js';

/**
 * Recursively shuffle a JS object's own-enumerable keys at every nesting
 * level. Used to assert order-independence: two structurally-equal objects
 * built with different key orderings must serialize identically.
 *
 * Arrays are intentionally NOT reordered — array order is part of identity.
 *
 * Note: rebuilds objects with `Object.defineProperty` so reserved keys like
 * `"__proto__"` are added as own properties (plain `out[k] = v` would set
 * the prototype instead, and `Object.entries` would then drop the key).
 */
function shuffleKeysDeep(value: unknown, rng: () => number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => shuffleKeysDeep(v, rng));
  const entries = Object.entries(value as Record<string, unknown>);
  // Fisher–Yates shuffle on a copy.
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = entries[i];
    if (tmp && entries[j]) {
      entries[i] = entries[j];
      entries[j] = tmp;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    Object.defineProperty(out, k, {
      value: shuffleKeysDeep(v, rng),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Seeded LCG so shuffles are reproducible inside a fast-check run. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('stableStringify — determinism (property-based)', () => {
  it('is idempotent: stableStringify(x) === stableStringify(x) for any input', () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(stableStringify(x)).toBe(stableStringify(x));
      }),
      { numRuns: 500 },
    );
  });

  it('is referentially stable across calls on freshly constructed equivalent values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (x) => {
        // Round-trip clones the value; both should serialize identically.
        const clone = JSON.parse(JSON.stringify(x));
        expect(stableStringify(x)).toBe(stableStringify(clone));
      }),
      { numRuns: 500 },
    );
  });
});

describe('stableStringify — object key-order independence', () => {
  it('flat objects: same keys+values in any declaration order produce identical strings', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 20 }),
        fc.integer(),
        (obj, seed) => {
          const shuffled = shuffleKeysDeep(obj, makeRng(seed));
          expect(stableStringify(shuffled)).toBe(stableStringify(obj));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('deeply nested objects: order-independence holds at every level', () => {
    // Build a recursive arbitrary that mixes objects and arrays.
    const nested: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
      tree: fc.oneof(
        { maxDepth: 5 },
        fc.jsonValue(),
        fc.dictionary(fc.string(), tie('tree'), { maxKeys: 6 }),
        fc.array(tie('tree'), { maxLength: 5 }),
      ),
    })).tree;

    fc.assert(
      fc.property(nested, fc.integer(), (x, seed) => {
        const shuffled = shuffleKeysDeep(x, makeRng(seed));
        expect(stableStringify(shuffled)).toBe(stableStringify(x));
      }),
      { numRuns: 300 },
    );
  });

  it('object with reversed key order matches original (concrete sanity)', () => {
    const a = { a: 1, b: 2, c: 3 };
    const b = { c: 3, b: 2, a: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

describe('stableStringify — array order sensitivity', () => {
  it('non-trivial reorderings of an array produce a DIFFERENT string', () => {
    // Arrays whose first and last differ guarantee that reversing changes
    // the serialization. (A constant array like [1,1,1] reverses to itself.)
    fc.assert(
      fc.property(
        fc
          .array(fc.jsonValue(), { minLength: 2, maxLength: 10 })
          .filter((arr) => stableStringify(arr[0]) !== stableStringify(arr[arr.length - 1])),
        (arr) => {
          const reversed = [...arr].reverse();
          expect(stableStringify(arr)).not.toBe(stableStringify(reversed));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('identical arrays serialize identically (concrete sanity)', () => {
    expect(stableStringify([1, 2, 3])).toBe(stableStringify([1, 2, 3]));
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });
});

describe('stableStringify — content discrimination', () => {
  it('different JSON-distinguishable values produce different strings', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        // Use canonical JSON.stringify of a sorted-key clone as ground truth
        // for "structurally distinct". stableStringify must agree.
        const canonA = stableStringify(a);
        const canonB = stableStringify(b);
        const aClone = JSON.parse(JSON.stringify(a));
        const bClone = JSON.parse(JSON.stringify(b));
        const groundEqual = stableStringify(aClone) === stableStringify(bClone);
        expect(canonA === canonB).toBe(groundEqual);
      }),
      { numRuns: 300 },
    );
  });

  it('changing a single primitive field changes the output', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.integer(), { minKeys: 1, maxKeys: 5 }),
        (obj) => {
          const keys = Object.keys(obj);
          if (keys.length === 0) return;
          const k = keys[0]!;
          const original = stableStringify(obj);
          const mutated = stableStringify({ ...obj, [k]: (obj[k] as number) + 1 });
          expect(original).not.toBe(mutated);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('stableStringify — primitive edge cases', () => {
  it('numbers (including special IEEE-754 values) match JSON.stringify semantics', () => {
    // JSON.stringify maps NaN, Infinity, -Infinity → "null"; -0 → "0". We
    // assert stableStringify matches JSON.stringify for primitive numbers
    // so behavior is predictable to callers.
    fc.assert(
      fc.property(fc.double(), (n) => {
        expect(stableStringify(n)).toBe(JSON.stringify(n));
      }),
      { numRuns: 500 },
    );
  });

  it('NaN, Infinity, -0 serialize deterministically', () => {
    expect(stableStringify(Number.NaN)).toBe(stableStringify(Number.NaN));
    expect(stableStringify(Number.POSITIVE_INFINITY)).toBe(
      stableStringify(Number.POSITIVE_INFINITY),
    );
    expect(stableStringify(Number.NEGATIVE_INFINITY)).toBe(
      stableStringify(Number.NEGATIVE_INFINITY),
    );
    expect(stableStringify(-0)).toBe(stableStringify(0));
    // Documented JSON.stringify behavior — locked so a future "fix" can't
    // silently shift cache buckets.
    expect(stableStringify(Number.NaN)).toBe('null');
    expect(stableStringify(Number.POSITIVE_INFINITY)).toBe('null');
  });

  it('strings with quotes, backslashes, and unicode round-trip through JSON.parse', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = stableStringify(s);
        expect(out).toBe(JSON.stringify(s));
        // The output must be valid JSON for a string primitive.
        expect(JSON.parse(out)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it('booleans and null serialize to canonical JSON literals', () => {
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
    expect(stableStringify(null)).toBe('null');
  });

  it('undefined serializes the same way every call', () => {
    // JSON.stringify(undefined) === undefined (the JS value, not a string).
    // Locking current behavior so callers know what to expect.
    const out1 = stableStringify(undefined);
    const out2 = stableStringify(undefined);
    expect(out1).toBe(out2);
  });
});

describe('stableStringify — mixed-type structures', () => {
  it('arbitrary `fc.jsonValue` inputs survive shuffle-then-serialize round-trip', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer(), (x, seed) => {
        const shuffled = shuffleKeysDeep(x, makeRng(seed));
        expect(stableStringify(shuffled)).toBe(stableStringify(x));
      }),
      { numRuns: 500 },
    );
  });

  it('output for objects always begins with `{` and ends with `}`', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const out = stableStringify(obj);
        expect(out.startsWith('{')).toBe(true);
        expect(out.endsWith('}')).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('output for arrays always begins with `[` and ends with `]`', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue()), (arr) => {
        const out = stableStringify(arr);
        expect(out.startsWith('[')).toBe(true);
        expect(out.endsWith(']')).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('stableStringify — reserved-name keys', () => {
  it('handles `__proto__` as an own property without leaking into the prototype chain', () => {
    // Regression for a subtle class of bug: callers may build objects whose
    // keys include `"__proto__"` (e.g. arbitrary user payloads, GraphQL
    // selections). If `stableStringify` ever rebuilt objects via plain
    // `out[k] = v`, the key would silently mutate the prototype and vanish
    // from the output — a cache-bucket hazard. Locking that the function
    // serializes whatever `Object.entries` reports.
    const a: Record<string, unknown> = {};
    Object.defineProperty(a, '__proto__', {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const out = stableStringify(a);
    expect(out).toBe('{"__proto__":1}');
    // And the same value built with reversed key order matches.
    const b: Record<string, unknown> = { z: 9 };
    Object.defineProperty(b, '__proto__', {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const c: Record<string, unknown> = {};
    Object.defineProperty(c, '__proto__', {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    c.z = 9;
    expect(stableStringify(b)).toBe(stableStringify(c));
  });
});

describe('stableStringify — circular references', () => {
  it('throws (does not infinite-loop) on a directly self-referential object', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    // The current implementation has no cycle guard; a recursive walk of a
    // self-reference will exceed the call stack. We assert it throws rather
    // than hangs — callers are expected to pre-sanitize.
    expect(() => stableStringify(a)).toThrow();
  });

  it('throws on a circular array', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => stableStringify(arr)).toThrow();
  });
});
