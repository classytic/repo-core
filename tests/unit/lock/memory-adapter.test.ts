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
