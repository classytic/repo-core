/**
 * Cache option resolution — merge precedence + default fill.
 *
 * Per-call > per-op > plugin > built-in. Validates that hosts can
 * pass partial options at every layer and the system fills the gaps
 * with sensible defaults.
 */

import { describe, expect, it } from 'vitest';
import { resolveCacheOptions } from '../../../src/cache/options.js';

describe('resolveCacheOptions — built-in defaults', () => {
  it('all-undefined yields the safe baseline', () => {
    const r = resolveCacheOptions(undefined, undefined, undefined);
    expect(r).toEqual({
      staleTime: 0,
      gcTime: 60,
      tags: [],
      bypass: false,
      swr: false,
      enabled: true,
    });
  });

  it('clamps negative staleTime / gcTime to 0', () => {
    const r = resolveCacheOptions({ staleTime: -10, gcTime: -5 }, undefined, undefined);
    expect(r.staleTime).toBe(0);
    expect(r.gcTime).toBe(0);
  });
});

describe('resolveCacheOptions — merge precedence', () => {
  it('per-call wins over per-op default', () => {
    const r = resolveCacheOptions({ staleTime: 100 }, { staleTime: 30 }, undefined);
    expect(r.staleTime).toBe(100);
  });

  it('per-op wins over plugin default', () => {
    const r = resolveCacheOptions(undefined, { staleTime: 30 }, { staleTime: 10 });
    expect(r.staleTime).toBe(30);
  });

  it('plugin default fills when nothing per-op or per-call', () => {
    const r = resolveCacheOptions(undefined, undefined, { staleTime: 10 });
    expect(r.staleTime).toBe(10);
  });

  it('per-call partial merges deeply with defaults — only declared fields override', () => {
    const r = resolveCacheOptions({ staleTime: 100 }, undefined, { gcTime: 600, swr: true });
    // staleTime from per-call, gcTime + swr from plugin defaults
    expect(r).toMatchObject({ staleTime: 100, gcTime: 600, swr: true });
  });
});

describe('resolveCacheOptions — key passthrough', () => {
  it('key field flows through when set', () => {
    const r = resolveCacheOptions({ key: 'custom-key' }, undefined, undefined);
    expect(r.key).toBe('custom-key');
  });

  it('omits key field when not set (no undefined property under exactOptionalPropertyTypes)', () => {
    const r = resolveCacheOptions(undefined, undefined, undefined);
    expect('key' in r).toBe(false);
  });
});
