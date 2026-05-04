/**
 * Per-scope version-bump — TanStack-style targeted invalidation.
 *
 * A write in `org:abc` should NOT invalidate `org:xyz`'s cached
 * reads. Without per-scope sharding, every multi-tenant write would
 * blow away every tenant's cache — a real perf bug.
 */

import { describe, expect, it } from 'vitest';
import { CacheEngine } from '../../../src/cache/engine.js';
import { buildCacheKey, scopeKeyFromTags, versionKey } from '../../../src/cache/keys.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';

describe('versionKey — scope-keyed shape', () => {
  it('without scope: <prefix>:ver:<model>', () => {
    expect(versionKey('rc', 'order')).toBe('rc:ver:order');
  });

  it('with scope: <prefix>:ver:<model>:<scopeKey>', () => {
    expect(versionKey('rc', 'order', 'org:abc')).toBe('rc:ver:order:org:abc');
  });

  it('different scopes produce different version keys (isolation)', () => {
    expect(versionKey('rc', 'order', 'org:abc')).not.toBe(versionKey('rc', 'order', 'org:xyz'));
  });
});

describe('scopeKeyFromTags', () => {
  it('returns undefined for empty tags', () => {
    expect(scopeKeyFromTags([])).toBeUndefined();
  });

  it('joins tags with deterministic order (sorted)', () => {
    expect(scopeKeyFromTags(['user:42', 'org:abc'])).toBe('org:abc|user:42');
    expect(scopeKeyFromTags(['org:abc', 'user:42'])).toBe('org:abc|user:42');
  });

  it('single-tag returns just the tag', () => {
    expect(scopeKeyFromTags(['org:abc'])).toBe('org:abc');
  });
});

describe('CacheEngine — per-scope version isolation', () => {
  it('bumping one scope leaves the other scope intact', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());

    const v1Before = await engine.getVersion('order', 'org:abc');
    const v2Before = await engine.getVersion('order', 'org:xyz');
    expect(v1Before).toBe(0);
    expect(v2Before).toBe(0);

    await engine.bumpVersion('order', 'org:abc');

    const v1After = await engine.getVersion('order', 'org:abc');
    const v2After = await engine.getVersion('order', 'org:xyz');
    expect(v1After).toBeGreaterThan(0);
    expect(v2After).toBe(0); // org:xyz unchanged
  });

  it('global bump is independent of per-scope bumps', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());

    await engine.bumpVersion('order'); // global
    const globalV = await engine.getVersion('order');
    const scopedV = await engine.getVersion('order', 'org:abc');

    expect(globalV).toBeGreaterThan(0);
    expect(scopedV).toBe(0); // per-scope namespace not touched
  });

  it('cache keys for different scopes are isolated even at the same version', () => {
    const aKey = buildCacheKey({
      prefix: 'rc',
      operation: 'aggregate',
      model: 'order',
      version: 1000,
      params: { filter: { status: 'paid' } },
      scopeTags: ['org:abc'],
    });
    const bKey = buildCacheKey({
      prefix: 'rc',
      operation: 'aggregate',
      model: 'order',
      version: 1000,
      params: { filter: { status: 'paid' } },
      scopeTags: ['org:xyz'],
    });
    expect(aKey).not.toBe(bKey);
  });
});
