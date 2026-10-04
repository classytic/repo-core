import { describe, expect, it } from 'vitest';
import {
  type ClaimRequest,
  completeClaim,
  DEFAULT_LEASE_MS,
  decideClaim,
  fingerprintRequest,
  holdsLease,
  type IdempotencyClaim,
  IdempotencyError,
  type IdempotencyIdentity,
  identityKey,
  isInFlight,
  isLeaseExpired,
  newLeaseToken,
  renewLease,
  sameIdentity,
} from '../../../src/idempotency/index.js';

const T0 = new Date('2026-08-05T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const identity: IdempotencyIdentity = {
  operation: 'checkout.finalize',
  key: 'idem-abc',
  scope: { organizationId: 'org_1', cartRef: 'cart_9' },
};

const FP = fingerprintRequest({ cartRef: 'cart_9', total: 4999 });

const request = (over: Partial<ClaimRequest> = {}): ClaimRequest => ({
  identity,
  requestFingerprint: FP,
  now: T0,
  leaseToken: 'lease-A',
  ...over,
});

const inFlightClaim = (over: Partial<IdempotencyClaim> = {}): IdempotencyClaim => ({
  identity,
  requestFingerprint: FP,
  state: 'in_flight',
  leaseToken: 'lease-A',
  leaseExpiresAt: at(DEFAULT_LEASE_MS),
  createdAt: T0,
  attempts: 1,
  ...over,
});

describe('identityKey / sameIdentity', () => {
  it('is order-independent over scope keys', () => {
    expect(identityKey({ operation: 'op', key: 'k', scope: { a: '1', b: '2' } })).toBe(
      identityKey({ operation: 'op', key: 'k', scope: { b: '2', a: '1' } }),
    );
  });

  it('does NOT collide when a scope value contains the delimiter a join would use', () => {
    const a = identityKey({ operation: 'op', key: 'k', scope: { ref: 'a:b', actor: 'c' } });
    const b = identityKey({ operation: 'op', key: 'k', scope: { ref: 'a', actor: 'b:c' } });
    expect(a).not.toBe(b);
  });

  it('separates the same key used for two different operations', () => {
    expect(sameIdentity({ operation: 'a', key: 'k' }, { operation: 'b', key: 'k' })).toBe(false);
  });

  it('rejects an empty operation or key rather than indexing on a blank', () => {
    expect(() => identityKey({ operation: '', key: 'k' })).toThrow(IdempotencyError);
    expect(() => identityKey({ operation: 'op', key: '' })).toThrow(IdempotencyError);
  });
});

