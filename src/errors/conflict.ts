/**
 * Concurrency-conflict taxonomy — driver-agnostic contract.
 *
 * Two DIFFERENT conflicts hide under "the write lost a race", and they demand
 * opposite responses:
 *
 * 1. **Transient transaction conflict** — the backend aborted a transaction
 *    because of concurrent access, and re-running the SAME work is the
 *    designed recovery. Retryable by definition.
 *
 *    | Backend    | Signal                                                     |
 *    |------------|------------------------------------------------------------|
 *    | MongoDB    | error label `TransientTransactionError` / code 112          |
 *    | Postgres   | `40001` serialization_failure / `40P01` deadlock_detected   |
 *    | SQLite     | `SQLITE_BUSY` / `SQLITE_LOCKED`                             |
 *    | Prisma     | `P2034` (transaction conflict)                              |
 *
 * 2. **Version conflict** — an optimistic-concurrency CAS (`ifVersion`) found
 *    the record changed since it was read. Re-running the same write would
 *    overwrite someone else's change, so it is NEVER auto-retried: the caller
 *    must re-read and re-decide (HTTP maps it to 409 + `If-Match` semantics).
 *
 * Classification of (1) belongs in the kit that knows its driver — same rule
 * as `IsDuplicateKeyErrorFn`. Repositories expose it as
 * `isTransientConflictError`; the shared `retryingTransaction` envelope
 * consumes the boolean. The default is `neverTransient`: retrying work whose
 * failure class is UNKNOWN is the unsafe direction (it re-runs side effects
 * on validation/permission failures), so silence means "don't".
 */

/** Predicate shape kits implement and repositories expose as `isTransientConflictError`. */
export type IsTransientConflictFn = (err: unknown) => boolean;

/**
 * Safe default: nothing is transient until the kit says so. The opposite
 * default (retry everything) turns a deterministic failure into N delayed
 * copies of itself — and re-runs side effects that already happened.
 */
export const neverTransient: IsTransientConflictFn = () => false;

/**
 * Conservative MongoDB FALLBACK — not mongokit's classifier, and not an
 * exception to the ownership rule above. Exactly the role (and placement) of
 * `conservativeMongoIsDuplicateKey`: a floor for a repository that exposes no
 * `isTransientConflictError` of its own, so back-compat with a kit predating
 * the predicate degrades to "the driver's own explicit signals" rather than
 * to `neverTransient`. Kits still own classification — mongokit's method
 * delegates here deliberately (there is nothing to add), and non-Mongo kits
 * MUST implement their own: this returns `false` for `SQLITE_BUSY`, `P2034`,
 * `40001`, and every other native signal.
 *
 * Matches ONLY the `TransientTransactionError` label the server attaches and
 * the bare WriteConflict code — never message text.
 */
export const conservativeMongoIsTransientConflict: IsTransientConflictFn = (err) => {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    codeName?: unknown;
    errorLabels?: unknown;
    hasErrorLabel?: (label: string) => boolean;
  };
  if (Array.isArray(e.errorLabels) && e.errorLabels.includes('TransientTransactionError')) {
    return true;
  }
  if (typeof e.hasErrorLabel === 'function' && e.hasErrorLabel('TransientTransactionError')) {
    return true;
  }
  return e.code === 112 || e.codeName === 'WriteConflict';
};

/**
 * Optimistic-concurrency violation: an `ifVersion` CAS write found a
 * different stored version than the caller read.
 *
 * A CLASS (not a factory) for the same reason primitives' outbox errors are
 * classes: consumers branch on `instanceof` across package boundaries, and a
 * version conflict must be distinguishable from not-found — a repository
 * signals "no such record" with `null`, and MUST NOT collapse a stale version
 * into it, or the caller retries a write that would clobber a concurrent one.
 */
export class VersionConflictError extends Error {
  readonly code = 'version_conflict' as const;
  /** HTTP mapping — 409 Conflict, pairs with ETag/`If-Match`. */
  readonly status = 409 as const;
  readonly expectedVersion: number;
  /** The stored version at CAS time, when the backend can report it cheaply. */
  readonly actualVersion?: number;
  readonly id?: string;

  constructor(opts: { expectedVersion: number; actualVersion?: number; id?: string }) {
    super(
      `Version conflict${opts.id ? ` on "${opts.id}"` : ''}: expected v${opts.expectedVersion}` +
        (opts.actualVersion !== undefined ? `, found v${opts.actualVersion}` : ''),
    );
    this.name = 'VersionConflictError';
    this.expectedVersion = opts.expectedVersion;
    if (opts.actualVersion !== undefined) this.actualVersion = opts.actualVersion;
    if (opts.id !== undefined) this.id = opts.id;
  }
}

/**
 * Duck-typed check that survives two repo-core copies in one dependency
 * graph, where `instanceof` silently fails across the boundary.
 */
export function isVersionConflictError(err: unknown): err is VersionConflictError {
  return (
    err instanceof VersionConflictError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'VersionConflictError' &&
      (err as { code?: unknown }).code === 'version_conflict')
  );
}
