/**
 * `retryingTransaction` — the transactional retry envelope.
 *
 * A transaction aborted by a TRANSIENT conflict (two writers touched the same
 * rows) is designed to be re-run; a transaction that failed for any other
 * reason is not. This envelope encodes that split once, so no call site
 * hand-rolls its own loop around `withTransaction`:
 *
 *   run tx → transient conflict? → rollback happened inside the kit →
 *   jittered backoff → re-run the WHOLE callback → bounded attempts.
 *
 * Safety contract for the callback — same as `withTransaction`, plus:
 * it may re-run in full, so it must be pure apart from writes through
 * `txRepo` (which roll back with the transaction). Side effects that must
 * not repeat belong in an outbox row written inside the transaction.
 *
 * Composition, not new machinery: attempts/backoff/jitter/abort ride the ONE
 * `withRetry` implementation, and classification rides the kit's
 * `isTransientConflictError` — this module contains no backoff math and no
 * driver knowledge, and never will.
 *
 * ## One retry authority, declared by the kit
 *
 * Some `withTransaction` implementations retry INTERNALLY — MongoDB's
 * convenient transaction API re-runs the callback on
 * `TransientTransactionError` / `UnknownTransactionCommitResult` for up to
 * 120 seconds. Wrapping one of those in this envelope stacks two policies:
 * the callback's execution count stops being bounded by `maxAttempts`,
 * `onRetry` reports a fraction of the real attempts, each outer attempt opens
 * a NEW session, and misplaced side effects inside a write verb repeat an
 * unpredictable number of times.
 *
 * So retry ownership is DECLARED, not assumed: `capabilities.transactionRetry`
 * is `'caller'` (this envelope loops) or `'managed'` (the kit already loops —
 * call it exactly once). Absent, `'managed'` is assumed; see the capability
 * doc for why that is the safe direction.
 */

import type { IsTransientConflictFn } from '../errors/conflict.js';
import { neverTransient } from '../errors/conflict.js';
import type { RepoCapabilities } from './capabilities.js';
import { withRetry } from './resilience.js';
import type { StandardRepo, TransactionHandle } from './types.js';

export interface RetryingTransactionOptions {
  /** Max attempts including the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff (ms); exponential, FULL-jittered. Default 50. */
  baseDelayMs?: number;
  /** Backoff ceiling (ms). Default 2000. */
  maxDelayMs?: number;
  /**
   * Conflict classifier. Default: the repository's own
   * `isTransientConflictError`, else `neverTransient` — an unclassified
   * error runs ONCE and surfaces, because re-running side effects on an
   * unknown failure is the unsafe direction.
   */
  isTransient?: IsTransientConflictFn;
  /**
   * Override the repository's declared `capabilities.transactionRetry`.
   *
   * Escape hatch for a repository that cannot declare (a hand-written test
   * double, a proxy that hides `capabilities`). Prefer fixing the
   * declaration — an override that disagrees with the kit re-creates the
   * double-retry this option exists to prevent.
   */
  retryOwner?: 'managed' | 'caller';
  /** Abort between attempts (never mid-transaction). */
  signal?: AbortSignal;
  /** Observability tap: called before each re-run with the conflict. */
  onRetry?: (err: unknown, attempt: number) => void;
  /** Forwarded to `withTransaction` untouched. */
  transactionOptions?: Record<string, unknown>;
}

/**
 * Run `fn` inside `repo.withTransaction`, re-running on transient conflicts.
 *
 * Throws immediately (no retry) when the repository cannot provide
 * transactions — a caller asking for transactional semantics on a backend
 * that cannot deliver them is a wiring error to surface at the call site,
 * not a mode to degrade through. Method presence alone is NOT the test: kits
 * expose `withTransaction` unconditionally and fail at BEGIN, so a
 * repository that publishes a capability descriptor is held to it
 * (`transactions !== true` — which `'unknown'` deliberately reports, failing
 * closed on an unconfirmed deployment).
 */
export async function retryingTransaction<TDoc, T>(
  repo: StandardRepo<TDoc>,
  fn: (txRepo: StandardRepo<TDoc>, uow?: TransactionHandle) => Promise<T>,
  options: RetryingTransactionOptions = {},
): Promise<T> {
  if (typeof repo.withTransaction !== 'function') {
    throw new Error(
      'retryingTransaction requires repository.withTransaction — this backend does not ' +
        'provide transactions (capability `transactions: false`). Wire a transactional ' +
        'kit, or drop the transactional envelope for this resource.',
    );
  }
  const capabilities = (repo as { capabilities?: Partial<RepoCapabilities> }).capabilities;
  if (capabilities && capabilities.transactions !== true) {
    throw new Error(
      'retryingTransaction: repository.withTransaction exists but the repository declares ' +
        `\`transactions: ${String(capabilities.transactions)}\` — this deployment cannot run ` +
        'transactions (standalone MongoDB, D1, or an unconfirmed topology). Every call would ' +
        'fail at BEGIN. Wire a transactional deployment, or drop the transactional envelope.',
    );
  }

  const isTransient =
    options.isTransient ??
    (typeof repo.isTransientConflictError === 'function'
      ? repo.isTransientConflictError.bind(repo)
      : neverTransient);

  // ONE retry authority. A kit that retries internally is called exactly
  // once; only a kit that declares `'caller'` gets this envelope's loop.
  const retryOwner = options.retryOwner ?? capabilities?.transactionRetry ?? 'managed';
  if (retryOwner === 'managed') {
    // biome-ignore lint/style/noNonNullAssertion: presence checked above
    return repo.withTransaction!<T>(fn, options.transactionOptions);
  }

  return withRetry(
    () =>
      // biome-ignore lint/style/noNonNullAssertion: presence checked above; TS loses it across the closure
      repo.withTransaction!<T>(fn, options.transactionOptions),
    {
      maxAttempts: options.maxAttempts ?? 5,
      baseDelayMs: options.baseDelayMs ?? 50,
      maxDelayMs: options.maxDelayMs ?? 2000,
      jitter: true,
      shouldRetry: (err, attempt) => {
        if (!isTransient(err)) return false;
        options.onRetry?.(err, attempt);
        return true;
      },
    },
    options.signal,
  );
}
