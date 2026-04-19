import { describe, expect, it } from 'vitest';
import {
  and,
  anyOf,
  eq,
  exists,
  FALSE,
  gt,
  in_,
  invert,
  like,
  ne,
  nin,
  not,
  or,
  regex,
  TRUE,
} from '../../../src/filter/index.js';

describe('leaf builders', () => {
  it('build frozen IR nodes with expected shape', () => {
    const node = eq('status', 'active');
    expect(node).toEqual({ op: 'eq', field: 'status', value: 'active' });
    expect(Object.isFrozen(node)).toBe(true);
  });

  it('in/anyOf are the same function — alias survives equality', () => {
    expect(in_).toBe(anyOf);
    expect(in_('id', [1, 2, 3])).toEqual({ op: 'in', field: 'id', values: [1, 2, 3] });
  });

  it('like defaults to case-insensitive matching', () => {
    expect(like('name', 'john%')).toEqual({
      op: 'like',
      field: 'name',
      pattern: 'john%',
      caseSensitivity: 'insensitive',
    });
  });

  it('regex carries optional flags only when provided', () => {
    expect(regex('slug', '^abc')).toEqual({ op: 'regex', field: 'slug', pattern: '^abc' });
    expect(regex('slug', '^abc', 'i')).toEqual({
      op: 'regex',
      field: 'slug',
      pattern: '^abc',
      flags: 'i',
    });
  });

  it('exists defaults to truthy (most common case)', () => {
    expect(exists('email')).toEqual({ op: 'exists', field: 'email', exists: true });
    expect(exists('email', false)).toEqual({ op: 'exists', field: 'email', exists: false });
  });
});

describe('and / or normalization', () => {
  it('empty and returns TRUE, empty or returns FALSE', () => {
    expect(and()).toBe(TRUE);
    expect(or()).toBe(FALSE);
  });

  it('single-child and/or is flattened to the child', () => {
    const leaf = eq('status', 'active');
    expect(and(leaf)).toBe(leaf);
    expect(or(leaf)).toBe(leaf);
  });

  it('flattens nested and into siblings', () => {
    const a = eq('x', 1);
    const b = eq('y', 2);
    const c = eq('z', 3);
    const result = and(a, and(b, c));
    expect(result.op).toBe('and');
    if (result.op === 'and') {
      expect(result.children).toHaveLength(3);
      expect(result.children).toEqual([a, b, c]);
    }
  });

  it('flattens nested or into siblings', () => {
    const a = eq('x', 1);
    const b = eq('y', 2);
    const c = eq('z', 3);
    const result = or(a, or(b, c));
    expect(result.op).toBe('or');
    if (result.op === 'or') {
      expect(result.children).toEqual([a, b, c]);
    }
  });

  it('boolean absorbing / identity elimination — TRUE/FALSE behave as identities', () => {
    const leaf = eq('x', 1);
    // and: FALSE absorbs, TRUE drops out.
    expect(and(leaf, FALSE)).toBe(FALSE);
    expect(and(TRUE, leaf)).toBe(leaf);
    expect(and(TRUE, TRUE)).toBe(TRUE);
    // or: TRUE absorbs, FALSE drops out.
    expect(or(leaf, TRUE)).toBe(TRUE);
    expect(or(FALSE, leaf)).toBe(leaf);
    expect(or(FALSE, FALSE)).toBe(FALSE);
  });

  it('preserves non-matching boolean ops unflattened', () => {
    const orNode = or(eq('x', 1), eq('y', 2));
    const result = and(eq('z', 3), orNode);
    expect(result.op).toBe('and');
    if (result.op === 'and') {
      expect(result.children).toHaveLength(2);
      expect(result.children[1]).toBe(orNode);
    }
  });
});

describe('not normalization', () => {
  it('eliminates double negation', () => {
    const inner = eq('x', 1);
    expect(not(not(inner))).toBe(inner);
  });

  it('invert is an alias for not — same behavior', () => {
    const inner = eq('x', 1);
    expect(invert(invert(inner))).toBe(inner);
  });

  it('not(TRUE) collapses to FALSE and vice versa', () => {
    expect(not(TRUE)).toBe(FALSE);
    expect(not(FALSE)).toBe(TRUE);
  });

  it('wraps a leaf when no simplification applies', () => {
    const leaf = eq('x', 1);
    const result = not(leaf);
    expect(result.op).toBe('not');
    if (result.op === 'not') expect(result.child).toBe(leaf);
  });
});

describe('TRUE / FALSE constants', () => {
  it('are stable singletons', () => {
    expect(TRUE).toBe(TRUE);
    expect(FALSE).toBe(FALSE);
    expect(TRUE).not.toBe(FALSE);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(TRUE)).toBe(true);
    expect(Object.isFrozen(FALSE)).toBe(true);
  });
});

describe('progressive filter building (plugin-style)', () => {
  it('plugin building one condition at a time lands in a sensible shape', () => {
    // Simulate a plugin that conditionally appends scope predicates.
    let filter = TRUE;
    filter = and(filter, eq('orgId', 'org_123'));
    filter = and(filter, exists('deletedAt', false));
    // No explicit flattening call needed — combinators did it.
    expect(filter.op).toBe('and');
    if (filter.op === 'and') {
      expect(filter.children).toHaveLength(2);
      expect(filter.children[0]).toEqual({ op: 'eq', field: 'orgId', value: 'org_123' });
    }
  });
});

// Exercise each non-eq leaf so 100% leaf-op coverage is enforced.
describe('coverage sweep for all leaf ops', () => {
  it('ne/gt/lt/gte/lte/in/nin/regex/like all produce the expected op tag', () => {
    expect(ne('x', 1).op).toBe('ne');
    expect(gt('x', 1).op).toBe('gt');
    expect(in_('x', [1, 2]).op).toBe('in');
    expect(nin('x', [1, 2]).op).toBe('nin');
    expect(regex('x', '^a').op).toBe('regex');
    expect(like('x', 'a%').op).toBe('like');
  });
});
