/**
 * `runCommandStreamStoreConformance` — the contract every `CommandStreamStore` passes, run against
 * its real backend. The serialisation case is the one that matters: a store whose transactions can
 * both commit on a stale read gives two commands the same seq, and passes everything else.
 */
import { describe, it } from 'vitest';
import type { CommandStreamStore, CommandVerdictRecord } from '../sync/index.js';

export interface CommandStreamConformanceHarness {
  /** A store over an EMPTY backend, per scenario. */
  createStore(): CommandStreamStore | Promise<CommandStreamStore>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[CommandStreamStore contract] ${message}`);
}

const verdict = (over: Partial<CommandVerdictRecord> = {}): CommandVerdictRecord => ({
  commandId: 'c1',
  stream: 's1',
  seq: 1,
  outcome: 'applied',
  fingerprint: 'f1',
  ...over,
});

/** The contract's cases, runner-agnostic — each `run` throws on failure. */
export function commandStreamStoreCases(
  harness: CommandStreamConformanceHarness,
): { readonly name: string; readonly run: () => Promise<void> }[] {
  const cases: [string, (store: CommandStreamStore) => Promise<void>][] = [
    [
      'an unknown stream and command read as null',
      async (store) => {
        await store.transaction(async (tx) => {
          check((await store.stream(tx, 's1')) === null, 'an unknown stream must be null');
          check((await store.verdict(tx, 'c1')) === null, 'an unknown verdict must be null');
        });
      },
    ],
    [
      'advance creates the stream bound to its tenant, then moves only from where it stands',
      async (store) => {
        await store.transaction(async (tx) => {
          check(
            await store.advance(tx, 's1', 'branch-a', 0, 1),
            'advance 0 → 1 must create the stream',
          );
          check(
            !(await store.advance(tx, 's1', 'branch-a', 0, 1)),
            'advance from a stale position must be false',
          );
          check(await store.advance(tx, 's1', 'branch-b', 1, 2), 'advance 1 → 2 must succeed');
        });
        const stream = await store.transaction((tx) => store.stream(tx, 's1'));
        check(stream?.processed === 2, 'the watermark must be 2');
        check(stream.tenantId === 'branch-a', 'the stream stays bound to its FIRST tenant');
      },
    ],
    [
      'a verdict round-trips, with its code and fingerprint',
      async (store) => {
        await store.transaction((tx) =>
          store.record(tx, verdict({ outcome: 'rejected', code: 'pos.closed' })),
        );
        await store.transaction((tx) => store.record(tx, verdict({ commandId: 'c2', seq: 2 })));
        const [rejected, applied] = await store.transaction(async (tx) => [
          await store.verdict(tx, 'c1'),
          await store.verdict(tx, 'c2'),
        ]);
        check(
          rejected?.outcome === 'rejected' &&
            rejected.code === 'pos.closed' &&
            rejected.fingerprint === 'f1',
          'the rejected verdict must round-trip',
        );
        check(
          applied?.outcome === 'applied' && applied.code === undefined && applied.seq === 2,
          'an applied verdict has no code',
        );
      },
    ],
    [
      'a later record replaces a verdict — how a resolution settles a refusal',
      async (store) => {
        await store.transaction((tx) =>
          store.record(tx, verdict({ outcome: 'rejected', code: 'x', body: '{"id":"c1"}' })),
        );
        await store.transaction((tx) => store.record(tx, verdict({ outcome: 'resolved' })));
        const settled = await store.transaction((tx) => store.verdict(tx, 'c1'));
        check(
          settled?.outcome === 'resolved' && settled.code === undefined,
          'the second record must replace the first',
        );
        check(settled.body === undefined, 'a replaced verdict keeps nothing of the first');
      },
    ],
    [
      'blockedOn finds the blocked verdicts waiting on a command, in seq order',
      async (store) => {
        await store.transaction(async (tx) => {
          await store.record(
            tx,
            verdict({ commandId: 'c3', seq: 3, outcome: 'blocked', dependsOn: ['c1'], body: '{}' }),
          );
          await store.record(
            tx,
            verdict({ commandId: 'c2', seq: 2, outcome: 'blocked', dependsOn: ['c1'], body: '{}' }),
          );
          await store.record(
            tx,
            verdict({ commandId: 'c4', seq: 4, outcome: 'blocked', dependsOn: ['c9'], body: '{}' }),
          );
          await store.record(
            tx,
            verdict({ commandId: 'c5', seq: 5, outcome: 'applied', dependsOn: ['c1'] }),
          );
        });
        const waiting = await store.transaction((tx) => store.blockedOn(tx, 'c1'));
        check(
          waiting.map((v) => v.commandId).join() === 'c2,c3',
          `expected c2,c3 — got ${waiting.map((v) => v.commandId).join()}`,
        );
        check(
          waiting[0]?.body === '{}' && waiting[0].dependsOn?.[0] === 'c1',
          'a blocked verdict keeps its body and what it waits on',
        );
      },
    ],
    [
      'an alias resolves in its own tenant only, and a local id names one record',
      async (store) => {
        await store.transaction((tx) =>
          store.alias(tx, { tenantId: 'branch-a', localId: 'cust-local', serverId: 'cust-1' }),
        );
        const [own, other] = await store.transaction(async (tx) => [
          await store.aliasOf(tx, 'branch-a', 'cust-local'),
          await store.aliasOf(tx, 'branch-b', 'cust-local'),
        ]);
        check(own === 'cust-1' && other === null, 'an alias is tenant-scoped');
        await store.transaction((tx) =>
          store.alias(tx, { tenantId: 'branch-a', localId: 'cust-local', serverId: 'cust-1' }),
        );
        let refused = false;
        await store
          .transaction((tx) =>
            store.alias(tx, { tenantId: 'branch-a', localId: 'cust-local', serverId: 'cust-2' }),
          )
          .catch(() => (refused = true));
        check(refused, 'a local id already naming one record must not be re-pointed');
      },
    ],
    [
      'a transaction that throws leaves no stream, verdict or feed entry',
      async (store) => {
        await store
          .transaction(async (tx) => {
            await store.advance(tx, 's1', 'branch-a', 0, 1);
            await store.record(tx, verdict());
            await store.alias(tx, {
              tenantId: 'branch-a',
              localId: 'cust-local',
              serverId: 'cust-1',
            });
            await store.changes.append(
              {
                scope: 'order',
                docId: 'o1',
                op: 'upsert',
                version: 1,
                doc: {},
                tenantId: 'branch-a',
              },
              { session: tx.session },
            );
            throw new Error('abort');
          })
          .catch(() => undefined);
        await store.transaction(async (tx) => {
          check((await store.stream(tx, 's1')) === null, 'an aborted advance must not persist');
          check((await store.verdict(tx, 'c1')) === null, 'an aborted verdict must not persist');
          check(
            (await store.aliasOf(tx, 'branch-a', 'cust-local')) === null,
            'an aborted alias must not persist',
          );
        });
        check(
          (await store.changes.since('')).changes.length === 0,
          'an aborted feed entry must not persist',
        );
      },
    ],
    [
      'transactions moving one stream serialise: twenty concurrent advances reach 20',
      async (store) => {
        await Promise.all(
          Array.from({ length: 20 }, () =>
            store.transaction(async (tx) => {
              const at = (await store.stream(tx, 's1'))?.processed ?? 0;
              check(
                await store.advance(tx, 's1', 'branch-a', at, at + 1),
                'a serialised advance must find the stream where it read it',
              );
            }),
          ),
        );
        const stream = await store.transaction((tx) => store.stream(tx, 's1'));
        check(stream?.processed === 20, `twenty advances must reach 20, got ${stream?.processed}`);
      },
    ],
  ];
  return cases.map(([name, body]) => ({
    name,
    run: async () => body(await harness.createStore()),
  }));
}

/** The contract as a vitest suite. */
export function runCommandStreamStoreConformance(harness: CommandStreamConformanceHarness): void {
  describe('CommandStreamStore conformance', () => {
    for (const c of commandStreamStoreCases(harness)) it(c.name, c.run, 60_000);
  });
}
