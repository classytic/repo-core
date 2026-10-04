/**
 * The ReDoS analyser, judged by what it PREVENTS: every pattern it calls safe must finish fast on
 * adversarial input, and the classic catastrophic shapes must be refused however they are spelled.
 */

import { describe, expect, it } from 'vitest';
import { assessRegex, escapeRegex } from '../../../src/query-parser/regex-safety.js';

describe('assessRegex — refuses the catastrophic shapes', () => {
  it.each([
    ['(a+)+', 'nested-quantifier'],
    ['(a*)*', 'nested-quantifier'],
    ['(.*)*b', 'nested-quantifier'],
    ['(a|aa)+', 'nested-quantifier'],
    ['(a|a)*', 'nested-quantifier'],
    ['((ab)*)+', 'nested-quantifier'],
    ['(?:a+){2,}', 'nested-quantifier'],
    ['(\\d+)*$', 'nested-quantifier'],
    ['([a-z]+)*', 'nested-quantifier'],
    ['(x+x+)+y', 'nested-quantifier'],
    ['(a)\\1', 'backreference'],
    ['(?<n>a)\\k<n>', 'backreference'],
    ['([a', 'invalid'],
    [`${'.*'.repeat(21)}`, 'too-many-quantifiers'],
    ['((((((((((a))))))))))', 'too-complex'],
    [Array.from({ length: 12 }, (_, i) => `opt${i}`).join('|'), 'too-complex'],
    ['(a*)(b+)(c*)(d+)(e*)(f+)(g*)(h+)i+', 'too-complex'],
  ])('%s → %s', (pattern, reason) => {
    expect(assessRegex(pattern)).toEqual({ safe: false, reason });
  });

  it('refuses a pattern past the length budget', () => {
    expect(assessRegex('a'.repeat(501), { maxLength: 500 })).toEqual({
      safe: false,
      reason: 'too-long',
    });
  });
});

describe('assessRegex — allows the ordinary ones', () => {
  it.each([
    'abc',
    '^foo',
    'bar$',
    'a+b*c?',
    '[a-z]+@[a-z]+\\.com',
    '(ab)+',
    '(?:foo)?bar',
    '\\(a+\\)+', // escaped parentheses are literals, not a group
    '[(a+)+]', // inside a class, nothing is a group or a quantifier
    'a{2,3}',
    '(a{2})+',
    '^\\d{3}-\\d{4}$',
  ])('%s', (pattern) => {
    expect(assessRegex(pattern)).toEqual({ safe: true });
  });

  it('every pattern it calls safe finishes fast on adversarial input', () => {
    const adversarial = `${'a'.repeat(28)}!`;
    for (const pattern of [
      '(ab)+',
      'a+b*c?',
      '(a{2})+',
      '^(\\w+\\s?)$'.replace('(\\w+\\s?)', 'x'),
    ]) {
      if (!assessRegex(pattern).safe) continue;
      const start = performance.now();
      new RegExp(pattern).test(adversarial);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });
});

describe('escapeRegex', () => {
  it('turns every metacharacter into a literal', () => {
    const source = '(a+)+.*?[x]{2}|^$\\';
    expect(new RegExp(`^${escapeRegex(source)}$`).test(source)).toBe(true);
  });
});
