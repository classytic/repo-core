/**
 * `runIdempotent` + the store port: every outcome of the decision table, driven
 * through a real store, and the memory store held to the same conformance suite
 * every persistence kit must pass.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryIdempotencyStore,
  type IdempotencyClaimStore,
  IdempotencyError,
  IdempotentReplayError,
  runIdempotent,
} from '../../../src/idempotency/index.js';
import {
  idempotencyStoreCases,
  runIdempotencyStoreConformance,
} from '../../../src/testing/index.js';

describe('memory store conformance', () => {
  runIdempotencyStoreConformance({ createStore: () => createMemoryIdempotencyStore() });
});

describe('the conformance suite catches a read-then-write store', () => {
  it('fails the concurrent-insert case', async () => {
    // Every check but the race passes against this store — the suite must still refuse it.
    const racy = (): IdempotencyClaimStore => {
      const inner = createMemoryIdempotencyStore();
      return {
        ...inner,
        async insert(claim) {
          const existing = await inner.get(claim.identity);
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (existing) return false;
          await inner.release(claim.identity, (await inner.get(claim.identity))?.leaseToken ?? '');
          return inner.insert(claim);
        },
      };
    };
    const race = idempotencyStoreCases({ createStore: racy }).find((c) =>
      c.name.startsWith('CONCURRENT inserts'),
    );
    if (!race) throw new Error('the concurrent-insert case is missing');
    await expect(race.run()).rejects.toThrow(/exactly one insert must win/);
  });
});

const identity = {
  operation: 'pos.checkout',
  key: 'attempt-1',
  scope: { organizationId: 'org-1' },
};

function clock(start = Date.parse('2026-01-01T00:00:00Z')) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('runIdempotent', () => {
  it('executes once, then replays the stored value', async () => {
    const store = createMemoryIdempotencyStore();
    let runs = 0;
    const run = () =>
      runIdempotent({
        store,
        identity,
        requestFingerprint: 'fp',
        execute: async () => ({ n: ++runs }),
      });
    expect(await run()).toEqual({ outcome: 'executed', value: { n: 1 }, attempt: 1 });
    expect(await run()).toEqual({ outcome: 'replayed', value: { n: 1 } });
    expect(runs).toBe(1);
  });

  it('refuses the same key with a different body — never replays, never re-executes', async () => {
    const store = createMemoryIdempotencyStore();
    await runIdempotent({ store, identity, requestFingerprint: 'fp-a', execute: async () => 1 });
    const other = runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp-b',
      execute: async () => 2,
    });
    await expect(other).rejects.toMatchObject({ code: 'FINGERPRINT_MISMATCH' });
  });

  it('answers in_flight while another attempt holds a live lease', async () => {
    const store = createMemoryIdempotencyStore();
    let release!: () => void;
    const first = runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      execute: () => new Promise<number>((resolve) => (release = () => resolve(1))),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      execute: async () => 2,
    });
    expect(second.outcome).toBe('in_flight');
    release();
    expect((await first).outcome).toBe('executed');
  });

  it('a TERMINAL failure is stored and replayed with its code and status', async () => {
    const store = createMemoryIdempotencyStore();
    const refusal = Object.assign(new Error('no units'), { code: 'OUT_OF_STOCK', status: 409 });
    const opts = {
      store,
      identity,
      requestFingerprint: 'fp',
      classifyFailure: (e: unknown) => {
        const err = e as { code?: string; status?: number; message: string };
        return err.code === 'OUT_OF_STOCK'
          ? ({
              kind: 'terminal',
              error: { code: err.code, message: err.message, status: err.status },
            } as const)
          : ({ kind: 'transient' } as const);
      },
    };
    await expect(
      runIdempotent({
        ...opts,
        execute: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    const replay = runIdempotent({ ...opts, execute: async () => 1 });
    await expect(replay).rejects.toBeInstanceOf(IdempotentReplayError);
    await expect(replay).rejects.toMatchObject({ code: 'OUT_OF_STOCK', status: 409 });
  });

  it('a TRANSIENT failure releases the key, so the retry executes', async () => {
    const store = createMemoryIdempotencyStore();
    const flaky = new Error('socket hang up');
    await expect(
      runIdempotent({
        store,
        identity,
        requestFingerprint: 'fp',
        execute: async () => {
          throw flaky;
        },
      }),
    ).rejects.toBe(flaky);
    const retry = await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      execute: async () => 7,
    });
    expect(retry).toEqual({ outcome: 'executed', value: 7, attempt: 1 });
  });

  it('takes over a crashed attempt once its lease lapses', async () => {
    const store = createMemoryIdempotencyStore();
    const c = clock();
    // A crash: the first attempt claims and never completes.
    void runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      now: c.now,
      leaseMs: 1_000,
      execute: () => new Promise(() => {}),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (
        await runIdempotent({
          store,
          identity,
          requestFingerprint: 'fp',
          now: c.now,
          execute: async () => 2,
        })
      ).outcome,
    ).toBe('in_flight');
    c.advance(1_000);
    expect(
      await runIdempotent({
        store,
        identity,
        requestFingerprint: 'fp',
        now: c.now,
        execute: async () => 2,
      }),
    ).toEqual({
      outcome: 'executed',
      value: 2,
      attempt: 2,
    });
  });

  it('an AMBIGUOUS failure keeps the claim, lapses it NOW and records the error — the retry resumes at once', async () => {
    const store = createMemoryIdempotencyStore();
    const c = clock();
    const timeout = new Error('gateway timed out');
    await expect(
      runIdempotent({
        store,
        identity,
        requestFingerprint: 'fp',
        now: c.now,
        context: { amount: 500 },
        classifyFailure: () => ({ kind: 'ambiguous' }),
        execute: async ({ checkpoint }) => {
          await checkpoint({ sent: true });
          throw timeout;
        },
      }),
    ).rejects.toBe(timeout);
    expect(store.claims()[0]).toMatchObject({
      state: 'in_flight',
      lastError: 'gateway timed out',
      progress: { sent: true },
    });

    // No waiting out the lease: the same instant, a retry takes over with progress AND context.
    let seen: unknown;
    const retry = await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      now: c.now,
      execute: async ({ progress, context }) => {
        seen = { progress, context };
        return 'done';
      },
    });
    expect(retry.outcome).toBe('executed');
    expect(seen).toEqual({ progress: { sent: true }, context: { amount: 500 } });
  });

  it('a transient failure AFTER a checkpoint is ambiguous — something landed, so the claim is kept', async () => {
    const store = createMemoryIdempotencyStore();
    await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      execute: async ({ checkpoint }) => {
        await checkpoint({ orderNumber: 'ORD-1' });
        throw new Error('socket closed');
      },
    }).catch(() => undefined);
    expect(store.claims()[0]?.state).toBe('in_flight');
  });

  it('past maxAttempts a lapsed claim is EXHAUSTED — nothing runs, the error is reported', async () => {
    const store = createMemoryIdempotencyStore();
    const failing = () =>
      runIdempotent({
        store,
        identity,
        requestFingerprint: 'fp',
        maxAttempts: 2,
        classifyFailure: () => ({ kind: 'ambiguous' }),
        execute: async () => {
          throw new Error('provider wedged');
        },
      }).catch(() => undefined);
    await failing();
    await failing();
    let ran = false;
    const third = await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      maxAttempts: 2,
      execute: async () => {
        ran = true;
        return 1;
      },
    });
    expect(ran).toBe(false);
    expect(third).toMatchObject({
      outcome: 'exhausted',
      attempts: 2,
      lastError: 'provider wedged',
    });
  });

  it("a checkpoint can join the side effect's own transaction — its session reaches the store", async () => {
    const inner = createMemoryIdempotencyStore();
    const sessionsSeen: unknown[] = [];
    const store = {
      ...inner,
      swap: (...args: Parameters<typeof inner.swap>) => {
        sessionsSeen.push(args[3]?.session);
        return inner.swap(...args);
      },
    };
    const paymentTxn = { id: 'payment-session' };
    await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      storeOptions: { session: 'outer' },
      execute: async ({ checkpoint }) => {
        await checkpoint({ paid: true }, { session: paymentTxn });
        await checkpoint({ noted: true });
        return 1;
      },
    });
    // The payment's checkpoint rode its transaction; the plain one fell back to storeOptions.
    expect(sessionsSeen.slice(0, 2)).toEqual([paymentTxn, 'outer']);
  });

  it('in_flight reports what the running attempt has durably done', async () => {
    const store = createMemoryIdempotencyStore();
    let release!: () => void;
    const first = runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      execute: async ({ checkpoint }) => {
        await checkpoint({ paid: true });
        await new Promise<void>((resolve) => (release = resolve));
        return 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      execute: async () => 2,
    });
    expect(second).toMatchObject({ outcome: 'in_flight', progress: { paid: true } });
    release();
    await first;
  });

  it('a slow attempt whose lease was taken over reports LEASE_LOST instead of "ok"', async () => {
    const store = createMemoryIdempotencyStore();
    const c = clock();
    let finishSlow!: () => void;
    const slow = runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      now: c.now,
      leaseMs: 1_000,
      execute: () => new Promise<number>((resolve) => (finishSlow = () => resolve(1))),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    c.advance(1_000);
    await runIdempotent({
      store,
      identity,
      requestFingerprint: 'fp',
      now: c.now,
      execute: async () => 2,
    });
    finishSlow();
    await expect(slow).rejects.toBeInstanceOf(IdempotencyError);
    await expect(slow).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
});
