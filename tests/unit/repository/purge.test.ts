/**
 * `runChunkedPurge` orchestrator — signal/retry interplay. Pins that
 * `options.signal` flows into `withRetry`, so an abort fired during
 * retry backoff stops before the next attempt (not only between chunks).
 */

import { describe, expect, it } from 'vitest';
import type { PurgePort } from '../../../src/repository/purge.js';
import { runChunkedPurge } from '../../../src/repository/purge.js';

const HARD = { type: 'hard' } as const;

describe('runChunkedPurge — retry + signal', () => {
  it('retries transient chunk failures and completes (control)', async () => {
    let calls = 0;
    const port: PurgePort = {
      purgeChunk: async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return 0; // no matching rows — natural exit
      },
    };

    const result = await runChunkedPurge(
      HARD,
      { batchSize: 10, retry: { maxAttempts: 3, baseDelayMs: 1 } },
      port,
    );

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('honors an abort fired during retry backoff — no further attempts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const port: PurgePort = {
      purgeChunk: async () => {
        calls++;
        // Abort mid-backoff: fires after this attempt throws, well
        // before the 50ms backoff elapses.
        setTimeout(() => controller.abort(new Error('cancelled')), 5);
        throw new Error('transient');
      },
    };

    const result = await runChunkedPurge(
      HARD,
      {
        batchSize: 10,
        signal: controller.signal,
        retry: { maxAttempts: 5, baseDelayMs: 50 },
      },
      port,
    );

    // Without the signal flowing into withRetry, attempt 2 would run
    // after backoff (calls === 2+). With it, the abort is observed
    // before the next attempt.
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(0);
    expect(result.error?.message).toBe('cancelled');
  });
});
