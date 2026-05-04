/**
 * Tag side-index — append-then-invalidate semantics for adapters
 * without `clear(pattern)` support.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { appendKeyToTags, invalidateByTags } from '../../../src/cache/tag-index.js';

describe('tag-index — appendKeyToTags', () => {
  it('records a key under each tag', async () => {
    const adapter = createMemoryCacheAdapter();
    await appendKeyToTags(adapter, 'rc', 'k1', ['orders', 'org:abc']);
    expect(await adapter.get('rc:tag:orders')).toEqual(['k1']);
    expect(await adapter.get('rc:tag:org:abc')).toEqual(['k1']);
  });

  it('appends to existing index', async () => {
    const adapter = createMemoryCacheAdapter();
    await appendKeyToTags(adapter, 'rc', 'k1', ['orders']);
    await appendKeyToTags(adapter, 'rc', 'k2', ['orders']);
    expect(await adapter.get('rc:tag:orders')).toEqual(['k1', 'k2']);
  });

  it('dedups same-key writes (SWR refresh re-writes the same key)', async () => {
    const adapter = createMemoryCacheAdapter();
    await appendKeyToTags(adapter, 'rc', 'k1', ['orders']);
    await appendKeyToTags(adapter, 'rc', 'k1', ['orders']);
    expect(await adapter.get('rc:tag:orders')).toEqual(['k1']);
  });

  it('no-op on empty tags', async () => {
    const adapter = createMemoryCacheAdapter();
    await appendKeyToTags(adapter, 'rc', 'k1', []);
    expect(await adapter.get('rc:tag:any')).toBeUndefined();
  });
});

describe('tag-index — invalidateByTags', () => {
  it('deletes every keyed entry plus the index itself', async () => {
    const adapter = createMemoryCacheAdapter();
    adapter.set('k1', 'v1');
    adapter.set('k2', 'v2');
    await appendKeyToTags(adapter, 'rc', 'k1', ['orders']);
    await appendKeyToTags(adapter, 'rc', 'k2', ['orders']);

    const removed = await invalidateByTags(adapter, 'rc', ['orders']);
    expect(removed).toBe(2);
    expect(await adapter.get('k1')).toBeUndefined();
    expect(await adapter.get('k2')).toBeUndefined();
    expect(await adapter.get('rc:tag:orders')).toBeUndefined();
  });

  it('multi-tag invalidation deduplicates affected entries', async () => {
    const adapter = createMemoryCacheAdapter();
    adapter.set('k1', 'v1');
    await appendKeyToTags(adapter, 'rc', 'k1', ['orders', 'urgent']);

    const removed = await invalidateByTags(adapter, 'rc', ['orders', 'urgent']);
    expect(removed).toBe(1); // counted ONCE despite two tags
  });

  it('returns 0 when no tags supplied', async () => {
    const adapter = createMemoryCacheAdapter();
    const removed = await invalidateByTags(adapter, 'rc', []);
    expect(removed).toBe(0);
  });

  it('skips tags with no index without error (already-invalidated case)', async () => {
    const adapter = createMemoryCacheAdapter();
    const removed = await invalidateByTags(adapter, 'rc', ['nonexistent']);
    expect(removed).toBe(0);
  });
});