describe('fingerprintRequest', () => {
  it('is stable under key reordering', () => {
    expect(fingerprintRequest({ a: 1, b: 2 })).toBe(fingerprintRequest({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(fingerprintRequest({ total: 4999 })).not.toBe(fingerprintRequest({ total: 5000 }));
  });

  it('fingerprints what the WIRE carries — an in-memory body matches the same body received', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(fingerprintRequest({ a: 1, note: undefined, at })).toBe(
      fingerprintRequest(JSON.parse(JSON.stringify({ a: 1, at }))),
    );
  });

  it('refuses a body nested past the depth limit instead of overflowing the stack', () => {
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 5_000; i++) deep = { a: deep };
    expect(() => fingerprintRequest(deep)).toThrow(/nested deeper than 100/);
  });
});

describe('decideClaim — no record', () => {
  it('claims, in_flight, with a lease that expires leaseMs later', () => {
    const decision = decideClaim(null, request());
    expect(decision.outcome).toBe('claimed');
    if (decision.outcome !== 'claimed') throw new Error('unreachable');
    expect(decision.claim.state).toBe('in_flight');
    expect(decision.claim.leaseToken).toBe('lease-A');
    expect(decision.claim.leaseExpiresAt.getTime()).toBe(T0.getTime() + DEFAULT_LEASE_MS);
    expect(decision.claim.attempts).toBe(1);
    expect(decision.tookOverFrom).toBeUndefined();
  });

  it('honours an explicit leaseMs', () => {
    const decision = decideClaim(null, request({ leaseMs: 5_000 }));
    if (decision.outcome !== 'claimed') throw new Error('unreachable');
    expect(decision.claim.leaseExpiresAt.getTime()).toBe(T0.getTime() + 5_000);
  });

  it('REJECTS a non-positive lease — an instantly-dead lease lets every attempt execute', () => {
    expect(() => decideClaim(null, request({ leaseMs: 0 }))).toThrow(
      /positive number of milliseconds/,
    );
    expect(() => decideClaim(null, request({ leaseMs: -1 }))).toThrow(IdempotencyError);
  });

  it('rejects a missing lease token or clock', () => {
    expect(() => decideClaim(null, request({ leaseToken: '' }))).toThrow(IdempotencyError);
    // @ts-expect-error — runtime guard on an ambient-clock mistake.
    expect(() => decideClaim(null, request({ now: undefined }))).toThrow(IdempotencyError);
  });
});

describe('decideClaim — live lease is IN_FLIGHT, not a failure', () => {
  it('reports in_flight with a positive retryAfterMs', () => {
    const decision = decideClaim(
      inFlightClaim(),
      request({ leaseToken: 'lease-B', now: at(10_000) }),
    );
    expect(decision.outcome).toBe('in_flight');
    if (!isInFlight(decision)) throw new Error('unreachable');
    expect(decision.retryAfterMs).toBe(DEFAULT_LEASE_MS - 10_000);
  });

  it('does NOT surface in_flight as a claim — a second executor is the double-apply', () => {
    const decision = decideClaim(inFlightClaim(), request({ leaseToken: 'lease-B', now: at(1) }));
    expect(decision.outcome).not.toBe('claimed');
    expect(decision.outcome).not.toBe('replayed');
  });

  it('keeps the incumbent’s lease token — the asker does not take ownership', () => {
    const decision = decideClaim(inFlightClaim(), request({ leaseToken: 'lease-B', now: at(1) }));
    expect(decision.claim.leaseToken).toBe('lease-A');
  });
});

describe('decideClaim — lapsed lease is a TAKEOVER', () => {
  it('claims at exactly the expiry instant', () => {
    const decision = decideClaim(
      inFlightClaim(),
      request({ leaseToken: 'lease-B', now: at(DEFAULT_LEASE_MS) }),
    );
    expect(decision.outcome).toBe('claimed');
    if (decision.outcome !== 'claimed') throw new Error('unreachable');
    expect(decision.tookOverFrom).toBe('lease-A');
    expect(decision.claim.leaseToken).toBe('lease-B');
    expect(decision.claim.attempts).toBe(2);
  });

  it('preserves the original createdAt across a takeover', () => {
    const decision = decideClaim(
      inFlightClaim({ createdAt: new Date('2026-01-01T00:00:00Z') }),
      request({ leaseToken: 'lease-B', now: at(60_000) }),
    );
    if (decision.outcome !== 'claimed') throw new Error('unreachable');
    expect(decision.claim.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('decideClaim — terminal records REPLAY', () => {
  it('replays a stored success without re-executing', () => {
    const stored = inFlightClaim({
      state: 'succeeded',
      completedAt: at(500),
      result: { status: 'succeeded', value: { orderId: 'ord_1' } },
    });
    const decision = decideClaim(stored, request({ leaseToken: 'lease-B', now: at(60_000) }));
    expect(decision.outcome).toBe('replayed');
    if (decision.outcome !== 'replayed') throw new Error('unreachable');
    expect(decision.result).toEqual({ status: 'succeeded', value: { orderId: 'ord_1' } });
  });

  it('replays a stored FAILURE verbatim — a failed command must not re-execute', () => {
    const stored = inFlightClaim({
      state: 'failed',
      completedAt: at(500),
      result: {
        status: 'failed',
        error: { code: 'insufficient_stock', message: 'SKU-1 unavailable' },
      },
    });
    const decision = decideClaim(stored, request({ leaseToken: 'lease-B', now: at(60_000) }));
    expect(decision.outcome).toBe('replayed');
    if (decision.outcome !== 'replayed') throw new Error('unreachable');
    expect(decision.result.status).toBe('failed');
  });

  it('replays even after the lease lapsed — terminal beats expiry', () => {
    const stored = inFlightClaim({
      state: 'succeeded',
      leaseExpiresAt: at(-1),
      result: { status: 'succeeded', value: 1 },
    });
    expect(decideClaim(stored, request({ now: at(999_999), leaseToken: 'lease-B' })).outcome).toBe(
      'replayed',
    );
  });

  it('THROWS on a terminal record with no stored result instead of inventing a success', () => {
    const stored = inFlightClaim({ state: 'succeeded', completedAt: at(1) });
    expect(() => decideClaim(stored, request({ leaseToken: 'lease-B', now: at(60_000) }))).toThrow(
      /stores no result/,
    );
  });
});

describe('decideClaim — fingerprint mismatch is a CONFLICT, never a fresh claim', () => {
  const otherFp = fingerprintRequest({ cartRef: 'cart_9', total: 999_999 });

  it('throws when the same key arrives with a different body', () => {
    expect(() => decideClaim(inFlightClaim(), request({ requestFingerprint: otherFp }))).toThrow(
      /different request body/,
    );
  });

  it('throws even when the stored claim is terminal — it would replay the WRONG result', () => {
    const stored = inFlightClaim({ state: 'succeeded', result: { status: 'succeeded', value: 1 } });
    expect(() => decideClaim(stored, request({ requestFingerprint: otherFp }))).toThrow(
      IdempotencyError,
    );
  });

  it('throws even when the lease has lapsed — it would apply a second command on a spent key', () => {
    expect(() =>
      decideClaim(inFlightClaim(), request({ requestFingerprint: otherFp, now: at(999_999) })),
    ).toThrow(IdempotencyError);
  });
});

describe('lease ownership', () => {
  it('isLeaseExpired is inclusive of the expiry instant', () => {
    const claim = inFlightClaim();
    expect(isLeaseExpired(claim, at(DEFAULT_LEASE_MS - 1))).toBe(false);
    expect(isLeaseExpired(claim, at(DEFAULT_LEASE_MS))).toBe(true);
  });

  it('holdsLease requires BOTH the token and a live lease', () => {
    const claim = inFlightClaim();
    expect(holdsLease(claim, 'lease-A', at(1))).toBe(true);
    expect(holdsLease(claim, 'lease-B', at(1))).toBe(false);
    expect(holdsLease(claim, 'lease-A', at(DEFAULT_LEASE_MS))).toBe(false);
  });

  it('newLeaseToken never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newLeaseToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('renewLease', () => {
  it('extends a lease the caller still owns', () => {
    const renewed = renewLease(inFlightClaim(), {
      leaseToken: 'lease-A',
      now: at(10_000),
      leaseMs: 5_000,
    });
    expect(renewed.leaseExpiresAt.getTime()).toBe(T0.getTime() + 15_000);
  });

  it('THROWS when the lease was taken over — a superseded attempt must not keep going', () => {
    expect(() => renewLease(inFlightClaim(), { leaseToken: 'lease-B', now: at(1) })).toThrow(
      /LEASE_LOST|does not own/,
    );
  });

  it('THROWS when the lease already lapsed', () => {
    expect(() => renewLease(inFlightClaim(), { leaseToken: 'lease-A', now: at(60_000) })).toThrow(
      IdempotencyError,
    );
  });

  it('refuses to renew a terminal claim', () => {
    const done = inFlightClaim({ state: 'succeeded', result: { status: 'succeeded', value: 1 } });
    expect(() => renewLease(done, { leaseToken: 'lease-A', now: at(1) })).toThrow(
      /cannot renew a succeeded claim/,
    );
  });
});

describe('completeClaim', () => {
  it('moves the claim terminal and stores the replayable result', () => {
    const done = completeClaim(inFlightClaim(), {
      leaseToken: 'lease-A',
      now: at(2_000),
      result: { status: 'succeeded', value: { orderId: 'ord_1' } },
    });
    expect(done.state).toBe('succeeded');
    expect(done.completedAt?.getTime()).toBe(T0.getTime() + 2_000);
    expect(done.result).toEqual({ status: 'succeeded', value: { orderId: 'ord_1' } });
  });

  it('derives the terminal state FROM the result — a failure never lands as succeeded', () => {
    const done = completeClaim(inFlightClaim(), {
      leaseToken: 'lease-A',
      now: at(1),
      result: { status: 'failed', error: { code: 'declined', message: 'no' } },
    });
    expect(done.state).toBe('failed');
  });

  it('THROWS when the attempt lost its lease — it would overwrite the winner’s result', () => {
    expect(() =>
      completeClaim(inFlightClaim({ leaseToken: 'lease-B', attempts: 2 }), {
        leaseToken: 'lease-A',
        now: at(1),
        result: { status: 'succeeded', value: 1 },
      }),
    ).toThrow(/overwrite theirs/);
  });

  it('THROWS on double completion', () => {
    const done = completeClaim(inFlightClaim(), {
      leaseToken: 'lease-A',
      now: at(1),
      result: { status: 'succeeded', value: 1 },
    });
    expect(() =>
      completeClaim(done, {
        leaseToken: 'lease-A',
        now: at(2),
        result: { status: 'succeeded', value: 2 },
      }),
    ).toThrow(/already succeeded/);
  });
});

describe('end-to-end: the crash window', () => {
  it('attempt A dies mid-flight; B takes over after expiry and its result is what replays', () => {
    // A claims.
    const a = decideClaim(null, request({ leaseToken: 'lease-A' }));
    if (a.outcome !== 'claimed') throw new Error('unreachable');

    // A concurrent B, inside the window, must WAIT — not execute.
    const concurrent = decideClaim(a.claim, request({ leaseToken: 'lease-B', now: at(5_000) }));
    expect(concurrent.outcome).toBe('in_flight');

    // A crashes. After the window, B takes over.
    const takeover = decideClaim(a.claim, request({ leaseToken: 'lease-B', now: at(31_000) }));
    if (takeover.outcome !== 'claimed') throw new Error('unreachable');
    expect(takeover.tookOverFrom).toBe('lease-A');

    // Zombie A cannot write its result.
    expect(() =>
      completeClaim(takeover.claim, {
        leaseToken: 'lease-A',
        now: at(32_000),
        result: { status: 'succeeded', value: 'A' },
      }),
    ).toThrow(IdempotencyError);

    // B completes; a third attempt replays B's answer.
    const completed = completeClaim(takeover.claim, {
      leaseToken: 'lease-B',
      now: at(33_000),
      result: { status: 'succeeded', value: 'B' },
    });
    const third = decideClaim(completed, request({ leaseToken: 'lease-C', now: at(40_000) }));
    if (third.outcome !== 'replayed') throw new Error('unreachable');
    expect(third.result).toEqual({ status: 'succeeded', value: 'B' });
  });
});
