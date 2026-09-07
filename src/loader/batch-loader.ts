/**
 * Collapse many per-item reads issued in one operation into ONE round trip.
 *
 * The read-side counterpart of `bulkWrite`: a loop that awaits a read per item
 * costs N round trips, and against a remote cluster the round trip IS the cost.
 * Hand the loader the keys and it issues a single batched call per tick.
 *
 * ## Scope: per OPERATION, never process-lived
 *
 * A loader caches, so its lifetime is a correctness property. Create one per
 * request / transaction / placement and let it die with that work. A loader
 * held on a repository instance serves a stale value forever, which is the
 * failure mode a plain memo already has — this primitive does not fix it, it
 * inherits it, so scope is the caller's job.
 *
 * ## The contract `batch` MUST honour
 *
 * `batch(keys)` returns results POSITIONALLY: `result[i]` belongs to `keys[i]`.
 * A length mismatch is refused rather than tolerated — silently zipping a short
 * array assigns one key's value to a different key, and every downstream check
 * still passes because the values are individually well-formed.
 *
 * @example
 * const products = createBatchLoader<string, Product>({
 *   batch: async (ids) => {
 *     const rows = await repo.getAll({ filters: { _id: { $in: [...ids] } } });
 *     const byId = new Map(rows.map((r) => [String(r._id), r]));
 *     return ids.map((id) => byId.get(id));   // positional, same length
 *   },
 * });
 * const [a, b] = await Promise.all([products.load('1'), products.load('2')]); // ONE query
 *
 * ## The trap: an awaited loop batches NOTHING
 *
 * The batch window is one microtask, so any `await` between two `load` calls
 * closes it:
 *
 *     for (const id of ids) await loader.load(id);   // N batches, not 1
 *
 * That returns correct data and no error — only `stats.batches` shows it. Use
 * `loadMany`, or issue the loads before awaiting them, and assert
 * `stats.batches` when the round-trip count is the point.
 */

/** Default cap on one batched call — keeps a generated `$in` bounded. */
export const DEFAULT_MAX_BATCH_SIZE = 500;

export interface BatchLoaderOptions<K, V> {
  /**
   * Load every key in one call. MUST return one entry per key, in the same
   * order. Use `undefined` for "no such key" — throwing rejects the whole batch.
   */
  batch: (keys: readonly K[]) => Promise<ReadonlyArray<V | undefined>>;
  /**
   * Cache identity for a key. Required when `K` is an object — the default
   * (`String(key)`) collapses every object to `[object Object]`, which would
   * merge unrelated keys into one entry.
   */
  keyOf?: (key: K) => string;
  /** Split larger requests into several calls. Defaults to {@link DEFAULT_MAX_BATCH_SIZE}. */
  maxBatchSize?: number;
  /**
   * Refuse a batch that resolved NOTHING for keys it was given.
   *
   * The length check catches a `.filter()`/`.slice()` mistake. It cannot catch
   * the commoner one: a `Map` keyed on `ObjectId` while the keys are strings,
   * or keyed on `_id` while the caller passes `skuRef`. That returns the right
   * LENGTH and all `undefined` — and `undefined` is this loader's documented
   * value for "no such key", so a total lookup failure is indistinguishable
   * from "these rows do not exist".
   *
   * Set `true` when every key is expected to resolve (a `$in` over ids you just
   * read). Leave it off for a genuine existence check.
   */
  requireAllResolved?: boolean;
}

export interface BatchLoader<K, V> {
  /** Queue one key; resolves when its batch settles. */
  load(key: K): Promise<V | undefined>;
  /** Queue many keys as one batch, positionally. */
  loadMany(keys: readonly K[]): Promise<Array<V | undefined>>;
  /** Seed a value the caller already holds, so it is never fetched. */
  prime(key: K, value: V | undefined): void;
  /** Drop one key, or the whole cache — use after a write invalidates a read. */
  clear(key?: K): void;
  /** Observability: how many batched calls this loader has made. */
  readonly stats: { batches: number; keys: number; cacheHits: number };
}

interface Pending<V> {
  resolve: (v: V | undefined) => void;
  reject: (e: unknown) => void;
}

