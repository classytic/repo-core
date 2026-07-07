/**
 * Chunked archive orchestrator — kit-agnostic cold-storage extraction.
 *
 * Owns the loop / ordering / signal / progress / retry / error envelope for
 * `StandardRepo.archiveByFilter`. Each kit plugs in an `ArchivePort` that
 * knows how to read and delete chunks against its driver; the HOST plugs in
 * an `ArchiveSink` that knows where cold rows go (archive table/collection,
 * S3/JSONL, warehouse loader, ...). The orchestrator drives the chunked
 * move so every kit inherits identical semantics.
 *
 * **Ordering invariant (the whole point): write-before-delete.** A chunk is
 * deleted from the hot store only AFTER the sink acknowledged the write. A
 * crash between the two re-reads and re-writes the same chunk on the next
 * run — data is never lost, at the cost of possible duplicates in the sink.
 * Sinks MUST therefore be idempotent or duplicate-tolerant (upsert by id,
 * or dedup downstream). This is the industry-standard at-least-once shape;
 * exactly-once would require a distributed transaction across two stores.
 *
 * **Throughput contract.** Ports should read chunks in a STABLE order
 * (primary-key ascending) so progression is deterministic, and delete by
 * primary keys collected from the read — one read + one delete round-trip
 * per chunk. Because archived rows leave the hot store, re-evaluating the
 * same filter naturally advances; no offset, no cursor state to persist.
 *
 * **Sizing guidance.** `batchSize` defaults to 1000 — the same
 * lock-contention / oplog / replication-lag ceiling as `runChunkedPurge`.
 * Raise it for narrow rows on quiet systems; lower it when rows are wide
 * (documents with large blobs) or the sink is a rate-limited API.
 *
 * Hexagonal pattern: the orchestrator is the use-case; `ArchivePort` is the
 * driving port; each kit's port factory is the adapter; the sink is the
 * host's outbound adapter.
 */

import type { RetryPolicy } from './resilience.js';
import { withRetry } from './resilience.js';

/**
 * Destination for archived documents — implemented by the HOST, not the
 * kit. One method so anything writable fits: an archive collection/table,
 * an object-store JSONL writer, a warehouse ingestion API.
 *
 * **Idempotency requirement.** `write` MAY receive the same chunk more
 * than once (crash between write and delete, or a chunk-level retry).
 * Implementations must tolerate duplicates: upsert by primary key when the
 * destination is a table/collection; dedup on load when it's a file/queue.
 */
export interface ArchiveSink<TDoc = unknown> {
  /**
   * Persist one chunk. Throwing aborts the run BEFORE the chunk is
   * deleted from the hot store — the failed chunk stays hot, nothing is
   * lost. Retries (when configured) wrap this call.
   */
  write(docs: readonly TDoc[]): Promise<void>;
  /**
   * Optional finalize hook — called once after the run completes without
   * error (flush buffers, close multipart uploads, commit manifests).
   * NOT called on abort/error; partial sink output must already be safe
   * by construction (see idempotency requirement).
   */
  flush?(): Promise<void>;
}

/**
 * Driver-facing port the orchestrator drives. Each kit implements one
 * closure over its driver primitives + the archive predicate.
 *
 * **Plugin-bypass invariant.** Like `PurgePort`, implementations MUST
 * bypass tenant-scope injection on inner reads/deletes — the caller's
 * filter IS the authoritative predicate.
 */
export interface ArchivePort<TDoc = unknown> {
  /**
   * Read the next chunk of matching rows in a stable order (primary-key
   * ascending), at most `limit`. Returning `[]` signals "no more matching
   * rows"; a partial chunk (`< limit`) is also terminal after processing.
   */
  readChunk(limit: number): Promise<readonly TDoc[]>;
  /**
   * Remove the given (already-sunk) docs from the hot store. Returns the
   * count actually deleted — may be `< docs.length` when a concurrent
   * writer already removed some; the orchestrator reports what the port
   * returns.
   */
  deleteChunk(docs: readonly TDoc[]): Promise<number>;
}

