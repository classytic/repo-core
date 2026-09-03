/**
 * Public entry for the `loader` subpath.
 *
 * Read-side batching: the counterpart of mongokit's `bulkWrite` / `createMany`.
 * A per-item read in a loop costs one round trip per item, and against a remote
 * cluster that IS the cost — `createBatchLoader` coalesces the keys issued in
 * one tick into a single call.
 *
 * Create one per operation. See `batch-loader.ts` for why the lifetime is the
 * caller's responsibility and what `batch()` must guarantee.
 */

export {
  type BatchLoader,
  type BatchLoaderOptions,
  createBatchLoader,
  DEFAULT_MAX_BATCH_SIZE,
} from './batch-loader.js';
