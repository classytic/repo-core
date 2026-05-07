/**
 * Distributed lock contract for the @classytic ecosystem.
 *
 * Coordinates exclusive access to a *named resource* across multiple
 * processes / replicas. The canonical use case: cron leader election.
 * Multi-pod deployments fire every scheduled tick on every replica;
 * without coordination the same sweep runs N times. A lock per cron
 * name lets exactly one replica win each cycle.
 *
 * Distinct from `leasePlugin` (mongokit / sqlitekit) — that one
 * leases existing **rows** (work-queue items) to workers. This
 * adapter leases **names** (no underlying row required), so it
 * doubles as singleton-flag, election-leader, and rate-limit
 * coordination primitive.
 *
 * ## Why this lives in repo-core
 *
 * The contract is driver-free: any K-V or row store with conditional
 * upsert can implement it. Mongokit ships a Mongo-backed adapter
 * (`@classytic/mongokit/lock`); sqlitekit ships a SQLite-backed one
 * (`@classytic/sqlitekit/lock`); future kits (pgkit, prismakit) wire
 * their own. Hosts pick the adapter that matches their primary store
 * and treat the lock as an implementation detail of "we already have
 * a database, use it for coordination too."
 *
 * ## Lease semantics
 *
 * `tryAcquire(name, holderId, leaseMs)` returns `true` when `holderId`
 * now holds the lock — either because it was free, the prior lease
 * expired, or the same holder is extending. `false` means another
 * holder owns an unexpired lease.
 *
 * `release(name, holderId)` releases the lock if held by this holder.
 * Returns `true` on actual release, `false` when the holder didn't
 * own it. Idempotent.
 *
 * Crashed leaders are reclaimed when their lease expires — adapters
 * MUST treat `expiresAt < now` as "free for the taking" inside the
 * atomic acquire path. Hosts size `leaseMs` based on cron interval
 * (typically 80–95%); too long delays failover, too short risks the
 * lease lapsing while the leader is still working.
 *
 * ## Sync-or-async
 *
 * Methods may return `Promise` or sync values; consumers `await`
 * either way. Memory adapter is sync; SQL/Mongo adapters are async.
 *
 * ## Why one file, not a barrel
 *
 * Types + the in-memory reference adapter + the instance-id helper
 * total under 200 LOC and have no internal seams worth a deep
 * subpath. A barrel would re-export from siblings (memory-adapter,
 * instance-id, types) and pull every sibling into the consumer
 * graph — `sideEffects: false` lets modern bundlers tree-shake, but
 * single-file is the cheaper guarantee.
 */

import { randomUUID } from 'node:crypto';

// ─── Contract ────────────────────────────────────────────────────────────

export interface LockAdapter {
  /**
   * Try to acquire (or extend) a named lock for `holderId`, valid
   * for `leaseMs` milliseconds.
   *
   * Same `holderId` calling twice extends the lease — idempotent.
   * Adapters MUST atomically check "free OR mine" and update in a
   * single round-trip; a read-then-write split is racy.
   */
  tryAcquire(name: string, holderId: string, leaseMs: number): Promise<boolean> | boolean;

  /**
   * Release the lock if held by `holderId`. Returns `true` on actual
   * release, `false` when the lock isn't held by this holder. Safe
   * to call without ever having acquired (returns `false`).
   */
  release(name: string, holderId: string): Promise<boolean> | boolean;

  /**
   * Optional: introspect a lock without trying to acquire it. Useful
   * for diagnostics ("which replica holds X?") and tests. Returns
   * `null` when the lock is free or expired.
   *
   * Not in the hot path — adapters that can't implement cheaply may
   * omit it. Consumers must check existence: `adapter.inspect?.(name)`.
   */
  inspect?(name: string): Promise<LockState | null> | LockState | null;
}

/** Snapshot of a lock's current holder. */
export interface LockState {
  /** The lock name (mirrored back for convenience). */
  name: string;
  /** Holder identifier. Free-form — typically `hostname.pid.uuid`. */
  holder: string;
  /** When the current lease expires. UTC. */
  expiresAt: Date;
  /** When the current holder first acquired (or last extended) the lock. */
  acquiredAt: Date;
}

/** Adapter-construction options that every backend shares. */
export interface BaseLockAdapterOptions {
  /**
   * Default lease length in milliseconds, applied when a caller passes
   * `leaseMs <= 0` to `tryAcquire`. Most callers pass an explicit
   * value sized to their cron interval; the default is a safety net.
   */
  defaultLeaseMs?: number;
}

