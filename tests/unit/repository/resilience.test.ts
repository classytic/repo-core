/**
 * `withRetry` / `throwIfAborted` — the single retry/abort implementation
 * every kit and chunked orchestrator shares. Pins backoff semantics so
 * they never drift between call sites.
 */

import { describe, expect, it } from 'vitest';
import { throwIfAborted, withRetry } from '../../../src/repository/resilience.js';

describe('withRetry', () => {
  it('passes through with no policy (single attempt, no wrapping)', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'ok';
    }, undefined);
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('does not retry without a policy', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('boom');
      }, undefined),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('retries transient failures and returns the eventual success', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'recovered';
      },
      { maxAttempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws the last error after exhausting maxAttempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('fail-2');
    expect(calls).toBe(2);
  });

  it('stops immediately when shouldRetry classifies the error as permanent', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('validation failed');
        },
        {
          maxAttempts: 5,
          baseDelayMs: 1,
          shouldRetry: (err) => !/validation/.test(String(err)),
        },
      ),
    ).rejects.toThrow('validation failed');
    expect(calls).toBe(1);
  });

  it('aborts between attempts when the signal fires', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          controller.abort(new Error('cancelled'));
          throw new Error('transient');
        },
        { maxAttempts: 5, baseDelayMs: 1 },
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });
});

describe('throwIfAborted', () => {
  it('is a no-op for undefined and live signals', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('throws the abort reason for aborted signals', () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    expect(() => throwIfAborted(controller.signal)).toThrow('stop');
  });
});
