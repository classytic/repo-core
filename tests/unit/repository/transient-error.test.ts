/**
 * `isTransientError` — the retry default.
 *
 * `shouldRetry` used to default to `() => true`, with a comment conceding it
 * was unsafe and asking callers to pass their own. That is a documented hazard,
 * not a fence: a policy added for network blips also re-ran the write on a
 * duplicate key, a validation failure and a permission denial — three times,
 * with backoff. For a non-idempotent write against a slow-but-succeeding
 * server, that is a double write.
 *
 * The rule the cases below encode: retry a failure that MAY not have happened;
 * never one that definitely did.
 */

import { describe, expect, it } from 'vitest';
import { isTransientError, withRetry } from '../../../src/repository/resilience.js';

/** A driver error carrying MongoDB-style labels. */
const labelled = (label: string) =>
  Object.assign(new Error('write failed'), {
    hasErrorLabel: (l: string) => l === label,
  });

describe('retries what may not have happened', () => {
  it.each([
    ['RetryableWriteError label', labelled('RetryableWriteError')],
    ['TransientTransactionError label', labelled('TransientTransactionError')],
    ['write conflict', Object.assign(new Error('x'), { codeName: 'WriteConflict' })],
    ['lock timeout', Object.assign(new Error('x'), { codeName: 'LockTimeout' })],
    ['failover', Object.assign(new Error('x'), { codeName: 'NotWritablePrimary' })],
    ['step-down', Object.assign(new Error('x'), { codeName: 'PrimarySteppedDown' })],
    ['socket reset', Object.assign(new Error('x'), { code: 'ECONNRESET' })],
    ['timeout', Object.assign(new Error('x'), { code: 'ETIMEDOUT' })],
    ['sqlite busy', new Error('SQLITE_BUSY: database is locked')],
    ['network error', Object.assign(new Error('x'), { name: 'MongoNetworkError' })],
  ])('retries %s', (_label, err) => {
    expect(isTransientError(err)).toBe(true);
  });
});

describe('never retries what definitely happened', () => {
  it.each([
    ['duplicate key', Object.assign(new Error('E11000 duplicate key'), { code: 11000 })],
    ['validation', Object.assign(new Error('ValidationError: name required'), { statusCode: 400 })],
    ['permission', Object.assign(new Error('forbidden'), { statusCode: 403 })],
    ['not found', Object.assign(new Error('missing'), { statusCode: 404 })],
    ['conflict', Object.assign(new Error('version conflict'), { statusCode: 409 })],
    ['a plain error', new Error('boom')],
  ])('does not retry %s', (_label, err) => {
    expect(isTransientError(err)).toBe(false);
  });

  it('treats a 4xx as final even when its text looks transient', () => {
    // The status is a deterministic answer from the server; the wording is not.
    const err = Object.assign(new Error('ECONNRESET while validating'), { statusCode: 422 });
    expect(isTransientError(err)).toBe(false);
  });

  it('survives a hostile error object rather than deciding by accident', () => {
    const hostile = {
      hasErrorLabel() {
        throw new Error('nope');
      },
      message: 'duplicate key',
    };
    expect(isTransientError(hostile)).toBe(false);
  });

  it.each([[null], [undefined], ['a string'], [42]])('returns false for %p', (v) => {
    expect(isTransientError(v)).toBe(false);
  });
});

describe('the default is wired into withRetry', () => {
  it('does NOT re-run a deterministic failure', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        },
        { maxAttempts: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/duplicate key/);

    // The whole point: one attempt, not five. Under the old default this
    // re-ran the write four more times.
    expect(calls).toBe(1);
  });

  it('still retries a genuine transient failure', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('x'), { codeName: 'WriteConflict' });
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 1 },
    );

    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('lets a caller opt back into retrying everything, explicitly', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        { maxAttempts: 3, baseDelayMs: 1, shouldRetry: () => true },
      ),
    ).rejects.toThrow('boom');

    expect(calls).toBe(3);
  });
});