/** Per-call options for `archiveByFilter`. Mirrors `TenantPurgeOptions`. */
export interface ArchiveOptions {
  /** Rows per chunk. Default 1000. */
  batchSize?: number;
  /** Per-chunk progress callback. `processed` is cumulative deleted count. */
  onProgress?: (event: ArchiveProgress) => void | Promise<void>;
  /**
   * Abort signal. Checked between chunks — never mid-chunk. Chunks already
   * written + deleted stay archived (at-least-once semantics).
   */
  signal?: AbortSignal;
  /**
   * Retry transient failures at the STEP level (read, sink write, delete
   * each retry independently). Default: no retry — first error aborts.
   */
  retry?: RetryPolicy;
}

/** Chunk-level progress event. */
export interface ArchiveProgress {
  /** Rows fully archived so far (written to sink AND deleted). */
  processed: number;
  /** Rows in the chunk that just completed. */
  chunkSize: number;
  /** Wall-clock ms elapsed since the call started. */
  elapsedMs: number;
}

/** Final result of an `archiveByFilter` invocation. */
export interface ArchiveResult {
  /** Rows fully archived (sunk + removed from the hot store). */
  processed: number;
  /** True iff the run completed without abort / error. */
  ok: boolean;
  /** Wall-clock ms. */
  durationMs: number;
  /**
   * First error if `ok: false`. `phase` says which step failed — a
   * `'sink'` failure guarantees the hot store still holds the chunk.
   */
  error?: { message: string; phase: 'read' | 'sink' | 'delete'; processed: number };
}

/**
 * Drive a chunked archive to completion. Returns an `ArchiveResult`
 * envelope — never throws for in-run errors (those wrap into
 * `result.error`); only throws for invalid input (`batchSize < 1`).
 *
 * @param options Chunking + signal + progress + optional retry.
 * @param sink    Host-provided destination (idempotent writes).
 * @param port    Kit-specific driver glue (readChunk / deleteChunk).
 */
export async function runChunkedArchive<TDoc = unknown>(
  options: ArchiveOptions,
  sink: ArchiveSink<TDoc>,
  port: ArchivePort<TDoc>,
): Promise<ArchiveResult> {
  const start = Date.now();

  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('archiveByFilter: batchSize must be a positive integer');
  }

  const retry = options.retry;
  let processed = 0;
  let phase: 'read' | 'sink' | 'delete' = 'read';

  try {
    while (true) {
      // Abort check between chunks — never mid-chunk.
      if (options.signal?.aborted) {
        return { processed, ok: false, durationMs: Date.now() - start };
      }

      phase = 'read';
      const docs = await withRetry(() => port.readChunk(batchSize), retry, options.signal);
      if (docs.length === 0) break;

      // Write-before-delete: the sink must acknowledge before the hot
      // store loses the rows. A sink failure leaves the chunk hot.
      phase = 'sink';
      await withRetry(() => sink.write(docs), retry, options.signal);

      phase = 'delete';
      const deleted = await withRetry(() => port.deleteChunk(docs), retry, options.signal);

      processed += deleted;

      if (options.onProgress) {
        await options.onProgress({
          processed,
          chunkSize: deleted,
          elapsedMs: Date.now() - start,
        });
      }

      // Natural exit — a non-full read means the next pass would be empty.
      if (docs.length < batchSize) break;
    }

    if (sink.flush) {
      phase = 'sink';
      await withRetry(() => sink.flush?.() ?? Promise.resolve(), retry, options.signal);
    }
  } catch (err) {
    return {
      processed,
      ok: false,
      durationMs: Date.now() - start,
      error: {
        message: err instanceof Error ? err.message : String(err),
        phase,
        processed,
      },
    };
  }

  return { processed, ok: true, durationMs: Date.now() - start };
}
