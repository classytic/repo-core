import { describe, expect, it } from 'vitest';
import {
  calculateSkip,
  calculateTotalPages,
  shouldWarnDeepPagination,
  validateLimit,
  validatePage,
} from '../../../src/pagination/index.js';

describe('validateLimit', () => {
  it('clamps to maxLimit when over', () => {
    expect(validateLimit(500, { maxLimit: 100 })).toBe(100);
  });

  it('uses defaultLimit for non-numeric input', () => {
    expect(validateLimit('abc', { defaultLimit: 25 })).toBe(25);
    expect(validateLimit(Number.NaN, { defaultLimit: 25 })).toBe(25);
    expect(validateLimit(-5, { defaultLimit: 25 })).toBe(25);
  });

  it('parses string inputs from URL params', () => {
    expect(validateLimit('20', { maxLimit: 100 })).toBe(20);
  });

  it('floors fractional limits (prevents skip/limit arithmetic bugs)', () => {
    expect(validateLimit(10.9, { maxLimit: 100 })).toBe(10);
  });

  it('maxLimit === 0 disables the cap', () => {
    expect(validateLimit(10_000, { maxLimit: 0 })).toBe(10_000);
  });

  it('falls back to 10 when defaultLimit is not set', () => {
    expect(validateLimit('bad', {})).toBe(10);
  });
});

describe('validatePage', () => {
  it('returns 1 for invalid input', () => {
    expect(validatePage('abc', {})).toBe(1);
    expect(validatePage(-5, {})).toBe(1);
    expect(validatePage(0.5, {})).toBe(1);
  });

  it('parses string inputs from URL params', () => {
    expect(validatePage('42', {})).toBe(42);
  });

  it('throws when page exceeds maxPage', () => {
    expect(() => validatePage(10_001, { maxPage: 10_000 })).toThrow(/exceeds maximum/);
  });

  it('uses default maxPage when not set', () => {
    expect(() => validatePage(10_001, {})).toThrow(/exceeds maximum 10000/);
  });
});

describe('shouldWarnDeepPagination', () => {
  it('true above threshold, false at/below', () => {
    expect(shouldWarnDeepPagination(101, 100)).toBe(true);
    expect(shouldWarnDeepPagination(100, 100)).toBe(false);
    expect(shouldWarnDeepPagination(50, 100)).toBe(false);
  });
});

describe('calculateSkip', () => {
  it('computes (page - 1) * limit', () => {
    expect(calculateSkip(1, 20)).toBe(0);
    expect(calculateSkip(3, 20)).toBe(40);
  });
});

describe('calculateTotalPages', () => {
  it('rounds up partial pages', () => {
    expect(calculateTotalPages(101, 20)).toBe(6);
    expect(calculateTotalPages(100, 20)).toBe(5);
  });

  it('returns 0 for empty result set', () => {
    expect(calculateTotalPages(0, 20)).toBe(0);
  });

  it('returns 0 when limit is non-positive (guards divide-by-zero)', () => {
    expect(calculateTotalPages(100, 0)).toBe(0);
    expect(calculateTotalPages(100, -5)).toBe(0);
  });
});
