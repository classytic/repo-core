/**
 * `retryingTransaction` — the transactional retry envelope.
 *
 * Pinned contract:
 *   1. A TRANSIENT conflict re-runs the whole callback, bounded by attempts.
 *   2. An unclassified error runs ONCE — `neverTransient` is the default,
 *      because re-running side effects on an unknown failure is the unsafe
 *      direction.
 *   3. Classification defaults to the repository's own
 *      `isTransientConflictError`; an explicit `isTransient` overrides it.
 *   4. No `withTransaction` → immediate throw, no attempt — degrading a
 *      requested transactional envelope silently IS the defect.
 *   5. Abort stops between attempts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  conservativeMongoIsTransientConflict,
  isVersionConflictError,
  VersionConflictError,
} from '../../../src/errors/index.js';
import { retryingTransaction, withRetry } from '../../../src/repository/index.js';
import type { StandardRepo } from '../../../src/repository/types.js';

/**
 * Minimal repo double: withTransaction runs the callback ONCE on itself — so
 * it declares `transactionRetry: 'caller'`, which is the honest declaration
 * for a single-attempt implementation and the one that puts the retry loop in
 * this envelope. A double that lied here would test the wrong composition.
 */
function repoDouble(over: Record<string, unknown> = {}) {
  const repo = {
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repo)),
    capabilities: { transactions: true, transactionRetry: 'caller' },
    ...over,
  } as unknown as StandardRepo<Record<string, unknown>> & {
    withTransaction: ReturnType<typeof vi.fn>;
  };
  return repo;
}

const transientErr = () =>
  Object.assign(new Error('write conflict'), { errorLabels: ['TransientTransactionError'] });

// Fast backoff so retry tests don't sleep for real.
const FAST = { baseDelayMs: 1, maxDelayMs: 2 } as const;

