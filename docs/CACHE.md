# Unified Cache Layer

One cache plugin, one shape, one engine — across `@classytic/mongokit`, `@classytic/sqlitekit`, `@classytic/arc`, and any Express / Nest / standalone host that ships `@classytic/repo-core` repositories.

```ts
import { cachePlugin } from '@classytic/repo-core/cache';
```

## Production guarantees

- **Single-flight on miss** — concurrent misses for the same key wait on the first claimer's promise. No cache stampede when N requests hit cold simultaneously. Modeled after TanStack Query's `QueryClient` in-flight map.
- **Per-scope version-bump** — writes only invalidate the writing tenant's cache. A write in `org:abc` doesn't blow away `org:xyz`'s reads. Targeted invalidation, TanStack-style.
- **Strictly-monotonic versions** — `max(Date.now(), previous + 1)` so same-millisecond writes never collide and leak stale entries.
- **TTL-bounded tag index** — index entries inherit their cached entries' TTLs (capped at 24h), bounding side-index growth on hot tags.
- **Cross-runtime SWR scheduling** — background refresh uses `setImmediate` on Node / Bun and `setTimeout(0)` on Cloudflare Workers / Deno Deploy / browser. Either way the callback runs after the user's response writes to the socket.
- **`error:<op>` rejects waiters fail-fast** — when the claimer's executor errors, all single-flight waiters fail with the same error (no hanging promises, no double-fetch).
- **Allowlist-per-op shape keys** — only fields that affect result shape participate in the cache key (per-op, host-extensible). New context fields don't silently slip into the key and explode miss rates.

## Runtime support

| Runtime | Status | SWR primitive |
|---|---|---|
| Node 22+ | ✅ first-class | `setImmediate` |
| Bun | ✅ first-class | `setImmediate` |
| Cloudflare Workers | ✅ supported | `setTimeout(0)` |
| Deno Deploy | ✅ supported | `setTimeout(0)` |
| Browser | ✅ supported (rare server-side use) | `setTimeout(0)` |

Single-flight is process-local — each isolate has its own in-flight map. Cross-pod coordination would need a distributed lock; not shipped, not on the roadmap (the in-process bound is much better than unbounded burst, and N-isolate worst case is acceptable for cold-start scenarios).

## Per-call options (TanStack Query-shaped)

The same shape applies to every read method — `getById`, `getAll`, `getOne`, `getByQuery`, `count`, `exists`, `distinct`, `aggregate`, `aggregatePaginate`. CRUD reads carry it on the `options` arg; aggregate carries it inside the `AggRequest` IR.

```ts
interface CacheOptions {
  staleTime?: number;     // seconds fresh — default 0 (always stale, SWR-only)
  gcTime?: number;        // seconds retained past stale — default 60
  swr?: boolean;          // serve-stale + bg refresh — default false
  tags?: readonly string[];
  bypass?: boolean;       // force fresh fetch + write (Refresh button)
  enabled?: boolean;      // skip cache entirely — default true
  key?: string;           // explicit key override
}
```

**Freshness model.**

| Age | `swr: false` (default) | `swr: true` |
|---|---|---|
| `< staleTime`               | serve cached | serve cached |
| `staleTime ≤ age < staleTime + gcTime` | refetch inline | serve cached + refresh in background |
| `≥ staleTime + gcTime`      | evicted; refetch | evicted; refetch |

## Wiring

```ts
import { Repository } from '@classytic/mongokit';
import { multiTenantPlugin, softDeletePlugin } from '@classytic/mongokit';
import { cachePlugin, createMemoryCacheAdapter } from '@classytic/repo-core/cache';

const repo = new Repository(UserModel, [
  multiTenantPlugin({ tenantField: 'organizationId' }),  // POLICY = 100
  softDeletePlugin(),                                     // POLICY = 100
  cachePlugin({                                           // CACHE  = 200
    adapter: createMemoryCacheAdapter(),                  // dev — use Redis in prod
    defaults: { staleTime: 30, gcTime: 300, swr: true },
    perOpDefaults: {
      getById: { staleTime: 600 },                        // long-lived per-doc cache
      aggregate: { staleTime: 30, swr: true },            // dashboards
    },
  }),
]);
```

