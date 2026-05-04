/**
 * Cache-key derivation — stable hashing + scope extraction.
 *
 * Locks the contract every kit + arc + Express/Nest hosts compute
 * keys against. If two callers in different processes derive the
 * same key for the same logical request, one Redis serves all of them.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCacheKey,
  extractScopeTags,
  tagIndexKey,
  versionKey,
} from '../../../src/cache/keys.js';

describe('buildCacheKey — deterministic structure', () => {
  it('produces the canonical shape: prefix:op:model:vN:paramsHash:scopeHash', () => {
    const key = buildCacheKey({
      prefix: 'rc',
      operation: 'getById',
      model: 'order',
      version: 42,
      params: { id: 'abc' },
      scopeTags: [],
    });
    expect(key).toMatch(/^rc:getById:order:v42:[a-z0-9]+:0$/);
  });

  it('scopeHash = 0 when no scope tags', () => {
    const key = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: {},
      scopeTags: [],
    });
    expect(key.endsWith(':0')).toBe(true);
  });

  it('scopeHash differs when scope tags differ (cross-tenant isolation)', () => {
    const a = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: { filter: { status: 'pending' } },
      scopeTags: ['org:abc'],
    });
    const b = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: { filter: { status: 'pending' } },
      scopeTags: ['org:xyz'],
    });
    expect(a).not.toBe(b);
  });

  it('paramsHash is deterministic — same input → same key', () => {
    const inputs = {
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: { filter: { status: 'pending', a: 1 } },
      scopeTags: [],
    } as const;
    expect(buildCacheKey(inputs)).toBe(buildCacheKey(inputs));
  });

  it('paramsHash is order-independent for object keys', () => {
    const a = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: { filter: { a: 1, b: 2 } },
      scopeTags: [],
    });
    const b = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: { filter: { b: 2, a: 1 } },
      scopeTags: [],
    });
    expect(a).toBe(b);
  });

  it('version bump produces a different key (orphans cached entries)', () => {
    const before = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: { filter: { status: 'a' } },
      scopeTags: [],
    });
    const after = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 2,
      params: { filter: { status: 'a' } },
      scopeTags: [],
    });
    expect(before).not.toBe(after);
  });

  it('different ops produce different keys for the same filter', () => {
    const get = buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'order',
      version: 1,
      params: { filter: { status: 'a' } },
      scopeTags: [],
    });
    const count = buildCacheKey({
      prefix: 'rc',
      operation: 'count',
      model: 'order',
      version: 1,
      params: { filter: { status: 'a' } },
      scopeTags: [],
    });
    expect(get).not.toBe(count);
  });
});

describe('extractScopeTags — auto-injection from hook context', () => {
  it('returns empty array on empty / undefined context', () => {
    expect(extractScopeTags(undefined)).toEqual([]);
    expect(extractScopeTags({})).toEqual([]);
  });

  it('extracts org:<id> from context.filter.organizationId (multi-tenant primary path)', () => {
    expect(extractScopeTags({ filter: { organizationId: 'abc' } })).toEqual(['org:abc']);
  });

  it('extracts user:<id> from context.filter.userId', () => {
    expect(extractScopeTags({ filter: { userId: 'u1' } })).toEqual(['user:u1']);
  });

  it('returns both when both fields are present', () => {
    expect(extractScopeTags({ filter: { organizationId: 'abc', userId: 'u1' } })).toEqual([
      'org:abc',
      'user:u1',
    ]);
  });

  it('falls back to context.options when filter does not carry scope', () => {
    expect(extractScopeTags({ options: { organizationId: 'abc', userId: 'u1' } })).toEqual([
      'org:abc',
      'user:u1',
    ]);
  });

  it('falls back to context root when neither filter nor options carry scope', () => {
    expect(extractScopeTags({ organizationId: 'abc' })).toEqual(['org:abc']);
  });

  it('filter > options > root precedence (most-trusted source wins)', () => {
    const tags = extractScopeTags({
      filter: { organizationId: 'from-filter' },
      options: { organizationId: 'from-options' },
      organizationId: 'from-root',
    });
    expect(tags).toEqual(['org:from-filter']);
  });

  it('skips non-string scope values silently', () => {
    expect(
      extractScopeTags({
        filter: { organizationId: 42, userId: { nested: true } },
      }),
    ).toEqual([]);
  });
});

describe('helper key builders', () => {
  it('tagIndexKey nests under prefix', () => {
    expect(tagIndexKey('rc', 'orders')).toBe('rc:tag:orders');
  });

  it('versionKey nests under prefix', () => {
    expect(versionKey('rc', 'order')).toBe('rc:ver:order');
  });
});