describe('retryingTransaction', () => {
  it('re-runs the callback on a transient conflict and returns the eventual result', async () => {
    const repo = repoDouble({ isTransientConflictError: conservativeMongoIsTransientConflict });
    let calls = 0;
    const result = await retryingTransaction(
      repo,
      async () => {
        calls++;
        if (calls < 3) throw transientErr();
        return 'committed';
      },
      FAST,
    );
    expect(result).toBe('committed');
    expect(calls).toBe(3);
  });

  it('an UNCLASSIFIED error runs once and surfaces — the safe default is no retry', async () => {
    const repo = repoDouble(); // no isTransientConflictError at all
    let calls = 0;
    await expect(
      retryingTransaction(
        repo,
        async () => {
          calls++;
          throw transientErr(); // looks transient, but nothing classifies it
        },
        FAST,
      ),
    ).rejects.toThrow('write conflict');
    expect(calls).toBe(1);
  });

  it('a deterministic failure is never retried even when a classifier exists', async () => {
    const repo = repoDouble({ isTransientConflictError: conservativeMongoIsTransientConflict });
    let calls = 0;
    await expect(
      retryingTransaction(
        repo,
        async () => {
          calls++;
          throw new Error('validation failed'); // not transient
        },
        FAST,
      ),
    ).rejects.toThrow('validation failed');
    expect(calls).toBe(1);
  });

  it('exhausted attempts rethrow the LAST conflict', async () => {
    const repo = repoDouble({ isTransientConflictError: conservativeMongoIsTransientConflict });
    let calls = 0;
    await expect(
      retryingTransaction(
        repo,
        async () => {
          calls++;
          throw transientErr();
        },
        { ...FAST, maxAttempts: 3 },
      ),
    ).rejects.toThrow('write conflict');
    expect(calls).toBe(3);
  });

  it('explicit isTransient overrides the repository classifier', async () => {
    const repoSaysNo = vi.fn(() => false);
    const repo = repoDouble({ isTransientConflictError: repoSaysNo });
    let calls = 0;
    const result = await retryingTransaction(
      repo,
      async () => {
        calls++;
        if (calls === 1) throw new Error('custom-conflict');
        return 'ok';
      },
      { ...FAST, isTransient: (err) => String(err).includes('custom-conflict') },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(repoSaysNo).not.toHaveBeenCalled();
  });

  it('REFUSES a repository without withTransaction — no silent degrade', async () => {
    const repo = { getById: async () => null } as unknown as StandardRepo<Record<string, never>>;
    await expect(retryingTransaction(repo, async () => 'x')).rejects.toThrow(
      /requires repository.withTransaction/,
    );
  });

  it('onRetry observes each conflict before the re-run', async () => {
    const repo = repoDouble({ isTransientConflictError: conservativeMongoIsTransientConflict });
    const seen: number[] = [];
    let calls = 0;
    await retryingTransaction(
      repo,
      async () => {
        calls++;
        if (calls < 3) throw transientErr();
        return 'ok';
      },
      { ...FAST, onRetry: (_err, attempt) => seen.push(attempt) },
    );
    expect(seen).toEqual([1, 2]);
  });

  it('abort between attempts stops the envelope with the abort reason', async () => {
    const repo = repoDouble({ isTransientConflictError: conservativeMongoIsTransientConflict });
    const ac = new AbortController();
    let calls = 0;
    const p = retryingTransaction(
      repo,
      async () => {
        calls++;
        ac.abort(new Error('caller gone'));
        throw transientErr();
      },
      { ...FAST, signal: ac.signal },
    );
    await expect(p).rejects.toThrow('caller gone');
    expect(calls).toBe(1);
  });

  it('abort CUTS the backoff sleep itself — a cancelled caller never waits out the delay', {
    timeout: 2_000,
  }, async () => {
    // Pinned at the withRetry unit, where the sleep lives, with NO jitter
    // and NO delay cap: the 60s backoff is far longer than the test
    // timeout, so only an ABORTABLE sleep can settle in time. A plain
    // setTimeout would hold the promise the full minute — exactly the
    // defect: a cancelled request silently waiting out its backoff.
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('caller gone')), 20);
    const p = withRetry(
      async () => {
        throw new Error('transient-ish');
      },
      { maxAttempts: 2, baseDelayMs: 60_000, shouldRetry: () => true },
      ac.signal,
    );
    await expect(p).rejects.toThrow('caller gone');
  });
});

describe('conflict taxonomy', () => {
  it('conservative Mongo classifier: labels and code 112 only, never message text', () => {
    expect(conservativeMongoIsTransientConflict(transientErr())).toBe(true);
    expect(conservativeMongoIsTransientConflict({ code: 112 })).toBe(true);
    expect(conservativeMongoIsTransientConflict({ codeName: 'WriteConflict' })).toBe(true);
    // Message-only lookalikes are NOT classified — no text sniffing.
    expect(conservativeMongoIsTransientConflict(new Error('WriteConflict'))).toBe(false);
    expect(conservativeMongoIsTransientConflict(null)).toBe(false);
    expect(conservativeMongoIsTransientConflict('WriteConflict')).toBe(false);
  });

  it('VersionConflictError carries the CAS facts and maps to 409', () => {
    const err = new VersionConflictError({ expectedVersion: 3, actualVersion: 5, id: 'doc-1' });
    expect(err.status).toBe(409);
    expect(err.code).toBe('version_conflict');
    expect(err.message).toContain('doc-1');
    expect(err.message).toContain('v3');
    expect(err.message).toContain('v5');
    expect(isVersionConflictError(err)).toBe(true);
  });

  it('isVersionConflictError survives a foreign copy of the class', () => {
    // Two repo-core copies in one graph: instanceof fails, the duck check must not.
    const foreign = Object.assign(new Error('Version conflict'), {
      name: 'VersionConflictError',
      code: 'version_conflict',
      expectedVersion: 1,
    });
    expect(isVersionConflictError(foreign)).toBe(true);
    expect(isVersionConflictError(new Error('nope'))).toBe(false);
  });

  it('a VERSION conflict is never classified transient — re-running would clobber', () => {
    const err = new VersionConflictError({ expectedVersion: 1 });
    expect(conservativeMongoIsTransientConflict(err)).toBe(false);
  });
});

