/**
 * `runIdempotencyStoreConformance` — the contract every `IdempotencyClaimStore` passes.
 * Mirrors `runLockAdapterConformance`: a kit runs it against its real backend, and passing it
 * is what "implements the store" means.
 *
 *     describe('mongokit/idempotency conformance', () => {
 *       runIdempotencyStoreConformance({ createStore: () => createIdempotencyStore(model) });
 *     });
 *
 * The concurrency cases are the ones that matter — a store built from read-then-write passes
 * everything else and double-executes in production.
 */
import { describe, it } from 'vitest';
import {
  completeClaim,
  decideClaim,
  type IdempotencyClaim,
  type IdempotencyClaimStore,
  type IdempotencyIdentity,
  identityKey,
  runIdempotent,
} from '../idempotency/index.js';

export interface IdempotencyConformanceHarness {
  /** A store over an EMPTY backend, per scenario. */
  createStore(): IdempotencyClaimStore | Promise<IdempotencyClaimStore>;
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const LEASE_MS = 30_000;

let seq = 0;
const freshIdentity = (over: Partial<IdempotencyIdentity> = {}): IdempotencyIdentity => ({
  operation: 'conformance.op',
  key: `key-${Date.now().toString(36)}-${++seq}`,
  scope: { organizationId: 'org-1' },
  ...over,
});

function mint(
  identity: IdempotencyIdentity,
  leaseToken: string,
  now = T0,
): IdempotencyClaim<unknown> {
  const decision = decideClaim(null, {
    identity,
    requestFingerprint: 'fp-1',
    now,
    leaseToken,
    leaseMs: LEASE_MS,
  });
  if (decision.outcome !== 'claimed') throw new Error('unreachable');
  return decision.claim;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[IdempotencyClaimStore contract] ${message}`);
}

const sameInstant = (a: unknown, b: Date) => a instanceof Date && a.getTime() === b.getTime();

/** The contract's cases, runner-agnostic — each `run` throws on failure. */
export function idempotencyStoreCases(
  harness: IdempotencyConformanceHarness,
): { readonly name: string; readonly run: () => Promise<void> }[] {
  const cases: [string, (store: IdempotencyClaimStore) => Promise<void>][] = [
    [
      'get of an unknown identity is null',
      async (store) => {
        check(
          (await store.get(freshIdentity())) === null,
          'get must return null for an identity never inserted',
        );
      },
    ],

    [
      'insert round-trips every field, Dates as Dates',
      async (store) => {
        const identity = freshIdentity();
        const claim = mint(identity, 'lease-a');
        check(await store.insert(claim), 'first insert must win');
        const got = await store.get(identity);
        check(got !== null, 'inserted claim must be readable');
        check(identityKey(got.identity) === identityKey(identity), 'identity must round-trip');
        check(got.requestFingerprint === 'fp-1', 'requestFingerprint must round-trip');
        check(got.state === 'in_flight', 'state must round-trip');
        check(got.leaseToken === 'lease-a', 'leaseToken must round-trip');
        check(got.attempts === 1, 'attempts must round-trip');
        check(
          sameInstant(got.leaseExpiresAt, claim.leaseExpiresAt),
          'leaseExpiresAt must come back as the same Date',
        );
        check(
          sameInstant(got.createdAt, claim.createdAt),
          'createdAt must come back as the same Date',
        );
      },
    ],

    [
      'a second insert of one identity loses and changes nothing',
      async (store) => {
        const identity = freshIdentity();
        check(await store.insert(mint(identity, 'lease-a')), 'first insert must win');
        check(!(await store.insert(mint(identity, 'lease-b'))), 'second insert must return false');
        check(
          (await store.get(identity))?.leaseToken === 'lease-a',
          'the loser must not overwrite the winner',
        );
      },
    ],

    [
      'CONCURRENT inserts of one identity: exactly one wins',
      async (store) => {
        const identity = freshIdentity();
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) => store.insert(mint(identity, `lease-${i}`))),
        );
        check(
          results.filter(Boolean).length === 1,
          `exactly one insert must win, got ${results.filter(Boolean).length}`,
        );
      },
    ],

    [
      'operation and scope are part of the identity; scope key order is not',
      async (store) => {
        const base = freshIdentity({ scope: { organizationId: 'org-1', registerId: 'r1' } });
        check(await store.insert(mint(base, 'lease-a')), 'base insert must win');
        check(
          await store.insert(mint({ ...base, operation: 'other.op' }, 'lease-b')),
          'another operation with the same key is a different claim',
        );
        check(
          await store.insert(
            mint({ ...base, scope: { organizationId: 'org-2', registerId: 'r1' } }, 'lease-c'),
          ),
          'another scope is a different claim',
        );
        const reordered = { ...base, scope: { registerId: 'r1', organizationId: 'org-1' } };
        check(
          !(await store.insert(mint(reordered, 'lease-d'))),
          'scope key order must not make a new identity',
        );
      },
    ],

    [
      'swap requires the current lease token',
      async (store) => {
        const identity = freshIdentity();
        const claim = mint(identity, 'lease-a');
        await store.insert(claim);
        const renewed = { ...claim, leaseExpiresAt: new Date(T0.getTime() + 2 * LEASE_MS) };
        check(
          !(await store.swap(identity, 'lease-wrong', renewed)),
          'swap with a foreign token must lose',
        );
        check(
          await store.swap(identity, 'lease-a', renewed),
          'swap with the owning token must win',
        );
        check(
          sameInstant((await store.get(identity))?.leaseExpiresAt, renewed.leaseExpiresAt),
          'swap must store `next`',
        );
      },
    ],

    [
      'CONCURRENT swaps from one token: exactly one wins',
      async (store) => {
        const identity = freshIdentity();
        await store.insert(mint(identity, 'lease-old'));
        const takeovers = Array.from({ length: 12 }, (_, i) => ({
          ...mint(identity, `lease-new-${i}`),
          attempts: 2,
        }));
        const results = await Promise.all(
          takeovers.map((next) => store.swap(identity, 'lease-old', next)),
        );
        check(
          results.filter(Boolean).length === 1,
          `exactly one takeover must win, got ${results.filter(Boolean).length}`,
        );
      },
    ],

    [
      'a terminal claim cannot be swapped or released, and replays its result',
      async (store) => {
        const identity = freshIdentity();
        const claim = mint(identity, 'lease-a');
        await store.insert(claim);
        const value = { orderNumber: 'ORD-1', lines: [{ sku: 'a', qty: 2 }] };
        const done = completeClaim(claim, {
          leaseToken: 'lease-a',
          now: T0,
          result: { status: 'succeeded', value },
        });
        check(await store.swap(identity, 'lease-a', done), 'completion must win');
        check(!(await store.swap(identity, 'lease-a', done)), 'a terminal claim must refuse swap');
        check(!(await store.release(identity, 'lease-a')), 'a terminal claim must refuse release');
        const got = await store.get(identity);
        check(got?.state === 'succeeded', 'terminal state must round-trip');
        check(
          JSON.stringify(got.result) === JSON.stringify({ status: 'succeeded', value }),
          'the stored value must replay exactly',
        );
      },
    ],

    [
      'a failed result round-trips its code, message and status',
      async (store) => {
        const identity = freshIdentity();
        const claim = mint(identity, 'lease-a');
        await store.insert(claim);
        const error = { code: 'OUT_OF_STOCK', message: 'no units', status: 409 };
        await store.swap(
          identity,
          'lease-a',
          completeClaim(claim, {
            leaseToken: 'lease-a',
            now: T0,
            result: { status: 'failed', error },
          }),
        );
        const got = await store.get(identity);
        check(got?.state === 'failed', 'failed state must round-trip');
        check(
          JSON.stringify(got.result) === JSON.stringify({ status: 'failed', error }),
          'the stored failure must replay exactly',
        );
      },
    ],

    [
      'context, progress and lastError round-trip',
      async (store) => {
        const identity = freshIdentity();
        const claim = {
          ...mint(identity, 'lease-a'),
          context: { orderNumber: 'ORD-1', amount: 500 },
        };
        await store.insert(claim);
        const next = { ...claim, progress: { gatewayRefundId: 'g1' }, lastError: 'timeout' };
        check(await store.swap(identity, 'lease-a', next), 'swap must win');
        const got = await store.get(identity);
        check(
          JSON.stringify(got?.context) === JSON.stringify({ orderNumber: 'ORD-1', amount: 500 }),
          'context must round-trip',
        );
        check(got?.progress?.['gatewayRefundId'] === 'g1', 'progress must round-trip');
        check(got?.lastError === 'timeout', 'lastError must round-trip');
      },
    ],

    [
      'listLapsed returns only lapsed in-flight claims of the operation, oldest first',
      async (store) => {
        const operation = `conformance.sweep.${++seq}`;
        const at = (ms: number) => new Date(T0.getTime() + ms);
        const lapsedOld = {
          ...mint(freshIdentity({ operation }), 'l1'),
          leaseExpiresAt: at(-2_000),
        };
        const lapsedNew = {
          ...mint(freshIdentity({ operation }), 'l2'),
          leaseExpiresAt: at(-1_000),
        };
        const live = { ...mint(freshIdentity({ operation }), 'l3'), leaseExpiresAt: at(60_000) };
        const otherOp = {
          ...mint(freshIdentity({ operation: `${operation}.other` }), 'l4'),
          leaseExpiresAt: at(-5_000),
        };
        const doneClaim = {
          ...mint(freshIdentity({ operation }), 'l5'),
          leaseExpiresAt: at(-9_000),
        };
        for (const c of [lapsedNew, live, otherOp, lapsedOld, doneClaim]) await store.insert(c);
        await store.swap(
          doneClaim.identity,
          'l5',
          completeClaim(doneClaim, {
            leaseToken: 'l5',
            now: T0,
            result: { status: 'succeeded', value: 1 },
          }),
        );
        const found = await store.listLapsed(operation, T0, 10);
        check(
          JSON.stringify(found.map((c) => c.leaseToken)) === JSON.stringify(['l1', 'l2']),
          `expected [l1, l2] (lapsed, in flight, this operation, oldest first), got ${JSON.stringify(found.map((c) => c.leaseToken))}`,
        );
        check((await store.listLapsed(operation, T0, 1)).length === 1, 'limit must be honoured');
      },
    ],

    [
      "release frees only the owner's in-flight claim",
      async (store) => {
        const identity = freshIdentity();
        await store.insert(mint(identity, 'lease-a'));
        check(
          !(await store.release(identity, 'lease-wrong')),
          'release with a foreign token must lose',
        );
        check(await store.release(identity, 'lease-a'), 'release with the owning token must win');
        check((await store.get(identity)) === null, 'a released identity reads as never claimed');
        check(
          await store.insert(mint(identity, 'lease-b')),
          'a released identity can be claimed again',
        );
      },
    ],

    [
      'a recovery point survives a crash and is handed to the takeover',
      async (store) => {
        const identity = freshIdentity();
        const crash = new Error('process died after the order was written');
        const first = runIdempotent({
          store,
          identity,
          requestFingerprint: 'fp-1',
          now: () => T0,
          leaseMs: LEASE_MS,
          execute: async ({ checkpoint }) => {
            await checkpoint({ orderNumber: 'ORD-9' });
            throw crash;
          },
        });
        await first.then(
          () => check(false, 'the crashed attempt must not report success'),
          (error: unknown) => check(error === crash, 'the crash must surface unchanged'),
        );
        const stored = await store.get(identity);
        check(
          stored?.state === 'in_flight',
          'a failure after a recovery point must KEEP the claim, not release it',
        );
        check(stored.progress?.['orderNumber'] === 'ORD-9', 'the recovery point must be stored');

        let resumedFrom: unknown;
        const later = new Date(T0.getTime() + LEASE_MS);
        const second = await runIdempotent({
          store,
          identity,
          requestFingerprint: 'fp-1',
          now: () => later,
          execute: async ({ progress, attempt }) => {
            resumedFrom = { progress, attempt };
            return { orderNumber: progress?.['orderNumber'] };
          },
        });
        check(
          JSON.stringify(resumedFrom) ===
            JSON.stringify({ progress: { orderNumber: 'ORD-9' }, attempt: 2 }),
          `the takeover must resume from the recovery point, got ${JSON.stringify(resumedFrom)}`,
        );
        check(second.outcome === 'executed', 'the takeover completes the command');
      },
    ],

    [
      'runIdempotent over this store executes ONCE under concurrent retries',
      async (store) => {
        const identity = freshIdentity();
        let executions = 0;
        const attempt = () =>
          runIdempotent({
            store,
            identity,
            requestFingerprint: 'fp-1',
            execute: async () => {
              executions++;
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { orderNumber: 'ORD-1' };
            },
          });
        const runs = await Promise.all(Array.from({ length: 8 }, attempt));
        const again = await attempt();
        check(executions === 1, `execute must run exactly once, ran ${executions}`);
        check(
          runs.filter((r) => r.outcome === 'executed').length === 1,
          'exactly one run reports executed',
        );
        check(
          again.outcome === 'replayed' && again.value.orderNumber === 'ORD-1',
          'a later retry replays the stored value',
        );
      },
    ],
  ];

  return cases.map(([name, body]) => ({
    name,
    run: async () => body(await harness.createStore()),
  }));
}

/** Register every contract case as a vitest test against `harness.createStore()`. */
export function runIdempotencyStoreConformance(harness: IdempotencyConformanceHarness): void {
  describe('IdempotencyClaimStore contract', () => {
    for (const c of idempotencyStoreCases(harness)) it(c.name, c.run);
  });
}