`HOOK_PRIORITY.CACHE` (200) runs **after** `HOOK_PRIORITY.POLICY` (100) so multi-tenant + soft-delete filters land in the cache key — no cross-tenant cache poisoning.

## Per-call usage

```ts
// Fresh-on-default; opts in to long-lived cache.
await repo.getById(id, { cache: { staleTime: 600 } });

// SWR dashboard tile.
await repo.aggregate({
  measures: { revenue: { op: 'sum', field: 'amount' } },
  cache: { staleTime: 30, swr: true, tags: ['orders'] },
});

// Refresh button — overwrite cache with fresh data.
await repo.aggregate({ ..., cache: { ..., bypass: true } });

// Disable for one call.
await repo.getById(id, { cache: { enabled: false } });
```

## Invalidation

```ts
// Manual tag-based — clears every entry tagged with ANY of the tags.
await repo.cache?.invalidateByTags(['orders']);

// Auto on writes — `after:create` / `after:update` / `after:delete`
// hooks bump the model version (orphans every cached entry for the
// model in O(1)) AND invalidate the model-name tag (cross-aggregation
// invalidation). Hosts get this for free.
await repo.create({ name: 'Order #42' });
// ↳ all `orders` reads see fresh data on the next call.
```

## What auto-invalidates

The default `invalidating` ops list:

```
create, createMany, update, updateMany, findOneAndUpdate, upsert,
delete, deleteMany, restore, claim, claimVersion, increment, bulkWrite
```

Override via `cachePlugin({ invalidating: [...] })` if your kit has more / different write ops.

## Auto-injected scope tags

When `autoTagsFromScope: true` (default), the plugin extracts scope identifiers from `context.filter` (where multi-tenant has injected them) and tags every cache entry:

- `org:<organizationId>`
- `user:<userId>`

This means a single tag invalidation on `org:abc` clears everything that tenant cached, without the host having to declare those tags per-call.

## Adapter contract

```ts
interface CacheAdapter {
  get(key: string): Promise<unknown | undefined> | unknown | undefined;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  clear?(pattern?: string): Promise<void> | void;
}
```

`createMemoryCacheAdapter()` ships in repo-core for tests + single-process apps. For prod, plug in Redis / Upstash / Memcached / Cloudflare KV via a 4-method wrapper.

## Cross-host portability

The plugin is host-agnostic: a Fastify (arc), Express, NestJS, or standalone-script host all use the same plugin against the same repository. One Redis instance can serve all of them — keys are deterministic and namespace-prefixed.

## Cache-key shape

```
<prefix>:<op>:<model>:v<version>:<paramsHash>:<scopeHash>
```

- `prefix` — namespace (default `'rc'`)
- `op` — repository operation (`getById`, `aggregate`, ...)
- `model` — entity model name
- `version` — collection version (bumped on writes)
- `paramsHash` — fnv1a64 of stable-stringified call params (filter, id, sort, kit-specific options like `lean`)
- `scopeHash` — fnv1a64 of joined scope tags

Strict monotonicity on `version` — `max(Date.now(), previous + 1)` so same-millisecond writes never collide.

## Migration from kit-specific plugins

| Old | New |
|---|---|
| `cachePlugin({ adapter, ttlSeconds: 60 })` (mongokit/sqlitekit) | `cachePlugin({ adapter, defaults: { staleTime: 60 } })` |
| `cachePlugin({ ..., cacheableOps: [...] })` | `cachePlugin({ ..., enabled: [...] })` |
| `cachePlugin({ ..., invalidatingOps: [...] })` | `cachePlugin({ ..., invalidating: [...] })` |
| `cachePlugin({ ..., buildKey: fn })` | not overridable — canonical `buildCacheKey` is built-in |
| `getById(id, { skipCache: true })` | `getById(id, { cache: { enabled: false } })` |
| `new Repository(model, plugins, {}, { aggregateCache: adapter })` | install `cachePlugin({ adapter })` in plugins; aggregate auto-cached |
| `req.cache: { ttl: 60, staleWhileRevalidate: true }` | `req.cache: { staleTime: 60, swr: true }` |
| `repo.invalidateAggregateCache(['tag'])` | `repo.cache?.invalidateByTags(['tag'])` |