/**
 * ONE retry authority.
 *
 * MongoDB's `session.withTransaction()` re-runs the callback internally on
 * TransientTransactionError for up to 120s. Wrapping it in this envelope
 * stacked two policies: the callback's execution count stopped being bounded
 * by maxAttempts, onRetry saw a fraction of real attempts, and every outer
 * attempt opened a NEW session. Retry ownership is declared, not assumed.
 */
describe('retry ownership — capabilities.transactionRetry', () => {
  /** A kit whose withTransaction retries INTERNALLY, like Mongo's driver. */
  function managedRepo(internalAttempts: number) {
    const repo = {
      capabilities: { transactions: true, transactionRetry: 'managed' },
      isTransientConflictError: conservativeMongoIsTransientConflict,
      withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        let lastErr: unknown;
        for (let i = 0; i < internalAttempts; i++) {
          try {
            return await fn(repo);
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr;
      }),
    } as unknown as StandardRepo<Record<string, unknown>> & {
      withTransaction: ReturnType<typeof vi.fn>;
    };
    return repo;
  }

  it("'managed' calls withTransaction EXACTLY once — no outer loop around a self-retrying kit", async () => {
    const repo = managedRepo(3);
    let calls = 0;
    const onRetry = vi.fn();

    await expect(
      retryingTransaction(
        repo,
        async () => {
          calls++;
          throw transientErr();
        },
        { ...FAST, onRetry },
      ),
    ).rejects.toThrow(/write conflict/);

    // The kit's own 3 attempts, and NOT 3 × 5 = 15.
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toBe(3);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("'managed' still returns the kit's successful retry — internal recovery is invisible", async () => {
    const repo = managedRepo(3);
    let calls = 0;
    const result = await retryingTransaction(repo, async () => {
      calls++;
      if (calls < 3) throw transientErr();
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
  });

  it('an UNDECLARED repository is treated as managed — silence must not add a retry layer', async () => {
    const repo = repoDouble({
      capabilities: { transactions: true }, // no transactionRetry
      isTransientConflictError: conservativeMongoIsTransientConflict,
    });
    let calls = 0;
    await expect(
      retryingTransaction(
        repo,
        async () => {
          calls++;
          throw transientErr();
        },
        FAST,
      ),
    ).rejects.toThrow(/write conflict/);
    expect(calls).toBe(1);
  });

  it('a repository with NO capabilities descriptor keeps working — custom repos are not locked out', async () => {
    const repo = repoDouble({ capabilities: undefined });
    const result = await retryingTransaction(repo, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('retryOwner overrides the declaration — the escape hatch for undeclarable doubles', async () => {
    const repo = repoDouble({
      capabilities: { transactions: true }, // undeclared → managed
      isTransientConflictError: conservativeMongoIsTransientConflict,
    });
    let calls = 0;
    await expect(
      retryingTransaction(
        repo,
        async () => {
          calls++;
          throw transientErr();
        },
        { ...FAST, retryOwner: 'caller', maxAttempts: 3 },
      ),
    ).rejects.toThrow(/write conflict/);
    expect(calls).toBe(3);
  });
});

describe('capability-aware transaction gate', () => {
  it('REFUSES a repository that exposes withTransaction but declares transactions: false', async () => {
    // The standalone-Mongo / D1 shape: the method always exists and fails at BEGIN.
    const repo = repoDouble({ capabilities: { transactions: false } });
    await expect(retryingTransaction(repo, async () => 'never')).rejects.toThrow(
      /declares `transactions: false`/,
    );
    expect(repo.withTransaction).not.toHaveBeenCalled();
  });

  it('REFUSES an unconfirmed topology — `unknown` reports transactions: false, failing closed', async () => {
    const repo = repoDouble({ capabilities: { transactions: undefined } });
    await expect(retryingTransaction(repo, async () => 'never')).rejects.toThrow(
      /cannot run transactions/,
    );
  });
});