export function createBatchLoader<K, V>(options: BatchLoaderOptions<K, V>): BatchLoader<K, V> {
  const { batch } = options;
  /**
   * REFUSES an object key rather than stringifying it. `String({})` is
   * `[object Object]` for every object, so the default would merge unrelated
   * keys into one entry and hand the first one's value to all of them — and
   * report the collisions as cache HITS, so the telemetry would say the loader
   * was working well while line 2 received line 1's row.
   */
  const keyOf =
    options.keyOf ??
    ((k: K): string => {
      if (k !== null && typeof k === 'object') {
        throw new TypeError(
          'batch loader: an object key needs an explicit `keyOf` — String(key) collides them all',
        );
      }
      return String(k);
    });
  const requested = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  // `Math.max(1, NaN)` is NaN, and a NaN stride makes the chunk loop run once
  // over an empty slice and abandon every waiter with no error. Same guard the
  // package already applies to this parameter in `repository/purge.ts`.
  if (!Number.isInteger(requested) || requested < 1) {
    throw new TypeError(
      `batch loader: maxBatchSize must be a positive integer, received ${String(requested)}`,
    );
  }
  const maxBatchSize = requested;

  /** Settled + in-flight results, keyed by cache identity. */
  const cache = new Map<string, Promise<V | undefined>>();
  /** Keys queued for the next tick, with everyone waiting on each. */
  let queue: Array<{ key: K; id: string; waiters: Pending<V>[] }> = [];
  let scheduled = false;
  const stats = { batches: 0, keys: 0, cacheHits: 0 };

  async function runBatch(entries: typeof queue): Promise<void> {
    const keys = entries.map((e) => e.key);
    stats.batches += 1;
    stats.keys += keys.length;
    try {
      const results = await batch(keys);
      if (results.length !== keys.length) {
        // Refuse rather than zip: a short array shifts every later value onto
        // the wrong key, and each value is individually valid, so nothing
        // downstream can notice.
        throw new Error(
          `batch loader: batch() returned ${results.length} results for ${keys.length} keys — ` +
            'results must be positional and the same length',
        );
      }
      if (options.requireAllResolved && keys.length > 0 && results.every((r) => r === undefined)) {
        // Every key missing is far likelier a key-identity mismatch than a
        // batch of rows that all genuinely vanished.
        throw new Error(
          `batch loader: batch() resolved NOTHING for ${keys.length} key(s) — ` +
            'likely a key-type mismatch between the keys and the lookup (ObjectId vs string, _id vs skuRef)',
        );
      }
      entries.forEach((entry, i) => {
        for (const w of entry.waiters) w.resolve(results[i]);
      });
    } catch (err) {
      for (const entry of entries) {
        // A failed read must not be cached — the next caller re-asks instead of
        // inheriting the failure.
        cache.delete(entry.id);
        for (const w of entry.waiters) w.reject(err);
      }
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    // A microtask, not a timer: the batch closes at the end of the current
    // synchronous run, so callers pay no added latency for the coalescing.
    queueMicrotask(() => {
      scheduled = false;
      const entries = queue;
      queue = [];
      if (entries.length === 0) return;
      for (let i = 0; i < entries.length; i += maxBatchSize) {
        void runBatch(entries.slice(i, i + maxBatchSize));
      }
    });
  }

  /**
   * No queue scan here. `load` writes the promise into `cache` synchronously,
   * so a repeated key in the same tick is served from there and never reaches
   * this function — a `queue.find` would be an unreachable O(n) per load, i.e.
   * quadratic on exactly the large batch this primitive exists for.
   */
  function enqueue(key: K, id: string): Promise<V | undefined> {
    const promise = new Promise<V | undefined>((resolve, reject) => {
      queue.push({ key, id, waiters: [{ resolve, reject }] });
    });
    schedule();
    return promise;
  }

  function load(key: K): Promise<V | undefined> {
    const id = keyOf(key);
    const hit = cache.get(id);
    if (hit) {
      stats.cacheHits += 1;
      return hit;
    }
    const promise = enqueue(key, id);
    cache.set(id, promise);
    return promise;
  }

  return {
    load,
    loadMany: (keys) => Promise.all(keys.map(load)),
    prime(key, value) {
      cache.set(keyOf(key), Promise.resolve(value));
    },
    /**
     * Cache only — an in-flight fetch is left to settle for the caller already
     * waiting on it. Dropping its queue entry would abandon that waiter
     * forever. A load issued after this gets its own entry, because `enqueue`
     * no longer joins by key (see the note there).
     */
    clear(key) {
      if (key === undefined) cache.clear();
      else cache.delete(keyOf(key));
    },
    stats,
  };
}
