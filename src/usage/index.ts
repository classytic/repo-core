/**
 * Usage-counter contract for the @classytic ecosystem.
 *
 * Period-bucketed counters per actor — the storage seam under
 * platform accounting (quotas, plan enforcement, usage-based
 * billing). One cell = `(actor, period, kind)`; one write op =
 * atomic increment; one read op = all counters for an actor-period.
 *
 * ## Why this lives in repo-core
 *
 * Same reasoning as `./lock`: the contract is driver-free — any
 * store with an atomic increment-upsert implements it (Mongo `$inc`
 * upsert, SQL `ON CONFLICT ... DO UPDATE SET n = n + ?`, Redis
 * `HINCRBY`). Kits ship their adapters (`@classytic/mongokit/usage`,
 * `@classytic/sqlitekit/usage`, ...) WITHOUT depending on arc;
 * `@classytic/arc/usage`'s `usagePlugin` consumes the contract
 * structurally (its local `UsageStore` mirrors this shape the same
 * way its `ScheduleLockLike` mirrors `LockAdapter`) so arc's
 * repo-core peer floor never bumps for it.
 *
 * Distinct from itemized event/usage RECORD stores (e.g.
 * `@classytic/arc-ai/usage`'s per-run records): this contract holds
 * AGGREGATES only. Itemized layers sink into it; they don't replace it.
 *
 * ## Semantics
 *
 * - `increment` MUST be atomic per bucket (concurrent writers never
 *   lose counts) and MUST treat a missing bucket as `0`.
 * - `summary` returns `{}` (never throws) for unknown actors/periods.
 * - `period` keys are opaque strings to the store; `usagePeriod()`
 *   is the ecosystem's canonical key (UTC calendar month, `2026-07`).
 *   Stores wanting finer windows shard internally without changing
 *   the contract.
 * - Sync-or-async: memory adapter is sync; DB adapters async;
 *   consumers `await` either way.
 *
 * ## Why one file, not a barrel
 *
 * Contract + reference memory adapter + the period helper are under
 * 100 LOC with no internal seams — same single-file rule as `./lock`.
 */

// ─── Contract ────────────────────────────────────────────────────────────

/** One counter cell: (actor, period, kind). */
export interface UsageBucket {
  /** Who consumed — org / user / client id, or a host-chosen fallback key. */
  actor: string;
  /** Aggregation period key — canonically `usagePeriod()`'s `YYYY-MM`. */
  period: string;
  /** Namespaced counter, dot-separated: `api.requests`, `ai.tokens.input`, `storage.egress.bytes`. */
  kind: string;
}

/** Period-bucketed usage counters. See module header for semantics. */
export interface UsageStore {
  /** Store name for diagnostics (e.g. 'memory', 'mongo', 'redis'). */
  readonly name: string;
  /** Atomically add `amount` to the bucket's counter, creating it at 0. */
  increment(bucket: UsageBucket, amount: number): Promise<void> | void;
  /** Every counter for an actor in a period: `{ 'api.requests': 40231, ... }`. */
  summary(actor: string, period: string): Promise<Record<string, number>>;
  /** Optional cleanup hook (connections, timers). */
  close?(): Promise<void>;
}

/**
 * Canonical period key for a date — calendar month, UTC: `2026-07`.
 * Monthly is the billing-native granularity.
 */
export function usagePeriod(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ─── Reference adapter (tests / single-process) ─────────────────────────

/**
 * In-memory reference implementation — tests and single-instance
 * apps. Counters are per-process; multi-replica deployments need a
 * shared adapter (kit- or Redis-backed).
 */
export function createMemoryUsageStore(): UsageStore & { clear(): void } {
  /** actor → period → kind → count */
  const counters = new Map<string, Map<string, Map<string, number>>>();
  return {
    name: 'memory',
    increment(bucket, amount) {
      const periods = counters.get(bucket.actor) ?? new Map<string, Map<string, number>>();
      const kinds = periods.get(bucket.period) ?? new Map<string, number>();
      kinds.set(bucket.kind, (kinds.get(bucket.kind) ?? 0) + amount);
      periods.set(bucket.period, kinds);
      counters.set(bucket.actor, periods);
    },
    async summary(actor, period) {
      const kinds = counters.get(actor)?.get(period);
      return kinds ? Object.fromEntries(kinds) : {};
    },
    clear() {
      counters.clear();
    },
  };
}
