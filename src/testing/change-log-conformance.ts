/**
 * `runChangeLogStoreConformance` — the contract every `ChangeLogStore` passes. A kit runs it against
 * its real backend; passing it is what "implements the store" means.
 *
 *     describe('mongokit/sync conformance', () => {
 *       runChangeLogStoreConformance({ createStore: () => createMongoChangeLogStore(...), transaction });
 *     });
 *
 * The case that matters is the checkpoint one: a store whose cursors can commit OUT of order loses
 * an entry for every client that read between them — it passes everything else and drops data.
 */
import { describe, it } from 'vitest';
import type { ChangeEntry, ChangeLogStore, ChangesSinceOptions } from '../sync/index.js';

export interface ChangeLogConformanceHarness {
  /** A store over an EMPTY backend, per scenario. */
  createStore(): ChangeLogStore | Promise<ChangeLogStore>;
  /**
   * Run `work` in a transaction on the store's backend and commit it, or abort when it throws.
   * Omit for a store with no transactions (the memory reference); the atomicity cases then skip.
   */
  transaction?<T>(work: (session: unknown) => Promise<T>): Promise<T>;
}

type Entry = Omit<ChangeEntry, 'cursor' | 'at'>;

let n = 0;
const upsert = (over: Partial<Entry> = {}): Entry => {
  n += 1;
  return {
    scope: 'order',
    docId: `doc-${n}`,
    op: 'upsert',
    version: 1,
    doc: { n },
    tenantId: 'branch-a',
    ...over,
  };
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[ChangeLogStore contract] ${message}`);
}

/** Every entry after `cursor`, page by page — what a client converges by. */
async function drain(store: ChangeLogStore, cursor: string, options: ChangesSinceOptions = {}) {
  const out: ChangeEntry[] = [];
  let at = cursor;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await store.since(at, options);
    out.push(...page.changes);
    at = page.cursor;
    if (!page.hasMore) return { entries: out, cursor: at };
  }
  throw new Error('[ChangeLogStore contract] since() never reported hasMore: false');
}

/** The contract's cases, runner-agnostic — each `run` throws on failure. */
export function changeLogStoreCases(harness: ChangeLogConformanceHarness): {
  readonly name: string;
  readonly run: () => Promise<void>;
  readonly needsTransaction?: boolean;
}[] {
  // The cases that call this are skipped when the harness has no transactions.
  const transact = <T>(work: (session: unknown) => Promise<T>): Promise<T> => {
    if (!harness.transaction)
      throw new Error('[ChangeLogStore contract] this case needs transaction()');
    return harness.transaction(work);
  };
  const cases: [string, (store: ChangeLogStore) => Promise<void>, boolean?][] = [
    [
      'an empty store has no entries and an empty head cursor',
      async (store) => {
        check((await store.latestCursor()) === '', 'latestCursor of an empty store must be ""');
        const page = await store.since('');
        check(
          page.changes.length === 0 && !page.hasMore,
          'since("") of an empty store must be empty',
        );
      },
    ],
    [
      'append assigns a cursor and a capture time, and round-trips the rest',
      async (store) => {
        const entry = upsert({ doc: { name: 'Mug', price: 450 } });
        const saved = await store.append(entry);
        check(
          typeof saved.cursor === 'string' && saved.cursor.length > 0,
          'append must assign a cursor',
        );
        check(saved.at instanceof Date, 'append must assign `at` as a Date');
        const [read] = (await store.since('')).changes;
        check(
          read && read.docId === entry.docId && read.scope === entry.scope && read.op === 'upsert',
          'since must return the entry',
        );
        check(
          read.version === 1 && read.tenantId === 'branch-a',
          'version and tenantId must round-trip',
        );
        check(
          JSON.stringify(read.doc) === JSON.stringify(entry.doc),
          'the doc snapshot must round-trip',
        );
        check(read.cursor === saved.cursor, 'since must return the cursor append assigned');
      },
    ],
    [
      'since is exclusive and returns entries in append order',
      async (store) => {
        const a = await store.append(upsert());
        const b = await store.append(upsert());
        const c = await store.append(upsert());
        const after = await drain(store, a.cursor);
        check(
          after.entries.map((e) => e.cursor).join() === [b.cursor, c.cursor].join(),
          'since(a) must be [b, c], in order',
        );
      },
    ],
    [
      'paging with a small limit delivers every entry exactly once',
      async (store) => {
        for (let i = 0; i < 7; i++) await store.append(upsert());
        const { entries } = await drain(store, '', { limit: 3 });
        check(entries.length === 7, `paging must deliver all 7 entries, got ${entries.length}`);
        check(new Set(entries.map((e) => e.cursor)).size === 7, 'no entry may be delivered twice');
      },
    ],
    [
      'a delete is a tombstone with no doc',
      async (store) => {
        await store.append({
          scope: 'order',
          docId: 'gone',
          op: 'delete',
          version: 2,
          tenantId: 'branch-a',
        });
        const [tomb] = (await store.since('')).changes;
        check(
          tomb?.op === 'delete' && tomb.docId === 'gone' && tomb.doc === undefined,
          'a delete must come back as a tombstone without a doc',
        );
      },
    ],
    [
      'a tenant (branch) sees only its own entries',
      async (store) => {
        await store.append(upsert({ tenantId: 'branch-a' }));
        await store.append(upsert({ tenantId: 'branch-b' }));
        await store.append(upsert({ tenantId: 'branch-a' }));
        const a = await drain(store, '', { tenantId: 'branch-a' });
        const b = await drain(store, '', { tenantId: 'branch-b' });
        check(
          a.entries.length === 2 && a.entries.every((e) => e.tenantId === 'branch-a'),
          'branch-a must see its 2 entries only',
        );
        check(
          b.entries.length === 1 && b.entries[0]?.tenantId === 'branch-b',
          'branch-b must see its 1 entry only',
        );
      },
    ],
    [
      'a shared scope reaches every tenant; its other scopes stay partitioned',
      async (store) => {
        const { tenantId: _, ...companyWide } = upsert({ scope: 'product' });
        await store.append(companyWide);
        await store.append(upsert({ scope: 'product', tenantId: 'branch-b' }));
        await store.append(upsert({ scope: 'order', tenantId: 'branch-b' }));
        await store.append(upsert({ scope: 'order', tenantId: 'branch-a' }));
        const { entries } = await drain(store, '', {
          tenantId: 'branch-a',
          sharedScopes: ['product'],
        });
        check(
          entries.map((e) => e.scope).join() === 'product,product,order',
          'branch-a must read every product and only its own order',
        );
        const narrowed = await drain(store, '', {
          tenantId: 'branch-a',
          sharedScopes: ['product'],
          scopes: ['order'],
        });
        check(
          narrowed.entries.length === 1 && narrowed.entries[0]?.tenantId === 'branch-a',
          'scopes must still narrow a shared scope away',
        );
      },
    ],
    [
      'scopes narrow the feed to the resources a client syncs',
      async (store) => {
        await store.append(upsert({ scope: 'order' }));
        await store.append(upsert({ scope: 'product' }));
        await store.append(upsert({ scope: 'shift' }));
        const { entries } = await drain(store, '', { scopes: ['order', 'shift'] });
        check(
          entries.map((e) => e.scope).join() === 'order,shift',
          'scopes must select order and shift, in order',
        );
      },
    ],
    [
      'latestCursor is a checkpoint after which the filtered feed is empty',
      async (store) => {
        await store.append(upsert({ tenantId: 'branch-a' }));
        await store.append(upsert({ tenantId: 'branch-b' }));
        const head = await store.latestCursor({ tenantId: 'branch-a' });
        check(
          (await store.since(head, { tenantId: 'branch-a' })).changes.length === 0,
          'nothing for branch-a after its head',
        );
        const later = await store.append(upsert({ tenantId: 'branch-a' }));
        const next = await store.since(head, { tenantId: 'branch-a' });
        check(
          next.changes.length === 1 && next.changes[0]?.cursor === later.cursor,
          'a later entry must follow the head',
        );
      },
    ],
    [
      'concurrent appends get distinct cursors and none is lost',
      async (store) => {
        const saved = await Promise.all(Array.from({ length: 25 }, () => store.append(upsert())));
        check(
          new Set(saved.map((e) => e.cursor)).size === 25,
          'every concurrent append must get its own cursor',
        );
        const { entries } = await drain(store, '', { limit: 10 });
        check(entries.length === 25, `all 25 must be delivered, got ${entries.length}`);
      },
    ],
    [
      'an entry appended in an aborted transaction never appears',
      async (store) => {
        await transact(async (session) => {
          await store.append(upsert({ docId: 'rolled-back' }), { session });
          throw new Error('abort');
        }).catch(() => undefined);
        await store.append(upsert({ docId: 'kept' }), {});
        const { entries } = await drain(store, '');
        check(
          !entries.some((e) => e.docId === 'rolled-back'),
          'an aborted append must not be in the feed',
        );
        check(
          entries.some((e) => e.docId === 'kept'),
          'a committed append must be in the feed',
        );
      },
      true,
    ],
    [
      'an entry committed after a client checkpointed is still delivered after that checkpoint',
      async (store) => {
        // A appends first and commits last. If B's append can commit in between, a client that
        // checkpoints then must still receive A's entry afterwards — or it skips it forever.
        let releaseA!: () => void;
        const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
        let aAppended!: () => void;
        const aHasAppended = new Promise<void>((resolve) => (aAppended = resolve));
        const a = transact(async (session) => {
          await store.append(upsert({ docId: 'slow' }), { session });
          aAppended();
          await aMayCommit;
        });
        await aHasAppended;
        const b = store.append(upsert({ docId: 'fast' }));
        // A store that serialises cursors makes B wait for A; that is correct, and is the other branch.
        const bCommittedFirst = await Promise.race([
          b.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 300)),
        ]);
        const checkpoint = bCommittedFirst ? (await drain(store, '')).cursor : '';
        releaseA();
        await Promise.all([a, b]);
        const all = (await drain(store, '')).entries.map((e) => e.docId);
        check(all.includes('slow') && all.includes('fast'), 'both entries must be in the feed');
        if (bCommittedFirst) {
          const after = (await drain(store, checkpoint)).entries.map((e) => e.docId);
          check(
            after.includes('slow'),
            'an entry committed after a checkpoint was lost to the client that took it',
          );
        }
      },
      true,
    ],
  ];
  return cases.map(([name, body, needsTransaction]) => ({
    name,
    needsTransaction: needsTransaction === true,
    run: async () => body(await harness.createStore()),
  }));
}

/** The contract as a vitest suite. */
export function runChangeLogStoreConformance(harness: ChangeLogConformanceHarness): void {
  describe('ChangeLogStore conformance', () => {
    for (const c of changeLogStoreCases(harness)) {
      if (c.needsTransaction && !harness.transaction) it.skip(`${c.name} (no transactions)`, c.run);
      else it(c.name, c.run, 30_000);
    }
  });
}
