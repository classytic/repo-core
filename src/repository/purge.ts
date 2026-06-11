/**
 * Chunked tenant-purge orchestrator — kit-agnostic.
 *
 * Owns the loop / signal / progress / retry / error envelope for
 * `StandardRepo.purgeByField`. Each kit (mongokit, sqlitekit, future
 * pgkit) plugs in a `PurgePort` that knows how to talk to its driver;
 * the orchestrator drives the chunked work.
 *
 * **Why a single-method port** (`purgeChunk(strategy, limit)`): each
 * driver has different round-trip optima — sqlite hard-strategy compiles
 * to one `DELETE … LIMIT` (no SELECT), mongo hard-strategy needs SELECT
 * + deleteMany, anonymize-with-function-form needs SELECT + bulkWrite
 * to batch heterogeneous patches in one round-trip. A two-method port
 * (`selectChunkIds` + `applyStrategy`) forces 2 round-trips for every
 * kit; the single method lets each port pick its own access shape.
 *
 * Hexagonal pattern: the orchestrator is the use-case; `PurgePort` is
 * the driving port; each kit's port factory is the adapter.
 */

import { withRetry } from './resilience.js';
import type { TenantPurgeOptions, TenantPurgeResult, TenantPurgeStrategy } from './types.js';

/**
 * Strategies that perform a write. `skip` is handled by the orchestrator
 * before the port is ever consulted, so ports only deal with the three
 * writing variants.
 */
export type WritingPurgeStrategy = Exclude<TenantPurgeStrategy, { type: 'skip' }>;

/**
 * Driver-facing port the orchestrator drives. Each kit implements one
 * closure over its driver primitives + the purge predicate.
 *
 * **Plugin-bypass invariant.** Implementations MUST bypass tenant
 * scoping in plugin hooks — the caller's `field = value` predicate IS
 * the authoritative scope; a tenant-injecting hook would narrow to the
 * wrong tenant. Pass `bypassTenant: true` on inner Repository calls
 * (which keeps audit / cache hooks active but disables tenant injection).
 *
 * **Throughput contract.** Implementations should issue the minimum
 * number of round-trips a chunk requires:
 *
 *   - `hard` on SQLite: `DELETE FROM t WHERE field = ? LIMIT n` — 1 RT
 *   - `hard` on Mongo: `find(filter, {_id:1}).limit(n)` + `deleteMany`
 *     — 2 RTs (Mongo has no DELETE LIMIT)
 *   - `soft`: read ids + updateMany with `$set: {deleted, deletedAt}` — 2 RTs
 *   - `anonymize` static fields: read ids + updateMany — 2 RTs
 *   - `anonymize` with function-form replacers: read docs +
 *     `bulkWrite([updateOne, …])` — 2 RTs (vs N+1 with per-doc fan-out)
 */
export interface PurgePort {
  /**
   * Process one chunk under the given strategy. Returns the row count
   * actually touched (≤ `limit`). The orchestrator loops until this
   * returns less than `limit` (natural exit) or the abort signal fires.
   *
   * Returning `0` signals "no more matching rows"; the orchestrator
   * exits. Returning a partial batch (`< limit`) is also a terminal
   * signal — saves one round-trip on the last chunk.
   */
  purgeChunk(strategy: WritingPurgeStrategy, limit: number): Promise<number>;
}

/**
 * Drive a chunked purge to completion. Returns a `TenantPurgeResult`
 * envelope describing what happened — never throws for in-strategy
 * errors (those wrap into `result.error`); only throws for invalid
 * input (`batchSize < 1`).
 *
 * @param strategy  Strategy declaration — `skip` short-circuits.
 * @param options   Chunking + signal + progress + optional retry.
 * @param port      Kit-specific driver glue (one `purgeChunk` method).
 */
export async function runChunkedPurge(
  strategy: TenantPurgeStrategy,
  options: TenantPurgeOptions,
  port: PurgePort,
): Promise<TenantPurgeResult> {
  const start = Date.now();

  // Declared no-op — surfaces the reason for audit, no port calls.
  if (strategy.type === 'skip') {
    return {
      strategy: 'skip',
      processed: 0,
      ok: true,
      durationMs: Date.now() - start,
      skipReason: strategy.reason,
    };
  }

  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('purgeByField: batchSize must be a positive integer');
  }

  const retry = options.retry;
  let processed = 0;

  try {
    while (true) {
      // Abort check between chunks — never mid-write. Committed chunks
      // stay committed (at-least-once cleanup semantics).
      if (options.signal?.aborted) {
        return {
          strategy: strategy.type,
          processed,
          ok: false,
          durationMs: Date.now() - start,
        };
      }

      // Signal flows into withRetry so an abort fired during retry
      // backoff stops before the next attempt — not just between chunks.
      const chunkSize = await withRetry(
        () => port.purgeChunk(strategy, batchSize),
        retry,
        options.signal,
      );
      if (chunkSize === 0) break;

      processed += chunkSize;

      if (options.onProgress) {
        await options.onProgress({
          processed,
          chunkSize,
          elapsedMs: Date.now() - start,
        });
      }

      // Natural exit — a non-full batch means the next pass would be
      // empty. Saves one round-trip.
      if (chunkSize < batchSize) break;
    }
  } catch (err) {
    return {
      strategy: strategy.type,
      processed,
      ok: false,
      durationMs: Date.now() - start,
      error: {
        message: err instanceof Error ? err.message : String(err),
        chunkOffset: processed,
      },
    };
  }

  return {
    strategy: strategy.type,
    processed,
    ok: true,
    durationMs: Date.now() - start,
  };
}
