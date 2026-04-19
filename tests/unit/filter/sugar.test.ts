/**
 * Tests for the sugar builders — between, contains, startsWith, endsWith,
 * iEq, isNull, isNotNull — and the `raw` escape hatch.
 *
 * Sugar builders desugar to existing IR ops so nothing new needs compiler
 * support. `raw` is a genuine new IR node that kit compilers embed verbatim.
 */

import { describe, expect, it } from 'vitest';
import {
  asPredicate,
  between,
  contains,
  endsWith,
  iEq,
  isFilter,
  isNotNull,
  isNull,
  matchFilter,
  raw,
  startsWith,
} from '../../../src/filter/index.js';

describe('sugar builders — desugaring', () => {
  it('between desugars to and(gte, lte)', () => {
    const f = between('age', 18, 65);
    expect(f.op).toBe('and');
    if (f.op === 'and') {
      const ops = f.children.map((c) => c.op).sort();
      expect(ops).toEqual(['gte', 'lte']);
    }
  });

  it('contains wraps the pattern in %...%', () => {
    const f = contains('name', 'ohn');
    expect(f).toMatchObject({ op: 'like', field: 'name', pattern: '%ohn%' });
  });

  it('startsWith / endsWith emit the right LIKE pattern', () => {
    expect(startsWith('name', 'Jo')).toMatchObject({ op: 'like', pattern: 'Jo%' });
    expect(endsWith('name', 'hn')).toMatchObject({ op: 'like', pattern: '%hn' });
  });

  it('contains escapes %/_ so user input matches literally', () => {
    const f = contains('msg', '50% off');
    expect(f).toMatchObject({ op: 'like', pattern: '%50\\% off%' });
  });

  it('iEq compiles to case-insensitive LIKE without wildcards', () => {
    const f = iEq('email', 'Alice@Example.COM');
    expect(f).toMatchObject({
      op: 'like',
      field: 'email',
      pattern: 'Alice@Example.COM',
      caseSensitivity: 'insensitive',
    });
  });

  it('isNull / isNotNull expand to exists', () => {
    expect(isNull('deletedAt')).toEqual({ op: 'exists', field: 'deletedAt', exists: false });
    expect(isNotNull('email')).toEqual({ op: 'exists', field: 'email', exists: true });
  });
});

describe('sugar builders — runtime matching via matchFilter', () => {
  it('between includes both endpoints', () => {
    expect(matchFilter({ age: 18 }, between('age', 18, 65))).toBe(true);
    expect(matchFilter({ age: 65 }, between('age', 18, 65))).toBe(true);
    expect(matchFilter({ age: 17 }, between('age', 18, 65))).toBe(false);
  });

  it('contains is case-insensitive by default', () => {
    expect(matchFilter({ name: 'Alice' }, contains('name', 'LIC'))).toBe(true);
  });

  it('Array.filter with asPredicate works end-to-end', () => {
    const users = [{ email: 'a@x.com' }, { email: 'b@y.com' }, { email: 'admin@x.com' }];
    const inX = users.filter(asPredicate(endsWith('email', '@x.com')));
    expect(inX).toHaveLength(2);
  });
});

describe('raw — escape hatch', () => {
  it('is recognized by isFilter guard', () => {
    expect(isFilter(raw('x = 1'))).toBe(true);
    expect(isFilter(raw('x <=> ? < 0.3', [[0.1, 0.2]]))).toBe(true);
  });

  it('carries opaque sql + params through to kit compilers', () => {
    const node = raw('embedding <=> ? < 0.3', [[0.1, 0.2]]);
    expect(node.sql).toBe('embedding <=> ? < 0.3');
    expect(node.params).toEqual([[0.1, 0.2]]);
  });

  it('matchFilter returns false — JS cannot evaluate driver-native SQL', () => {
    expect(matchFilter({ anything: 42 }, raw('SELECT 1'))).toBe(false);
  });
});
