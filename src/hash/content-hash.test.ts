import { describe, it, expect } from 'vitest';
import { contentHash, stableStringify } from './index.js';

describe('contentHash', () => {
  it('is key-order independent (structural equality → same digest)', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it('distinguishes different values', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('preserves array order (order is part of array identity)', () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it('hashes Dates stably across an ISO round-trip', () => {
    const d = new Date('2024-12-31T00:00:00.000Z');
    expect(contentHash({ end: d })).toBe(contentHash({ end: d.toISOString() }));
  });

  it('emits a 64-char hex sha256 digest by default', () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-exports stableStringify', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
