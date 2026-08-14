import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryLockAdapter } from '../../../src/lock/index.js';

describe('createMemoryLockAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('first acquire wins; concurrent attempt by another holder fails', () => {
    const lock = createMemoryLockAdapter();
    expect(lock.tryAcquire('cron.outbox', 'replica-A', 5_000)).toBe(true);
    expect(lock.tryAcquire('cron.outbox', 'replica-B', 5_000)).toBe(false);
  });

  it('same holder may extend (idempotent)', () => {
    const lock = createMemoryLockAdapter();
    expect(lock.tryAcquire('cron.outbox', 'replica-A', 5_000)).toBe(true);
    expect(lock.tryAcquire('cron.outbox', 'replica-A', 5_000)).toBe(true);
  });

  it('expired lease is reclaimable by another holder', () => {
    const lock = createMemoryLockAdapter();
    expect(lock.tryAcquire('cron.outbox', 'replica-A', 5_000)).toBe(true);

    vi.advanceTimersByTime(6_000);

    expect(lock.tryAcquire('cron.outbox', 'replica-B', 5_000)).toBe(true);
    // The old holder finds itself locked out — replica-B owns the lease now.
    expect(lock.tryAcquire('cron.outbox', 'replica-A', 5_000)).toBe(false);
  });

  it('release(): only the holder may release; others get false', () => {
    const lock = createMemoryLockAdapter();
    lock.tryAcquire('cron.outbox', 'replica-A', 5_000);
    expect(lock.release('cron.outbox', 'replica-B')).toBe(false);
    expect(lock.release('cron.outbox', 'replica-A')).toBe(true);
    // Released → next acquire wins.
    expect(lock.tryAcquire('cron.outbox', 'replica-B', 5_000)).toBe(true);
  });

  it('release() on an unheld lock is safe (returns false)', () => {
    const lock = createMemoryLockAdapter();
    expect(lock.release('never.acquired', 'replica-A')).toBe(false);
  });

  it('inspect() reports the current holder + expiry', () => {
    const lock = createMemoryLockAdapter();
    lock.tryAcquire('cron.outbox', 'replica-A', 5_000);
    const state = lock.inspect?.('cron.outbox');
    expect(state).toEqual({
      name: 'cron.outbox',
      holder: 'replica-A',
      expiresAt: new Date('2026-01-01T00:00:05.000Z'),
      acquiredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('inspect() returns null after expiry', () => {
    const lock = createMemoryLockAdapter();
    lock.tryAcquire('cron.outbox', 'replica-A', 5_000);
    vi.advanceTimersByTime(6_000);
    expect(lock.inspect?.('cron.outbox')).toBeNull();
  });

  it('extending preserves the original acquiredAt for diagnostics', () => {
    const lock = createMemoryLockAdapter();
    lock.tryAcquire('cron.outbox', 'replica-A', 5_000);
    const acquiredAt = lock.inspect?.('cron.outbox')?.acquiredAt;

    vi.advanceTimersByTime(2_000);
    lock.tryAcquire('cron.outbox', 'replica-A', 5_000);
    expect(lock.inspect?.('cron.outbox')?.acquiredAt).toEqual(acquiredAt);
  });

  it('defaultLeaseMs is used when caller passes 0 or negative', () => {
    const lock = createMemoryLockAdapter({ defaultLeaseMs: 1_000 });
    lock.tryAcquire('cron.outbox', 'replica-A', 0);
    vi.advanceTimersByTime(500);
    expect(lock.tryAcquire('cron.outbox', 'replica-B', 0)).toBe(false);
    vi.advanceTimersByTime(600);
    // 1.1s elapsed > 1s default lease → reclaimable.
    expect(lock.tryAcquire('cron.outbox', 'replica-B', 0)).toBe(true);
  });
});

describe('fencing tokens (tryAcquireFenced)', () => {
  it('mints a MONOTONIC token per ownership change; extension keeps it', async () => {
    const { createMemoryLockAdapter } = await import('../../../src/lock/index.js');
    const lock = createMemoryLockAdapter({ defaultLeaseMs: 50 });

    const a1 = await lock.tryAcquireFenced?.('job', 'holder-A', 1_000);
    expect(a1?.token).toBe(1);
    // Extension by the SAME holder: the fence marks ownership epochs, not heartbeats.
    const a2 = await lock.tryAcquireFenced?.('job', 'holder-A', 1_000);
    expect(a2?.token).toBe(1);
    // Contender while held → not acquired.
    expect(await lock.tryAcquireFenced?.('job', 'holder-B', 1_000)).toBeNull();

    await lock.release('job', 'holder-A');
    // NEW holder → strictly greater token, even after release (not reset).
    const b1 = await lock.tryAcquireFenced?.('job', 'holder-B', 1_000);
    expect(b1?.token).toBe(2);
  });

  it('expired-lease takeover mints a HIGHER token — the stale holder is fenceable', async () => {
    const { createMemoryLockAdapter } = await import('../../../src/lock/index.js');
    const lock = createMemoryLockAdapter();
    const a = await lock.tryAcquireFenced?.('relay', 'old', 1); // 1ms lease
    await new Promise((r) => setTimeout(r, 10));
    const b = await lock.tryAcquireFenced?.('relay', 'new', 1_000);
    expect(b?.token).toBeGreaterThan(a?.token ?? Infinity * -1);
    // A downstream store comparing tokens now REJECTS 'old' — the overlap
    // serialized renewal narrows but cannot close.
  });

  it('boolean tryAcquire still works — the fenced path is additive', async () => {
    const { createMemoryLockAdapter } = await import('../../../src/lock/index.js');
    const lock = createMemoryLockAdapter();
    expect(await lock.tryAcquire('x', 'h', 1_000)).toBe(true);
    expect(await lock.tryAcquire('x', 'other', 1_000)).toBe(false);
  });
});