// ─── Reference: in-memory adapter ────────────────────────────────────────

/**
 * Reference in-memory `LockAdapter` — single-process only.
 *
 * Useful for tests + single-pod deployments that want the same API
 * as the production adapter without setting up a database. NOT a
 * coordination primitive — there's no shared state across processes,
 * so two processes each construct their own `Map` and both think
 * they hold every lock. For real multi-replica safety use
 * `@classytic/mongokit/lock`, `@classytic/sqlitekit/lock`, or a
 * future kit-specific implementation.
 *
 * The atomic check-and-set inside `tryAcquire` is genuine — Node's
 * single-threaded event loop guarantees a synchronous read-then-write
 * is atomic relative to other JS, the same guarantee a real adapter
 * gets from its database's atomic upsert.
 */
export function createMemoryLockAdapter(options: BaseLockAdapterOptions = {}): LockAdapter {
  const { defaultLeaseMs = 30_000 } = options;
  const store = new Map<string, { holder: string; expiresAt: number; acquiredAt: number }>();

  function readLive(name: string, now: number) {
    const entry = store.get(name);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      store.delete(name);
      return undefined;
    }
    return entry;
  }

  return {
    tryAcquire(name, holderId, leaseMs) {
      const ms = leaseMs > 0 ? leaseMs : defaultLeaseMs;
      const now = Date.now();
      const live = readLive(name, now);
      if (live && live.holder !== holderId) return false;
      store.set(name, {
        holder: holderId,
        expiresAt: now + ms,
        // Preserve `acquiredAt` when the same holder extends the
        // lease. Matches Mongo / SQL adapters which keep the
        // original `acquiredAt` across extensions for diagnostics.
        acquiredAt: live ? live.acquiredAt : now,
      });
      return true;
    },

    release(name, holderId) {
      const live = readLive(name, Date.now());
      if (!live || live.holder !== holderId) return false;
      store.delete(name);
      return true;
    },

    inspect(name) {
      const live = readLive(name, Date.now());
      if (!live) return null;
      return {
        name,
        holder: live.holder,
        expiresAt: new Date(live.expiresAt),
        acquiredAt: new Date(live.acquiredAt),
      };
    },
  };
}

// ─── Instance id helper ──────────────────────────────────────────────────

/**
 * Process-wide instance id helper.
 *
 * Lock holders need a stable identifier per process that's unique
 * across replicas. The standard recipe is `hostname.pid.shortuuid`:
 *
 *   - `hostname`: distinguishes containers on the same host.
 *   - `pid`: distinguishes worker processes on the same container.
 *   - short uuid: distinguishes restarts on the same host with
 *     pid-reuse (rare but possible after fast crash-loop).
 *
 * Edge runtimes (Cloudflare Workers, Vercel Edge) lack `os.hostname()`
 * and `process.pid` — the helper falls back to a uuid-only id, which
 * is still unique per worker isolate.
 */

let cachedInstanceId: string | null = null;

/**
 * Returns a stable instance id for this process, generating it once
 * on first call and caching for the process lifetime. Idempotent.
 */
export function getInstanceId(): string {
  if (cachedInstanceId) return cachedInstanceId;
  cachedInstanceId = buildInstanceId();
  return cachedInstanceId;
}

function buildInstanceId(): string {
  const shortUuid = randomUUID().slice(0, 8);
  let hostname = 'unknown';
  let pid: string | number = 'edge';
  try {
    // `node:os` is dynamic so edge runtimes that polyfill `node:crypto`
    // but not `node:os` don't crash at module load. Falls through to
    // a uuid-only id which is still unique per isolate.
    // biome-ignore lint/suspicious/noExplicitAny: dynamic require for edge-compat
    const os = require('node:os') as { hostname(): string };
    hostname = os.hostname();
    pid = typeof process !== 'undefined' && process.pid ? process.pid : 'edge';
  } catch {
    // Edge runtime — keep the uuid-only fallback.
  }
  return `${hostname}.${pid}.${shortUuid}`;
}

/**
 * Test helper — overrides the cached id. Call between tests that
 * simulate multiple replicas in one process. Pass `null` to reset.
 */
export function setInstanceIdForTesting(id: string | null): void {
  cachedInstanceId = id;
}