## Direct engine API

For hosts that need fine-grained control beyond the plugin (action results, custom routes, non-repo caching):

```ts
import { CacheEngine, createMemoryCacheAdapter } from '@classytic/repo-core/cache';

const engine = new CacheEngine(adapter, { prefix: 'app', jitter: 0.1 });
const result = await engine.get<MyShape>('custom-key', resolved);
if (result.status === 'miss') {
  const fresh = await fetchFromSomewhere();
  await engine.set('custom-key', fresh, resolved);
}
```

## Prefetch (cache warming)

Equivalent to TanStack Query's `queryClient.prefetchQuery` — populate the cache for a key before traffic lands. 100 concurrent calls for the same key dedupe to ONE fetcher invocation via single-flight.

```ts
import { CacheEngine, resolveCacheOptions } from '@classytic/repo-core/cache';

const opts = resolveCacheOptions({ staleTime: 30 }, undefined, undefined);

// Returns cached value on hit, runs fetcher + stores on miss
const data = await engine.prefetch('dashboard:revenue', opts, async () => {
  return await repo.aggregate({ measures: { sum: { op: 'sum', field: 'amount' } } });
});
```

## Adapter timeout (fail-fast on slow backends)

When Redis is partitioned or under heavy load, a cache `get` can block for the runtime's default network timeout (often minutes). `withTimeout` enforces an explicit deadline — slow ops fail-fast as cache misses (default) or thrown errors.

```ts
import { withTimeout, CacheTimeoutError } from '@classytic/repo-core/cache';

const redis = new RedisCacheAdapter(client);

// Default: slow ops behave as cache misses (kit serves uncached)
const fastFail = withTimeout(redis, { ms: 250 });

// Strict: timeouts propagate as CacheTimeoutError
const strict = withTimeout(redis, {
  ms: 250,
  onTimeout: 'throw',
  onSlow: (op, ms, key) => metrics.increment('cache.timeout', { op }),
});

cachePlugin({ adapter: fastFail });
```

## Atomic counters (multi-pod safe version-bumps)

Adapters that ship `increment(key, by, ttl)` get atomic version-bumps for free — concurrent writes across pods produce monotonically-increasing versions with zero coordination. The in-memory adapter implements it via JS's single-thread guarantee; Redis adapters use `INCRBY`. Adapters without `increment` (e.g. Cloudflare KV) fall back to `get → max → set` — correct single-pod, racy in rare multi-pod collisions.

## Atomic add-to-set (`O(M)` tag-index appends)

Adapters that ship `addToSet(key, members, ttl)` get `O(M)` per-call tag-index appends regardless of existing index size. Without it, `appendKeyToTags` falls back to `GET + array-copy + SET` which is `O(N²)` over many writes — measurable as a ~100× slowdown vs no-tag writes once a tag has thousands of entries.

- **Redis**: `SADD key m1 m2 ...` + `EXPIRE NX`
- **Memory**: stores `Set<string>` internally; `get` returns `Array.from(set)` for cross-adapter portability
- **DynamoDB**: `UpdateItem` with `ADD` on a String Set

## Performance baselines

Measured on Node 22.19 / Windows 11 with the in-memory adapter. Run `npm run bench` to reproduce. Numbers are ops/sec; lower latencies in `BENCHMARKS.md`.

| Operation | ops/sec | p99 |
|---|---|---|
| `engine.get` HIT (fresh) | ~2.0M | 0.0009ms |
| `engine.get` MISS | ~2.1M | 0.0009ms |
| `engine.set` no tags | ~1.4M | 0.0027ms |
| `engine.set` with 5 tags (atomic addToSet) | ~298k | 0.0074ms |
| `claimPending` + `resolvePending` | ~5.7M | 0.0009ms |
| `bumpModelVersion` (atomic increment) | ~1.5M | 0.0008ms |
| `invalidateByTags` (10 tags × 100 entries) | ~2.8k | 1.94ms |

The `engine.set` with tags is now within ~5× of the no-tags path (was ~350× before the atomic `addToSet` primitive). Single-flight + per-scope version are essentially free overhead.
