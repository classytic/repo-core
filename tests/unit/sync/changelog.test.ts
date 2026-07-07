/**
 * ChangeLog contract — reference-impl semantics every durable store must match
 * (contract rules 1–5 in src/sync/index.ts): ordered opaque cursors, exclusive
 * `since`, tombstones, scope/tenant partitioning, paging.
 */
import { describe, expect, it } from 'vitest';
import { CursorExpiredError, MemoryChangeLogStore } from '../../../src/sync/index.js';

const seed = async (store: MemoryChangeLogStore<{ n: number }>) => {
  await store.append({
    scope: 'pos-order',
    docId: 'a',
    op: 'upsert',
    version: 1,
    doc: { n: 1 },
    tenantId: 't1',
  });
  await store.append({
    scope: 'pos-order',
    docId: 'b',
    op: 'upsert',
    version: 1,
    doc: { n: 2 },
    tenantId: 't1',
  });
  await store.append({
    scope: 'product',
    docId: 'p',
    op: 'upsert',
    version: 3,
    doc: { n: 3 },
    tenantId: 't2',
  });
  await store.append({ scope: 'pos-order', docId: 'a', op: 'delete', version: 2, tenantId: 't1' });
};

describe('MemoryChangeLogStore — contract semantics', () => {
  it('append assigns strictly increasing opaque cursors; at is stamped', async () => {
    const store = new MemoryChangeLogStore();
    const e1 = await store.append({ scope: 's', docId: '1', op: 'upsert', version: 1 });
    const e2 = await store.append({ scope: 's', docId: '2', op: 'upsert', version: 1 });
    expect(e2.cursor > e1.cursor).toBe(true);
    expect(e1.at).toBeInstanceOf(Date);
  });

  it('since is EXCLUSIVE and converges a client, tombstones included', async () => {
    const store = new MemoryChangeLogStore<{ n: number }>();
    await seed(store);

    const full = await store.since('');
    expect(full.changes).toHaveLength(4);
    expect(full.hasMore).toBe(false);

    // Client checkpoints after entry 2, pulls the delta: sees p + the tombstone.
    const checkpoint = full.changes[1]!.cursor;
    const delta = await store.since(checkpoint);
    expect(delta.changes.map((c) => `${c.docId}:${c.op}`)).toEqual(['p:upsert', 'a:delete']);
    expect(delta.changes[1]!.doc).toBeUndefined(); // tombstone carries no doc
    expect(delta.cursor).toBe(await store.latestCursor());
  });

  it('filters by scopes + tenantId (a client syncs only what it opted into)', async () => {
    const store = new MemoryChangeLogStore<{ n: number }>();
    await seed(store);
    const page = await store.since('', { scopes: ['pos-order'], tenantId: 't1' });
    expect(page.changes.every((c) => c.scope === 'pos-order' && c.tenantId === 't1')).toBe(true);
    expect(page.changes).toHaveLength(3);
  });

  it('pages with hasMore; the page cursor resumes exactly', async () => {
    const store = new MemoryChangeLogStore<{ n: number }>();
    await seed(store);
    const p1 = await store.since('', { limit: 3 });
    expect(p1.changes).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    const p2 = await store.since(p1.cursor, { limit: 3 });
    expect(p2.changes).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
  });

  it('CursorExpiredError names cursor + horizon (full-resync signal)', () => {
    const err = new CursorExpiredError('001', '005');
    expect(err.name).toBe('CursorExpiredError');
    expect(err.message).toMatch(/full resync/);
  });
});
