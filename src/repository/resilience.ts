/**
 * Resilience primitives — the single retry/abort contract every kit and
 * every chunked orchestrator (purge, batch imports, outbox relays) uses.
 *
 * One `RetryPolicy` shape across the contract: `QueryOptions.retryPolicy`,
 * `TenantPurgeOptions.retry`, and any kit-internal retry loop all accept
 * the same three knobs. One `withRetry` implementation so backoff math
 * never drifts between call sites.
 */

/**
 * Retry policy for transient failures (network blips, write conflicts,
 * busy-locks, connection resets).
 *
 * **Don't retry blindly.** Validation errors, schema errors, permission
 * errors are NOT transient — retrying just delays the same failure.
 * Mongo `WriteConflict`, SQLite `SQLITE_BUSY`, `ECONNRESET` ARE transient
 * — backoff + retry recovers. Pass `shouldRetry` to narrow when you know
 * your driver's error taxonomy:
 *
 * ```ts
 * retryPolicy: {
 *   maxAttempts: 3,         // default 3 when block present
 *   baseDelayMs: 100,       // exponential: 100ms, 200ms, 400ms
 *   shouldRetry: (err) =>
 *     /WriteConflict|SQLITE_BUSY|ECONNRESET/i.test(String(err)),
 * }
 * ```
 */
export interface RetryPolicy {
  /** Max attempts (including the first try). Default 3 when a policy is present. */
  maxAttempts?: number;
  /** Base delay (ms) for exponential backoff. Default 100ms; doubles each attempt. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff delay. Default: uncapped. */
  maxDelayMs?: number;
  /**
   * Full jitter: each delay is `random(0, computed)`. Default `false` for
   * back-compat. Turn it ON for any policy shared by concurrent writers —
   * synchronized deterministic backoff makes colliding transactions collide
   * again on every attempt.
   */
  jitter?: boolean;
  /**
   * Decide whether a given error is transient. Default: retry every error —
   * kept for back-compat, but UNSAFE as a shared default (it re-runs side
   * effects on deterministic failures); pass an explicit predicate.
   * `retryingTransaction` always does.
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/**
 * Abortable sleep. A plain `setTimeout` promise holds the process through an
 * abort — a cancelled request would silently wait out its full backoff before
 * noticing. Listener is removed on the timer path so repeated retries don't
 * accumulate listeners on one long-lived signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` with exponential backoff when a policy is provided. Falls
 * through to a single attempt when `policy` is undefined — callers wrap
 * unconditionally and the no-policy path costs nothing.
 *
 * Honors `signal`: aborts between attempts (never mid-attempt) by
 * rethrowing the signal's abort reason.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy | undefined,
  signal?: AbortSignal,
): Promise<T> {
  if (!policy) return fn();

  const maxAttempts = policy.maxAttempts ?? 3;
  const baseDelayMs = policy.baseDelayMs ?? 100;
  const shouldRetry = policy.shouldRetry ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) break;
      if (!shouldRetry(err, attempt + 1)) break;
      // Exponential backoff: baseDelayMs * 2^attempt, capped by maxDelayMs,
      // optionally full-jittered (random(0, computed)).
      let delay = baseDelayMs * 2 ** attempt;
      if (policy.maxDelayMs !== undefined) delay = Math.min(delay, policy.maxDelayMs);
      if (policy.jitter) delay = Math.random() * delay;
      await sleep(delay, signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Abort guard for op boundaries. Kits call this at the top of every
 * operation (and between chunks of chunked work) when the caller passed
 * `options.signal` — cancelled requests stop before the next driver
 * round-trip instead of running to completion.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
