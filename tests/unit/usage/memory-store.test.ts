/**
 * `./usage` — canonical usage-counter contract + reference memory store.
 * Pins: atomic per-bucket increments, actor/period/kind isolation,
 * `{}` for unknown actors (never throws), usagePeriod UTC keys, clear().
 */
import { describe, expect, it } from 'vitest';
import { createMemoryUsageStore, usagePeriod } from '../../../src/usage/index.js';

describe('usagePeriod', () => {
  it('produces UTC YYYY-MM keys', () => {
    expect(usagePeriod(new Date(Date.UTC(2026, 6, 14)))).toBe('2026-07');
    expect(usagePeriod(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01');
    expect(usagePeriod(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe('2026-12');
  });
});

describe('createMemoryUsageStore', () => {
  it('accumulates increments per (actor, period, kind)', async () => {
    const store = createMemoryUsageStore();
    const bucket = { actor: 'org-1', period: '2026-07', kind: 'api.requests' };
    store.increment(bucket, 1);
    store.increment(bucket, 1);
    store.increment({ ...bucket, kind: 'ai.tokens.input' }, 500);

    expect(await store.summary('org-1', '2026-07')).toEqual({
      'api.requests': 2,
      'ai.tokens.input': 500,
    });
  });

  it('isolates actors and periods', async () => {
    const store = createMemoryUsageStore();
    store.increment({ actor: 'org-1', period: '2026-06', kind: 'k' }, 5);
    store.increment({ actor: 'org-1', period: '2026-07', kind: 'k' }, 7);
    store.increment({ actor: 'org-2', period: '2026-07', kind: 'k' }, 11);

    expect(await store.summary('org-1', '2026-06')).toEqual({ k: 5 });
    expect(await store.summary('org-1', '2026-07')).toEqual({ k: 7 });
    expect(await store.summary('org-2', '2026-07')).toEqual({ k: 11 });
  });

  it('returns {} for unknown actor/period (never throws)', async () => {
    const store = createMemoryUsageStore();
    expect(await store.summary('nobody', '2026-07')).toEqual({});
  });

  it('clear() drops everything (test convenience)', async () => {
    const store = createMemoryUsageStore();
    store.increment({ actor: 'a', period: '2026-07', kind: 'k' }, 1);
    store.clear();
    expect(await store.summary('a', '2026-07')).toEqual({});
  });
});
