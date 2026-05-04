/**
 * Timeout-decorated `CacheAdapter` — wraps any adapter with a per-op
 * deadline so a slow Redis / partitioned network never blocks the
 * cache path indefinitely.
 *
 * **The failure mode it prevents.** When the cache adapter hangs
 * (network partition, Redis under load, slow KV cold-start), every
 * cache `get` blocks for the runtime's default network timeout —
 * sometimes minutes. The HTTP request behind the cache layer becomes
 * unresponsive. Wrapping the adapter with an explicit timeout makes
 * cache slowness fail-fast — the engine sees a `miss`-equivalent
 * (or error, depending on `onTimeout`) and the kit serves uncached.
 *
 * **Wrap once at adapter construction:**
 * ```ts
 * const redis = new RedisCacheAdapter(client);
 * const timed = withTimeout(redis, { ms: 250, onTimeout: 'miss' });
 * cachePlugin({ adapter: timed });
 * ```
 *
 * **`onTimeout` behavior:**
 *   - `'miss'`  (default) — `get` returns `undefined` (treated as a
 *     cache miss); `set` / `delete` / `clear` / `increment` swallow
 *     the timeout silently. The kit serves uncached and the data
 *     layer continues to work — slightly degraded performance
 *     (no caching) but available.
 *   - `'throw'` — every timeout throws a `CacheTimeoutError`. The
 *     repository operation propagates the error to the caller.
 *     Use when the host wants to surface cache slowness as a
 *     first-class signal (alerting, circuit-breaker integration).
 *
 * **Default 250ms.** A reasonable cache call should complete in
 * single-digit milliseconds even on a busy Redis. 250ms is the
 * "something is wrong" threshold — well under typical HTTP client
 * timeouts (30s+) so the kit recovers faster than the request fails.
 */

import type { CacheAdapter } from './types.js';

export class CacheTimeoutError extends Error {
  readonly op: string;
  readonly key?: string;
  readonly ms: number;
  constructor(op: string, ms: number, key?: string) {
    super(`Cache adapter timed out after ${ms}ms during ${op}${key ? ` for key "${key}"` : ''}`);
    this.name = 'CacheTimeoutError';
    this.op = op;
    this.ms = ms;
    if (key !== undefined) this.key = key;
  }
}

export interface TimeoutAdapterOptions {
  /** Per-operation deadline in milliseconds. Default: `250`. */
  ms?: number;
  /**
   * What to do when an operation exceeds `ms`:
   *   - `'miss'`  — `get` returns `undefined` (cache miss); writes
   *                 swallow the timeout. Default.
   *   - `'throw'` — throw `CacheTimeoutError` on every timeout.
   */
  onTimeout?: 'miss' | 'throw';
  /** Optional callback fired on every timeout (observability). */
  onSlow?: (op: string, ms: number, key?: string) => void;
}

/**
 * Wrap a `CacheAdapter` with per-op timeouts. The returned adapter
 * matches the original's contract (sync-or-async returns); ops that
 * complete before the deadline pass through unchanged.
 */
export function withTimeout(
  adapter: CacheAdapter,
  options: TimeoutAdapterOptions = {},
): CacheAdapter {
  const ms = options.ms ?? 250;
  const onTimeout = options.onTimeout ?? 'miss';
  const onSlow = options.onSlow;

  /** Race a possibly-async value against a timeout. */
  function withDeadline<T>(
    op: string,
    fallback: () => T,
    fn: () => Promise<T> | T,
    key?: string,
  ): Promise<T> | T {
    const result = fn();
    if (!(result instanceof Promise)) return result; // sync — no timeout needed
    return Promise.race([
      result,
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          onSlow?.(op, ms, key);
          if (onTimeout === 'throw') reject(new CacheTimeoutError(op, ms, key));
          else resolve(fallback());
        }, ms);
        // Clear the timer if the real op resolves first to avoid
        // leaking the handle past the racy resolution. Node's
        // `unref` keeps it from holding the event loop open.
        result.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
          (timer as { unref?: () => void }).unref?.();
        }
      }),
    ]);
  }

  return {
    get(key: string) {
      return withDeadline(
        'get',
        () => undefined,
        () => adapter.get(key),
        key,
      );
    },
    set(key: string, value: unknown, ttlSeconds?: number) {
      return withDeadline(
        'set',
        () => undefined,
        () => adapter.set(key, value, ttlSeconds),
        key,
      ) as Promise<void> | void;
    },
    delete(key: string) {
      return withDeadline(
        'delete',
        () => undefined,
        () => adapter.delete(key),
        key,
      ) as Promise<void> | void;
    },
    ...(adapter.clear
      ? {
          clear(pattern?: string) {
            const fn = adapter.clear;
            // biome-ignore lint/style/noNonNullAssertion: guarded by ?? above
            return withDeadline(
              'clear',
              () => undefined,
              () => fn!.call(adapter, pattern),
            ) as Promise<void> | void;
          },
        }
      : {}),
    ...(adapter.increment
      ? {
          increment(key: string, by?: number, ttlSeconds?: number) {
            const fn = adapter.increment;
            return withDeadline(
              'increment',
              // biome-ignore lint/style/noNonNullAssertion: guarded by ?? above
              () => 0, // fallback: 0 (no increment recorded)
              // biome-ignore lint/style/noNonNullAssertion: guarded by ?? above
              () => fn!.call(adapter, key, by, ttlSeconds),
              key,
            ) as Promise<number> | number;
          },
        }
      : {}),
  };
}
