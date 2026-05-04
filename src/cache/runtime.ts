/**
 * Cross-runtime scheduling primitives.
 *
 * The cache layer targets every JS runtime kits + arc + Express/Nest
 * hosts run on — Node, Bun, Deno Deploy, Cloudflare Workers, edge
 * functions. Most Web-style APIs (`Map`, `Promise`, `setTimeout`,
 * `BigInt`, `queueMicrotask`) are available across all of them, but
 * `setImmediate` is Node-specific — Workers / Deno / browsers throw a
 * `ReferenceError` if you call it.
 *
 * `scheduleBackground` resolves the right primitive at module load and
 * exposes a single API the rest of the cache layer uses.
 *
 * **Semantics:**
 *
 * | Runtime     | Mechanism            | When the callback fires             |
 * | ----------- | -------------------- | ----------------------------------- |
 * | Node / Bun  | `setImmediate(fn)`   | After current I/O phase             |
 * | Workers     | `setTimeout(fn, 0)`  | After current task (min 0ms)        |
 * | Deno Deploy | `setTimeout(fn, 0)`  | After current task                  |
 * | Browser     | `setTimeout(fn, 0)`  | After current task (clamped 4ms)    |
 *
 * Every runtime guarantees the callback runs AFTER the current sync
 * block + any pending microtasks of the current task — which is the
 * actual contract callers rely on (don't run the bg work synchronously
 * in the response path).
 *
 * **Why not `queueMicrotask`?** Microtasks flush BEFORE the current
 * I/O phase completes. For SWR, that means the bg refresh's first
 * `await` could delay the user's HTTP response write. `setImmediate`
 * (or `setTimeout(0)` on edge runtimes) defers past the I/O phase.
 */

/** Detect once at load time — branchless on the hot path. */
const hasSetImmediate = typeof globalThis.setImmediate === 'function';

/**
 * Schedule a fire-and-forget callback to run after the current task.
 *
 * Used by SWR background refresh + (potentially) any future hook that
 * wants "run after response" semantics. Caller is responsible for
 * error handling — this helper does NOT add a default `.catch`.
 */
export const scheduleBackground: (fn: () => void) => void = hasSetImmediate
  ? (fn) => {
      // setImmediate's return type varies (Node `NodeJS.Immediate`,
      // Bun `Timer`); we don't track the handle since callers are
      // fire-and-forget. Cast to discard.
      (globalThis.setImmediate as (cb: () => void) => unknown)(fn);
    }
  : (fn) => {
      setTimeout(fn, 0);
    };
