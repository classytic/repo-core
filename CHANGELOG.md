# Changelog

All notable changes to `@classytic/repo-core` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-05-17

### Added — compliance-grade tenant cleanup primitive

Cross-kit foundation for "what happens to this data on org-delete?" —
GDPR right-to-be-forgotten, SOC 2 deletion timelines, HIPAA / PCI
retention rules. Every kit (mongokit, sqlitekit, future pgkit) gets
the same surface; arc's `cascadeDeleteForOrganization` runner composes
on top.

- **`StandardRepo.purgeByField?(field, value, strategy, options)`** — new optional method. Processes every row matching `field = value` under a declared strategy, chunked under the hood. Optional because not every store needs the surface; arc's cascade runner checks for the method at boot.
- **`TenantPurgeStrategy`** discriminated union — four variants:
  - `{ type: 'hard' }` — permanent removal (GDPR right-to-be-forgotten).
  - `{ type: 'soft', deletedField?, deletedAtField? }` — recoverable; pairs with TTL indexes for eventual hard-purge.
  - `{ type: 'anonymize', fields }` — retain rows but overwrite declared fields (HIPAA / PCI / SOX-compatible).
  - `{ type: 'skip', reason }` — explicit opt-out with **mandatory** `reason` (compliance forcing function — silent skips are leaks).
- **`TenantPurgeOptions`** — `batchSize`, `session`, `onProgress`, `signal`. Chunking is mandatory (10M-row tenants can't run as a single `deleteMany`); abort signal is checked between chunks (never mid-write); aborted runs return `ok: false` with cumulative `processed` count (at-least-once cleanup semantics).
- **`TenantPurgeResult`** + **`TenantPurgeProgress`** — typed result envelope + per-chunk progress event.

### Added — kit-agnostic orchestrator (`runChunkedPurge`)

The chunk-loop logic — abort handling, progress emission, error-wrapping into result envelope, natural-exit on non-full batch — is identical across kits. Extracting it here means a single bug fix lands for every kit, and the surface a new kit has to implement shrinks to ~80 lines.

- **`runChunkedPurge(strategy, options, port)`** — pure orchestrator (130 lines, no I/O).
- **`PurgePort`** interface — the driving port. Each kit implements two closures: `selectChunkIds(limit)` + `applyStrategy(ids, strategy)`.
- **`WritingPurgeStrategy`** — strategy union with `skip` excluded (orchestrator handles `skip` before the port is consulted, so ports only see `hard` / `soft` / `anonymize`).

Hexagonal pattern: orchestrator is the use-case, `PurgePort` is the driving port, each kit's port factory is the adapter. Adding a new strategy (e.g. `archive`) = one union member + one case per port. Adding a new kit = one port file + ~10-line method.

### Added — 8 cross-kit conformance scenarios

In `src/testing/conformance.ts`, gated by the new `ConformanceFeatures.purgeByField?: boolean` flag. When both mongokit and sqlitekit pass the same scenarios, cross-kit byte-stability for tenant cleanup is provable:

1. `hard` removes every matching row, leaves others intact
2. `hard` empty match → `processed: 0`, `ok: true`
3. `anonymize` overwrites declared fields, keeps the row
4. `skip` is a no-op, returns reason
5. Chunking: `batchSize` honored, `onProgress` fires per chunk
6. Idempotent: re-running on the same tenant is a no-op
7. Scoping: only matching rows affected (cross-tenant safety)
8. Abort signal: stops between chunks, returns partial count + `ok: false`

The `soft` strategy is intentionally NOT in the conformance suite — it requires writable `deleted` / `deletedAt` fields not present on the shared `ConformanceDoc`; each kit covers `soft` in its own integration tests.

### Migration notes

- **Existing kits:** the new method is optional — kits don't break. mongokit 3.14.0 and sqlitekit 0.4.0 ship implementations; older kit versions continue to work, they just can't honor a `purgeByField` call.
- **Existing hosts:** no breaking changes. Hosts using arc's `cascadeDeleteForOrganization` automatically pick up the new strategy surface once arc 2.16.0 lands.
- **Build sync (workspace dev):** kits need `cp -r dist/* ../mongokit/node_modules/@classytic/repo-core/dist/` etc. after a workspace bump until npm publish.

## [0.4.0] - 2026-05-04

### Added — kit-shared building blocks (consolidation)

- **`@classytic/repo-core/aggregate`** (new subpath) — kit-neutral aggregate IR helpers that every backend's compiler consumes identically: `normalizeGroupBy`, `validateMeasures`, `encodeAggCursor`, `decodeAggCursor`, `isKeysetMode`, `DecodedCursor`. mongokit + sqlitekit shipped byte-identical copies of these for the prior several releases; promoting them here keeps the IR contract honest. The driver-specific predicate builders (`buildKeysetPredicate` in mongokit, `buildKeysetHaving` in sqlitekit) stay kit-local.
- **`@classytic/repo-core/plugins`** (new subpath) — kit-neutral plugin building blocks. Currently exports `payloadHasTenantField` (handles all 5 policy keys: data, dataArray, query, filters, operations) and `adminBypass` (skipWhen-compatible role-bypass factory). Both kits now consume these instead of shipping their own copies. Sqlitekit gains `adminBypass` for free as a side effect.

### ⚠️ BREAKING — `cache/deferred.ts` removed (use `Promise.withResolvers()`)

- **`createDeferred()` and `Deferred<T>` no longer exported from `@classytic/repo-core/cache`.** Both were thin wrappers around `Promise.withResolvers()`, which Node 22+ ships natively (the package's platform floor). The cache engine's single-flight map now uses the native primitive directly with zero indirection.
- **Migration:** if you imported them, replace `import { createDeferred } from '@classytic/repo-core/cache'` with `Promise.withResolvers<T>()`. Same shape (`{ promise, resolve, reject }`); behavior is identical.

### Fixed — security & robustness hardening

- **DoS surface in URL parser**: `parseUrl` now drops parameter keys longer than 256 chars before bracket-regex parsing. Without the cap, a hostile 1MB key forced repeated full-string regex scans. Legitimate URL params don't approach the bound. (`src/query-parser/parse-url.ts`)
- **Cursor payload type validation**: `decodeCursor` now type-checks every payload field, not just presence. A corrupted token shaped `{ v: { evil: true } }` previously slipped past the `'v' in p` guard and produced opaque errors downstream. (`src/pagination/cursor.ts`)
- **Regex compile-per-doc on in-memory filter**: `matchFilter`'s `like` and `regex` cases now use a bounded LRU cache (256 entries) keyed by `(pattern, flags)`. Prior implementation compiled a fresh `RegExp` on every call — measurable cost when `asPredicate(filter)` runs over 100k docs. (`src/filter/match.ts`)

### Cache hash upgrade (djb2 → FNV-1a 64-bit)

- **`buildCacheKey` now uses FNV-1a 64-bit** (was djb2 32-bit). At multi-tenant fleet scale (10k tenants × dozens of cached aggregations each), djb2's 32-bit space hit ~50% birthday-paradox collision around 65k distinct keys. FNV-1a 64-bit pushes that threshold to ~4B keys. Same call site, same key shape, same regex-compatible base-36 output.
- **Operational note for deployment:** existing Redis entries hash differently after the swap, so cold cache for one TTL cycle post-deploy. The collection-version orphan path already handles this for write-driven invalidation.

### Cache layer — atomic counters, parallel invalidation, prefetch, timeout

- **`CacheAdapter.increment(key, by, ttl)`** — optional atomic counter primitive. When the adapter ships it (Redis `INCRBY`, in-memory `Map`, future driver-native impls), `bumpModelVersion` produces strictly-monotonic versions across concurrent multi-pod writes — no lost bumps. Adapters without `increment` (Cloudflare KV, etc.) fall back to `get → max → set`; correct in single-pod, accepts a tiny race window in multi-pod (mitigated by `Date.now()` floor).
- **Parallelized `invalidateByTags`** — fan-out reads + fan-out deletes via `Promise.all`. For Redis-backed adapters with pipelining, 5 tags × 100 keys completes in ~2 RTTs instead of 510. ~10× speedup on hot tags.
- **`CacheEngine.prefetch(key, opts, fetcher)`** — TanStack-equivalent cache warming. Single-flight semantics: 100 concurrent prefetches for the same key run the fetcher exactly once. Returns cached on hit, fetches + stores on miss, dedupes via the engine's pending map.
- **`withTimeout(adapter, { ms, onTimeout, onSlow })`** — adapter decorator that fail-fasts on slow backends. `onTimeout: 'miss'` (default) makes slow gets behave as cache misses (kit serves uncached); `'throw'` propagates `CacheTimeoutError`. `onSlow` callback for observability.
- **`scheduleBackground`** is now a public export from `@classytic/repo-core/cache` — hosts can use the same cross-runtime primitive for their own post-response work.

### Cache layer — production hardening (TanStack-aligned) + cross-runtime

Six gaps in the v1 unified cache layer fixed before any prod traffic:

1. **Single-flight on miss** — `CacheEngine.claimPending()` / `getPending()` / `resolvePending()` / `rejectPending()`. Concurrent misses for the same key wait on the first claimer's promise instead of running N redundant fetches. Cache-stampede prevention; TanStack `QueryClient`-equivalent.
2. **Per-scope version-bump** — `bumpModelVersion(model, scopeKey?)` and `getModelVersion(model, scopeKey?)`. Writes inside `org:abc` no longer invalidate `org:xyz`'s cached reads. Targeted invalidation; matches TanStack's "exact match" semantics.
3. **Cross-runtime SWR scheduling** — new `runtime.ts` exposes `scheduleBackground` that picks `setImmediate` on Node / Bun and `setTimeout(0)` on Cloudflare Workers / Deno Deploy / browser. Either way the callback fires after the current sync block + microtask queue, ensuring the user's response writes to the socket BEFORE the bg fetch's first await. (Old impl used `setImmediate` directly — `ReferenceError` on edge runtimes.)
4. **TTL-bounded tag index** — index entries inherit their cached entries' TTLs (capped at 24h). Old impl used `ttlSeconds: 0` ("never expire" in Redis); side-index grew unboundedly on hot tags.
5. **`error:<op>` rejects pending** — when the claimer's executor errors, the plugin's `error:<op>` hook rejects the deferred so single-flight waiters fail-fast. No hanging promises, no double-fetch on transient backend failures.
6. **Allowlist-per-op shape keys** — `DEFAULT_SHAPE_KEYS_BY_OP` maps each read op to the fields that actually affect result shape. Only those fields participate in the cache key. Replaces the prior denylist (which would silently include any new context field a kit added — exploding miss rates if e.g. `requestId` slipped through). Hosts can override per-op via `cachePlugin({ shapeKeysByOp })`.

### Code organization

The unified plugin (`@classytic/repo-core/cache`) is now split into focused modules:

```
cache/
  plugin/
    index.ts                  # cachePlugin factory + types + handle (~200 LOC)
    context.ts                # typed context slots + extraction + shape-keys (~170 LOC)
    read-hooks.ts             # before/after/error for read ops (~180 LOC)
    invalidation-hooks.ts     # after for write ops (~60 LOC)
    swr.ts                    # background-refresh scheduler (~50 LOC)
  engine.ts                   # TTL + SWR + tag + version + single-flight (~220 LOC)
  runtime.ts                  # cross-runtime scheduleBackground (~50 LOC)
  ...
```

Each module has one purpose. Replaces the prior 564-LOC `plugin.ts` mega-file.

### Added — `Deferred<T>` utility

`createDeferred<T>()` exported from `@classytic/repo-core/cache` — a Promise plus its `resolve`/`reject` handles, externalized. Same primitive `Promise.withResolvers()` provides natively in Node 22+; we ship our own to keep the contract explicit and support older runtimes.

### Added — Unified cache layer (`@classytic/repo-core/cache`)

One `cachePlugin({ adapter })` for every kit + arc + Express/Nest hosts. Replaces three independent SWR/TTL/tag implementations (mongokit's CRUD `cachePlugin` + aggregate `withAggCache`, sqlitekit's local `cachePlugin`, arc's `QueryCache`) with one canonical hook integration.

#### Public surface (`@classytic/repo-core/cache`)

```ts
import {
  cachePlugin,                  // hook integration — plugs into RepositoryBase
  CacheEngine,                   // direct SWR + TTL + tag flow over a CacheAdapter
  buildEnvelope, inspectEnvelope, type CacheEnvelope,
  buildCacheKey, extractScopeTags, type BuildKeyInput,
  appendKeyToTags, invalidateByTags as invalidateByTagsImpl,
  bumpModelVersion, getModelVersion,
  resolveCacheOptions, type CacheOptions, type ResolvedCacheOptions, type CacheReadResult,
  // already shipped:
  type CacheAdapter, createMemoryCacheAdapter, stableStringify,
} from '@classytic/repo-core/cache';
```

#### TanStack Query-shaped per-call options

Same shape across CRUD + aggregate, kit-agnostic:

```ts
{
  staleTime?: number;     // seconds fresh
  gcTime?: number;        // seconds retained past stale (default 60)
  swr?: boolean;          // serve-stale + bg refresh
  tags?: readonly string[];
  bypass?: boolean;
  enabled?: boolean;
  key?: string;           // explicit override
}
```

#### What the plugin does

1. Subscribes to `before:<op>` / `after:<op>` for every read op (`getById`, `getAll`, `getOne`, `getByQuery`, `count`, `exists`, `distinct`, `aggregate`, `aggregatePaginate`) — configurable via `enabled: [...]`.
2. Subscribes to `after:<op>` for every mutating op (`create`, `update`, `delete`, `claim`, ...) — configurable via `invalidating: [...]`. Bumps the model's version (orphans every cached read in O(1)) AND invalidates the model-tag (cross-aggregation invalidation).
3. Auto-injects scope tags (`org:<id>`, `user:<id>`) from `context.filter` so cross-tenant cache poisoning is structurally impossible.
4. Hooks register at `HOOK_PRIORITY.CACHE` (200) — multi-tenant + soft-delete (POLICY = 100) run first so their filter mutations land in the cache key.
5. Attaches `repo.cache` handle exposing `invalidateByTags(tags)`, `bumpModelVersion(model)`, `clear()`.

#### Strictly-monotonic version bumps

`bumpModelVersion` uses `max(Date.now(), previous + 1)` so same-millisecond writes (cache prime + write hit at the same ms) don't collide, fixing a real correctness gap the prior `Date.now()`-only impl had.

#### `AggCacheOptions` is now an alias for `CacheOptions`

Same shape across CRUD + aggregate. Old field names (`ttl`, `staleWhileRevalidate`) removed — migrate to `staleTime`, `swr`. Ecosystem packages (mongokit, sqlitekit, arc) all consume the unified type.

#### Removed

- `/aggregate-cache` subpath — superseded by the unified `/cache` plugin (which handles aggregate ops natively via the `before:aggregate` hook).

#### Migration (kit + host)

```ts
// Before — kit-specific cache plugins + constructor option
new Repository(model, [cachePlugin({ adapter, ttlSeconds: 60 })], {}, {
  aggregateCache: adapter,  // separate constructor option
});
repo.aggregate({ measures, cache: { ttl: 60, staleWhileRevalidate: true } });

// After — one plugin, one shape
new Repository(model, [
  multiTenantPlugin({ tenantField: 'orgId' }),
  cachePlugin({ adapter, defaults: { staleTime: 60, gcTime: 300, swr: true } }),
]);
repo.aggregate({ measures, cache: { staleTime: 60, swr: true, tags: ['orders'] } });
repo.getAll(filter, { cache: { staleTime: 30 } });
await repo.cache?.invalidateByTags(['orders']);
```

### Added — `StandardRepo.claim()` and `claimVersion()` (atomic CAS, REQUIRED on the contract)

Standardizes the canonical state-machine write that every domain package was hand-rolling on top of `findOneAndUpdate`:

```ts
const claimed = await repo.claim?.(runId, { from: 'waiting', to: 'running' }, {
  lastHeartbeat: new Date(),
  workerId: 'worker-12',
});
if (!claimed) return; // someone else got it
```

**Cross-kit portable.** Mongokit compiles to `findOneAndUpdate({ _id, status: from }, { $set: { status: to, ...patch } })`. SQL kits compile to `UPDATE x SET ... WHERE id = ? AND status = <from> RETURNING *`. Prismakit compiles to `prisma.x.updateMany({ where: { id, status: from }, data: ... })` followed by a `findUnique` when `count > 0`. Same input, same null-on-race semantics across every backend.

**Pairs with `@classytic/primitives/state-machine`** — different layers:
- `defineStateMachine()` answers "is `from → to` legal in the model?" (compile-time table + early throw)
- `claim()` answers "did we win the transition vs concurrent writers?" (runtime null on race)

The state field defaults to `'status'` (matches the convention across `streamline`, `@classytic/order`, `revenue`, `invoice`); pass `{ field: 'phase', from, to }` for state machines keyed off a different column.

#### New types exported from `@classytic/repo-core/repository`

- `ClaimTransition` — `{ field?, from, to, where? }` argument shape for `claim` (`where` is the compound-CAS predicate slot — see below).
- `ClaimVersionTransition` — `{ field?, from: number | undefined, by?, where? }` argument shape for `claimVersion`. `from === undefined` is admitted for first-write CAS (matches docs whose version field is null OR missing).

#### Added to `StandardRepo<TDoc>` — REQUIRED methods (not optional)

```ts
claim(
  id: string,
  transition: ClaimTransition,
  patch?: Partial<TDoc>,
  options?: WriteOptions,
): Promise<TDoc | null>;

claimVersion(
  id: string,
  transition: ClaimVersionTransition,
  update: Record<string, unknown>,
  options?: WriteOptions,
): Promise<TDoc | null>;
```

**Required, not optional.** During pre-release dev iterations, `claim?` was optional as scaffolding while kits implemented. Both mongokit and sqlitekit ship them as concrete class primitives, and downstream domain packages (~10 in the classytic codebase) carry FSM verbs depending on them — none gracefully degrade. Required-on-the-contract removes the `if (repo.claim) { ... }` boilerplate at every call site and surfaces missing implementations at the conformance gate instead of at runtime.

#### `ClaimTransition.where` — compound-CAS predicate

Real-world audit (streamline, commission, yard, revenue, order, invoice): the bare `{ [idField]: id, [field]: from }` filter shape fits ~5% of atomic-claim sites in production. The other 95% carry compound predicates — paused guards, retry-time guards, heartbeat-staleness, sub-document `$elemMatch`, `$or` for missing-or-stale fields. Without a way to express those, `claim()` covered the textbook example but couldn't replace the hand-rolled CAS calls in production.

`ClaimTransition.where` AND-merges arbitrary predicates alongside the canonical id + state-field match:

```ts
const claimed = await repo.claim?.(runId, {
  from: 'waiting',
  to: 'running',
  where: {
    paused: { $ne: true },
    'scheduling.retryAfter': { $lte: new Date() },
  },
}, { lastHeartbeat: new Date() });
```

Cross-kit notes:
- Mongokit: ANDed into the `findOneAndUpdate` filter.
- SQL kits: ANDed into the `WHERE` clause (raw column literals accepted; portable Filter IR is compiled).
- Prismakit: merged as additional keys on the `where` object.

Null-on-race semantics unchanged — if no doc matches the full compound filter (state OR any `where` predicate), `claim` returns `null`. The caller can't distinguish "lost race" from "guard predicate failed"; both mean "don't proceed."

Driven by streamline's audit (1 of 21 sites fit the bare shape; 21 of 21 fit the compound shape). Same pattern across the other audited packages.

#### `ClaimTransition.from` widened to `unknown | readonly unknown[]` — multi-source CAS

Single-value `from` covers the textbook one-source transition (`waiting → running`). Real-world state machines also need to claim from one of multiple source states — commission's `voidRecord` / `markClawedBack` / `endAgreement` / `_transition` (4 sites), media-kit's `pending|processing → error` catch-block. `from` now accepts an array; kit compilers emit `[stateField] IN (...)` (SQL) or `[stateField]: { $in: [...] }` (mongo).

```ts
// "From any non-terminal state to voided"
await repo.claim?.(id, { from: ['pending', 'approved', 'sent'], to: 'voided' });
```

Single-value `from` is unchanged (back-compatible). Array form is opt-in — pass an array to enable.

**`from === to` is allowed** — the documented idempotent re-claim semantic. Yard's `reviseDeparture` writes `departed → departed` to atomically refresh the row's payload while asserting it hasn't moved on. The CAS still returns `null` if the row left the source state, so race-loss semantics hold.

#### Migration

Pre-0.4.0 callers wrote:

```ts
const claimed = await repo.findOneAndUpdate(
  { _id: id, status: 'waiting' },
  { $set: { status: 'running', lastHeartbeat: new Date() }, },
);
```

Post-0.4.0:

```ts
const claimed = await repo.claim?.(id, { from: 'waiting', to: 'running' }, { lastHeartbeat: new Date() });
```

The old form keeps working — `claim()` is an additive optional method, not a rename.

## [0.3.0] - 2026-04-29

### Added — Aggregate pagination shapes

- `AggregatePaginationResultCore<TDoc>` and `AggregatePaginationResult<TDoc, TExtra>` join `Offset*` / `Keyset*` as the third pagination shape every kit reports. Mirrors offset (page / total / pages / hasNext / hasPrev) with `method: 'aggregate'` discriminant. Mongokit's existing local `AggregatePaginationResult` (3.10.x) becomes redundant — to be deleted in mongokit 4.0.
- `AnyPaginationResult<TDoc, TExtra>` — union over the three result shapes. Use as the input type to anything that converts repo results into HTTP envelopes.

### Added — HTTP wire envelopes

The repository result shapes (`OffsetPaginationResult`, etc.) carry the `method` discriminant, so the corresponding HTTP wire envelope is just `{ success: true } & Result`. Adding the literal here closes the **server/client envelope mismatch** — arc's HTTP server was emitting flattened paginated responses without the `method` field while arc-next's typed responses required it.

- `OffsetPaginationResponse<TDoc, TExtra>` = `{ success: true } & OffsetPaginationResult<TDoc, TExtra>`
- `KeysetPaginationResponse<TDoc, TExtra>` = same for keyset
- `AggregatePaginationResponse<TDoc, TExtra>` = same for aggregate
- `BareListResponse<TDoc>` = `{ success: true; docs: TDoc[] }` for endpoints that don't paginate
- `PaginatedResponse<TDoc, TExtra>` = union over all four. The discriminated-union contract is `success: true` literal first, `method` second — typed clients (arc-next, SDKs) narrow with `if (res.success && 'method' in res && res.method === 'offset')`.

### Added — `toCanonicalList()` runtime normalizer

```ts
import { toCanonicalList } from '@classytic/repo-core/pagination';

const result = await userRepo.getAll(query);
reply.send(toCanonicalList(result));   // → PaginatedResponse<User>

reply.send(toCanonicalList([u1, u2])); // → BareListResponse<User>
```

The single point where an internal `Result` becomes an external `Response`. Three overloads route bare arrays / paginated results to the right wire shape; `TExtra` fields (mongokit's `warning?: string`, etc.) flow through.

**Subtle behavior**: `success: true` is stamped *after* the spread, so a stale `success: false` accidentally present on the input cannot override the literal — paginated success path is always `success: true`. Tested.

### Added — `isPaginatedResult()` type guard

Branches on the `method` discriminant rather than `Array.isArray`, so an empty paginated result still routes through the paginated branch. Used internally by `toCanonicalList`; exported for consumers writing custom envelope logic.

### Test delta

230 → 303 tests across 0.3.0. New coverage includes `tests/unit/pagination/canonical.test.ts` and the type-level coverage extensions in `result-types.test.ts` (35 tests landed with the aggregate / wire-envelope / `toCanonicalList` work), plus `tests/unit/repository/base-plugin-validation.test.ts` (6 tests for the `assertValidPlugin` guard).

### Added — `SchemaGenerator<TModel>` interface in `/schema`

Canonical contract for repository kits' CRUD-schema generators. Mongokit's `buildCrudSchemasFromModel` and sqlitekit's `buildCrudSchemasFromTable` (and any future kit's equivalent) `satisfies SchemaGenerator<TKitModel>` at the call site, so arc's `MongooseAdapter.schemaGenerator` / `DrizzleAdapter.schemaGenerator` accept them by structural typing — no glue, no inheritance, no inline function signatures duplicated in every adapter.

- `SchemaGenerator<TModel = unknown>` — `(model, options?, context?) => CrudSchemas | Record<string, unknown>`.
- `SchemaGeneratorContext` — resource-level context threaded at boot (`idField`, `resourceName`).
- `isSchemaGenerator(value)` — runtime predicate (arity 1-3 functions). Conservative — doesn't invoke.

Each kit ships a compile-time conformance check (same playbook as mongokit's `RepositoryLike` conformance gate):

```ts
const _conformance: SchemaGenerator<Model<unknown>> = buildCrudSchemasFromModel;
```

Drift surfaces in the kit's typecheck immediately, before any consumer sees it.

10 new tests in `tests/unit/schema/generator.test.ts`. Total repo-core: 293 → 303.

### Added — `errors` module: canonical wire + throwable error contract

`@classytic/repo-core/errors` is now the single source of truth for error contracts across the org. Two complementary shapes:

- **`HttpError extends Error`** — the *throwable* shape. Plain `Error` with `status`, optional `code`, `meta`, `validationErrors`, `duplicate`. Kits classify their driver-specific errors into this shape; framework layers (arc) catch and serialize. Existing `HttpError` extended in 0.3 with `code?: string` and `meta?: Record<string, unknown>` (mongokit had these locally pre-3.12).
- **`ErrorContract`** — the *wire* shape (RFC 7807 / Stripe-style). What gets serialized to JSON responses, dead-letter records, audit trails, inter-service envelopes. Flat top-level `code` / `message` / `status` matches the org-wide `{ success, ... }` envelope convention.
- **`ErrorDetail`** — single field-scoped error (path / code / message). `ErrorContract.details` is `ReadonlyArray<ErrorDetail>`.
- **`ERROR_CODES` + `ErrorCode`** — canonical lowercase + snake_case codes (`'validation_error'`, `'not_found'`, `'conflict'`, `'unauthorized'`, `'forbidden'`, `'rate_limited'`, `'idempotency_conflict'`, `'precondition_failed'`, `'internal_error'`, `'service_unavailable'`, `'timeout'`). Domain packages extend hierarchically (`'order.validation.missing_line'`).
- **`toErrorContract(error)`** — converts any `Error` / `HttpError` / non-`Error` value to the canonical wire `ErrorContract`. `code` cascade: explicit `error.code` → status-derived → `'internal_error'`. Flattens mongokit-shaped `validationErrors` and `duplicate.fields` into the canonical `details[]` array.
- **`statusToErrorCode(status)`** — well-known HTTP status → canonical code. Conservative mapping; unknown statuses fall through to `'internal_error'` so domain handlers explicitly opt in.

Consumed by mongokit (drops local `HttpError`), arc (`ArcError implements HttpError` with `status` getter), and any future kit / service. Relocated from `@classytic/primitives/errors` (which had `ErrorContract` + `ERROR_CODES` but not the throwable contract) — same playbook as the pagination, tenant, and events relocations: errors are infrastructure-shaped, not domain primitives.

14 new tests in `tests/unit/errors/contract.test.ts`. Total repo-core: 279 → 293.

### Added — `tenant` subpath (canonical home for tenant scope contract)

New subpath `@classytic/repo-core/tenant` ships:
- `TenantConfig` — static config (`strategy`, `enabled`, `tenantField`, `fieldType`, `ref`, `contextKey`, `required`, `resolve`).
- `TenantStrategy = 'field' | 'none' | 'custom'`, `TenantFieldType = 'objectId' | 'string'`.
- `ResolvedTenantConfig` — the resolved-with-defaults shape returned by `resolveTenantConfig`.
- `DEFAULT_TENANT_CONFIG` — sensible org-wide defaults (`tenantField: 'organizationId'`, `fieldType: 'objectId'`, `ref: 'organization'`, `required: true`).
- `resolveTenantConfig(config?)` — normaliser; validates `'custom'` strategy requires `resolve`.

Relocated from `@classytic/primitives/tenant` (which has been removed in primitives 0.3 cleanup). Tenant scope is **infrastructure-shaped** — describes how queries get scoped, not a domain primitive like Money or Address. Repo-core is its proper home: it sits next to `context`, `filter`, `hooks`, `schema`, `cache` — every other repository contract — and lets mongokit / sqlitekit / future kits consume it through the existing `@classytic/repo-core` peer dep without pulling primitives just for one type.

**Custom tenancy escape hatch** unchanged: `strategy: 'custom'` + `resolve: (ctx) => filterShape` covers multi-field composites, region+partner shards, hash-derived filters, anything that doesn't fit `field === id`.

14 new tests in `tests/unit/tenant/resolve.test.ts` (ported from primitives' suite). Total repo-core: 265 → 279 tests.

### Added — schema-builder vocabulary

- **`SchemaBuilderOptions.excludeFields`** — global field exclusion. Fields listed here are dropped from create / update / response schemas in one place. Equivalent to setting `create.omitFields`, `update.omitFields`, AND `response.omitFields` to the same list. Use for fields that should never appear in any HTTP-facing schema.
- **`SchemaBuilderOptions.response`** with `omitFields?: string[]` — response-schema overrides. Drops extra fields from the response shape without marking them globally hidden.
- **`CrudSchemas.response?: JsonSchema`** — optional response-shape schema. Includes server-set fields (`createdAt`, `updatedAt`, `_id`, immutable / readonly / systemManaged) since those ARE returned to clients. Only `fieldRules[field].hidden: true` strips automatically. Set `additionalProperties: true` so virtuals / computed fields pass through.
- **`FieldRule.hidden?: boolean`** — strips the field from the response shape. Distinct from `systemManaged` (request-body concern). Use for passwords, secrets, internal scoring.
- **`collectFieldsToOmit(options, 'response')`** — third purpose alongside `'create'` / `'update'`. Implements the response policy (only `hidden` + `excludeFields` + `response.omitFields`).

These are the contracts mongokit 3.12 implements, arc 2.12's MongooseAdapter consumes, and any future kit (sqlitekit, prismakit) inherits for free.

### Hardened — `RepositoryBase` plugin-shape validation

`RepositoryBase.use()` and the constructor's plugin loop now reject malformed plugin entries up front via `assertValidPlugin()`. The motivating field bug: `new Repository(Model, ['organizationId'], opts)` — passing a tenant-field string array where the constructor expected `plugins[]` — used to crash deep in the call site with `TypeError: plugin.apply is not a function`, cascade-failing every test that booted the app. The validator now throws a single descriptive `TypeError` at construction with the offending index and a hint about the common `tenantField`-in-the-wrong-slot mistake:

```
[repo-core] Repository "Foo": plugin at index 0 has wrong type.
Expected a function or { name, apply(repo) } object — got string 'organizationId'.
Common cause: `new Repository(Model, [tenantField], opts)` — second argument must be a plugins array.
```

Lock-in: `tests/unit/repository/base-plugin-validation.test.ts` (6 cases covering string/null/object-without-apply/function/object/post-construction `use()` paths).

### Migration — mongokit 4.0, arc 2.12, arc-next 0.6

Three downstream changes drop their local copies and import directly:

1. **mongokit 4.0** — deletes its local `AggregatePaginationResult` declaration and `PaginationResult` union; consumers that imported them from `@classytic/mongokit` must switch to `@classytic/repo-core/pagination`. (Breaking.)
2. **arc 2.12** — `fastifyAdapter` calls `toCanonicalList()` once instead of inline-flattening offset and falling through keyset/aggregate as nested `data`. Closes a real wire-envelope-mismatch bug.
3. **arc-next 0.6** — adds `@classytic/repo-core` as peer dep, deletes its local `OffsetPaginationResponse` / `KeysetPaginationResponse` / `AggregatePaginationResponse` / `PaginatedResponse` types. Server and client now share one declaration — the `method` field asymmetry is impossible by construction.

No breaking changes inside `@classytic/repo-core` itself — purely additive.

## [0.2.0] - 2026-04-22

### Added — Update IR (portable write-side primitive)

- **New `@classytic/repo-core/update` subpath.** The write-side counterpart to `@classytic/repo-core/filter`. Plugins and arc's infrastructure stores compose an `UpdateSpec` once; each kit compiles it to its native shape.
  - **Types:** `UpdateSpec` (tagged union on `op: 'update'`, four buckets: `set` / `unset` / `setOnInsert` / `inc`), `UpdateInput` (union of `UpdateSpec` | kit-native `Record<string, unknown>` | Mongo pipeline `Record<string, unknown>[]`).
  - **Builders:** `update({ set, unset, setOnInsert, inc })` (root), `setFields`, `unsetFields(...f)`, `setOnInsertFields`, `incFields`, `combineUpdates(...specs)` (later-wins merge, `unset` de-duplicates).
  - **Guards:** `isUpdateSpec` (routes portable IR to the compiler), `isUpdatePipeline` (lets SQL kits short-circuit with `UnsupportedOperationError`).
  - **Compilers:** `compileUpdateSpecToMongo(spec)` emits `{ $set, $unset, $setOnInsert, $inc }`. `compileUpdateSpecToSql(spec)` emits a `SqlUpdatePlan` with `data` / `unset` / `inc` / `insertDefaults` buckets, leaving SQL generation (quoting, `ON CONFLICT`, parameter binding) to the kit.
- **`StandardRepo.findOneAndUpdate` + `updateMany` widened to `UpdateInput`.** Accepts all three forms — portable `UpdateSpec`, kit-native record, Mongo aggregation pipeline. Kits dispatch with `isUpdateSpec`. The existing raw-record and pipeline paths remain unchanged; the IR is purely additive so consumers don't need to migrate. Arc's infrastructure stores (outbox, idempotency, audit) will switch to the IR over a subsequent release to close the "Mongo-shaped store" gap flagged in the April 2026 cross-surface review.

**Motivation (Arc April 2026 review):** arc's `EventOutbox`, `IdempotencyStore`, and `AuditStore` adapters use Mongo operator records (`$set`, `$inc`, `$unset`, `$setOnInsert`, `$or`, `$lte`, ...) directly against `RepositoryLike.findOneAndUpdate`. That works on mongokit but fails on sqlitekit — whose `findOneAndUpdate` treats `data` as flat column overwrites and would literally set a column named `$set`. The Update IR closes the gap without forcing every kit to ship its own Mongo-operator compatibility layer.

**Rationale for scope:** the IR covers the subset every backend supports (atomic set / unset / inc / insert-default). Kit-native features — Mongo `$push`/`$pull`/`$addToSet`, aggregation pipeline updates, Postgres `jsonb_set`, SQL `CASE` expressions — stay on the kit-native path via `UpdateInput`'s raw-record and pipeline forms. No lowest-common-denominator bloat; no feature loss for kits that already offer more.

**Test delta**: 193 → 230 tests (37 new across `tests/unit/update/builders`, `/guard`, `/compile`).

### Changed — breaking: `StandardRepo` write signatures

`StandardRepo.findOneAndUpdate(filter, update, ...)` and `updateMany(filter, data, ...)` — the second parameter is now typed `UpdateInput` (was `Record<string, unknown> | Record<string, unknown>[]` and `Record<string, unknown>` respectively). Every call site that compiled against 0.1.0 keeps compiling: `Record<string, unknown>` and `Record<string, unknown>[]` are subtypes of `UpdateInput`. The break is on the **implementer** side — any kit that declared only the old parameter type no longer structurally satisfies `StandardRepo` under strict contravariance. mongokit 3.11.0 and sqlitekit 0.1.1 already ship with the widened signatures; third-party kits need to widen before bumping their `@classytic/repo-core` peer dep.

### Changed — breaking: `updateMany` + `deleteMany` promoted to required members of `StandardRepo`

Both methods were optional (`updateMany?` / `deleteMany?`) in 0.1.0; they're required in 0.2.0. Rationale: every real backend has a native bulk-update and bulk-delete primitive, and arc's infrastructure stores (outbox, idempotency, audit cleanup) assume both are callable without feature-detection. Leaving them optional invited the "forgot to wire `batchOperationsPlugin`" runtime `TypeError` footgun that earlier releases of mongokit shipped — with the promotion, the type system catches missing implementations at the kit boundary.

**Impact**:
- **Kits**: any kit declaring `class FooRepo<T> implements StandardRepo<T>` must provide `updateMany` and `deleteMany` or fail to compile. mongokit 3.11.0 and sqlitekit 0.1.1 both ship these as class primitives, so their conformance stays green.
- **Consumers of `RepositoryLike<T> = MinimalRepo<T> & Partial<StandardRepo<T>>`** (arc's pattern) are unaffected — `Partial` reimposes optionality for feature detection at the arc adapter boundary. `if (repo.updateMany)` guards keep working.
- `bulkWrite` stays optional — the mongoose-shaped `BulkWriteOperation` has no clean SQL analogue, and every kit would ship an uninteresting fan-out wrapper otherwise.

### Naming — `UpdateInput` collision with mongokit

`@classytic/repo-core/update` exports `UpdateInput` as the union `UpdateSpec | Record<string, unknown> | Record<string, unknown>[]`. `@classytic/mongokit` currently **also** exports a type named `UpdateInput<TDoc> = Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>` — a completely different, document-typed shape used by `repo.update(id, data)`. If you write `import { UpdateInput } from '@classytic/mongokit'`, you get mongokit's generic; if you write `import type { UpdateInput } from '@classytic/repo-core/update'`, you get the union. Both names may appear in the same consumer file — import at least one with an alias (`import type { UpdateInput as UpdatePatch } from '@classytic/mongokit'`). mongokit will rename its local type in a follow-up release to close the collision permanently.

### Added
- Phase 0 scaffold: package.json, tsconfig, tsdown, biome, vitest (4-tier), knip
- `@classytic/repo-core/hooks` — `HOOK_PRIORITY` constants + `HookPriority` type
- `@classytic/repo-core/operations` — `CORE_OP_REGISTRY`, `extendRegistry`, `listOperations`, `mutatingOperations`, `readOperations`, `operationsByPolicyKey`, `describe`; 17 core ops, driver-free
- `@classytic/repo-core/errors` — `HttpError`, `createError`, `isHttpError`, `conservativeMongoIsDuplicateKey`, `toDuplicateKeyHttpError`
- `@classytic/repo-core/pagination` — `encodeCursor`/`decodeCursor` (URL-safe base64, mongokit ≤3.x compat), `validateCursorSort`, `validateCursorVersion`, `normalizeSort`, `validateKeysetSort`, `invertSort`, `getPrimaryField`, `validateLimit`, `validatePage`, `shouldWarnDeepPagination`, `calculateSkip`, `calculateTotalPages`
- INFRA.md tracking doc + 4-tier test structure per monorepo testing-infrastructure.md
- 74 unit tests across 6 files, full suite runs in ~360 ms
- `@classytic/repo-core/filter` — Filter IR types (`Filter` discriminated union), combinators (`eq`, `ne`, `gt`/`gte`/`lt`/`lte`, `in_`/`anyOf`, `nin`/`noneOf`, `like`, `regex`, `exists`, `and`, `or`, `not`/`invert`), constants (`TRUE`, `FALSE`), runtime guard (`isFilter`), traversal (`walkFilter`, `mapFilter`, `collectFields`), in-memory evaluator (`matchFilter`, `asPredicate`). Boolean absorbing/identity elimination baked in.
- `@classytic/repo-core/repository` — arc-aligned contract types: `MinimalRepo<TDoc>` (5-method floor), `StandardRepo<TDoc>` (recommended surface), option/result types (`QueryOptions`, `WriteOptions`, `DeleteOptions`, `FindOneAndUpdateOptions`, `DeleteResult`, `DeleteManyResult`, `UpdateManyResult`, `PaginationParams`), `RepositorySession`, `InferDoc<R>`.
- 43 additional unit tests (builders, walk, match) bringing total to 117.
- **Filter IR expansion** — sugar builders: `between`, `startsWith`, `endsWith`, `contains`, `iEq`, `isNull`, `isNotNull` (desugar to existing ops); new `raw` escape-hatch op for driver-native fragments (e.g. pgvector `<=>`, SQLite JSON1 path, Mongo `$geoWithin`).
- `@classytic/repo-core/query-parser` — URL → `ParsedQuery<Filter>` driver-agnostic parser. Bracket grammar (`field[gte]=18`, `field[in]=a,b`, `field[contains]=text`). Shared types (`ParsedQuery`, `ParsedSort`, `ParsedSelect`, `ParsedPopulate`, `QueryParserOptions`, `BracketOperator`) consumed identically by every kit and both frontends (arc-next, fluid).
- 36 more unit tests covering sugar builders + QueryParser. Total: **153 tests, 11 files, green on vitest 4**.
- Upgraded to **vitest 4.1**, **typescript 6.0**, **biome 2.4.12**. Vitest config migrated to new `pool` / `fileParallelism` top-level API.
- **M3 landed: `RepositoryBase` abstract class** at `@classytic/repo-core/repository`. Owns `HookEngine`, plugin installation, context builder, `_emitAfter` / `_emitError`, and the `_cachedValue` cache-short-circuit helper. Kits extend it instead of reinventing the hook layer.
- **M4 landed: 5 portable plugins** — `@classytic/repo-core/plugins/timestamp`, `/multi-tenant`, `/soft-delete`, `/audit`, `/cache`. All Filter-IR-native. Multi-tenant + soft-delete inject scope via `and(existing, eq(...))` / `and(existing, isNull(...))` — no Mongo-specific `$`-operators. Cache includes pluggable `CacheAdapter` interface + reference `createMemoryCacheAdapter`.
- **Tightened the scope rule for plugins** — skipped observability / validation-chain / field-filter / cascade / custom-id. Rule: a plugin lives in repo-core only if every backend needs it AND no backend provides it natively. The skipped ones are either arc's job (field-filter), host cookbook (observability, custom-id), zod's job (validation-chain), or SQL-native (cascade).
- **`StandardRepo.withTransaction` signature fixed** — was `(session) => T`, mongoose leak. Now `(txRepo: this) => T` — caller writes `await txRepo.create(...)`, never touches session. SQL / Prisma kits bind the tx connection to a new repo; mongokit returns a session-threaded proxy.
- `QueryOptions.session` re-documented as mongoose-specific.
- `RepositoryBase.on` / `off` now generic over listener-data type so typed plugins (`(ctx: RepositoryContext) => void`) don't need casts.
- **HookEngine** exposed at `@classytic/repo-core/hooks` — `DEFAULT_LISTENER_PRIORITY`, `HookEngine` class, `HookListener`, `HookMode`, `PrioritizedHook`, `EventPhase` types.
- **Context subpath** at `@classytic/repo-core/context` — `RepositoryContext` type exposed independently for plugin authors.
- **`HookEngine.listeners()`** — read-only snapshot of the listener registry (frozen buckets). Lets kits expose a back-compat `_hooks: Map<event, PrioritizedHook[]>` getter without handing out mutable internal state. Used by mongokit 3.10's read-through `_hooks` shim.
- **`RepositoryBase._buildContext` always awaits `before:*` hooks** regardless of engine mode — policy plugins must mutate context synchronously before the driver call fires. After- and error-hooks still honor `hooks: 'sync'` for fire-and-forget observability. Previous behavior (fire-and-forget in sync mode) would let driver calls race ahead of tenant/soft-delete scope injection; tracked as a latent bug surfaced by the mongokit 3.10 migration.

### Changed — plugins move out, primitives move in

- **All 5 plugins deleted from `@classytic/repo-core/plugins/*`** — `timestamp`, `soft-delete`, `multi-tenant`, `audit`, `cache` no longer ship from this package. Rationale: end-users install a kit, never repo-core directly, so plugins belong in the namespace users actually import. Each kit (mongokit, sqlitekit, pgkit, prismakit) owns its own plugin implementations, which lets each use driver-native features (mongoose native timestamps, SQLite triggers, Postgres `now()`, Prisma `@default`) instead of a lowest-common-denominator JS emulation.
- **New `@classytic/repo-core/cache` subpath** — the plugin-composition primitives that every kit's cachePlugin shares:
  - `CacheAdapter` interface (get / set / del / delByPattern)
  - `stableStringify` — deterministic JSON keying for cache buckets
  - `createMemoryCacheAdapter` — reference in-memory adapter for tests + single-process apps
- **New scope helpers in `@classytic/repo-core/filter`** — `buildTenantScope(existing, tenantField, tenantId)` and `mergeScope(existing, scope)`. Every policy plugin (multi-tenant / soft-delete / org-boundary) AND-s a predicate into an existing filter while handling three shapes (undefined / Filter IR / flat record). Lifted into `/filter` so each kit's plugin composes the same merge semantics.
- **Architectural principle codified** — "Repo-core is invisible infrastructure. End-users install a kit; repo-core exists for kit authors." See INFRA.md §3.

### Arc integration review — 2026-04-19

Changes landed in response to the Arc 2.10 maintainer's end-to-end integration report (see `ARC_INTEGRATION_REPORT.md`). All three non-blocking enhancements adopted; sqlitekit-side blockers are tracked on the sqlitekit package, not here.

- **`OffsetPaginationResult<TDoc, TExtra>` + `KeysetPaginationResult<TDoc, TExtra>`** — added an optional second generic so kits can surface typed extras alongside the core envelope (mongokit emits `warning?: string` on deep-page reads, pgkit could surface `queryPlan`, sqlitekit could surface vacuum hints). Defaults to `Record<string, never>` so existing consumers (`OffsetPaginationResult<User>`) see zero behavioral change. Both types also export their core interface (`OffsetPaginationResultCore` / `KeysetPaginationResultCore`) for StandardRepo contract references. The `method` discriminant carries through the intersection so `if (result.method === 'offset')` narrowing keeps working.
- **`HOOK_EVENTS` constant + `HookEventName` type** at `@classytic/repo-core/hooks` — canonical string-constant registry for every `before:* / after:* / error:*` event across the MinimalRepo + StandardRepo op set (17 ops × 3 phases = 51 events). Plugin authors subscribe via `HOOK_EVENTS.BEFORE_CREATE` instead of raw strings so typos become compile errors instead of silent no-ops. Kits with additional native ops (mongokit's `aggregate` / `bulkWrite`) compose their own extended constant on top. Cross-kit plugins written against `HOOK_EVENTS` work identically on every kit for the shared op set.
- **`CacheAdapter.clear?(pattern?)`** replaces the previous `delByPattern?(pattern)` — aligns with mongokit's `CacheAdapter` and Arc's `CacheStore` so one Redis / KV / Memcached implementation plugs into every consumer. `clear()` with no argument wipes everything; `clear('prefix:*')` is glob-matched. `createMemoryCacheAdapter` reference impl updated. Breaking change for anything calling `adapter.delByPattern` directly — sqlitekit's cache plugin (the only in-tree caller) migrated in the same commit.
- **`CacheAdapter.delete(key)`** — renamed from `del(key)` for consistency with JavaScript's native `Map.delete` / `Set.delete`, `MinimalRepo.delete(id)` in this same package, arc's `RepositoryLike.delete`, and every higher-level cache library (Keyv, etc.). Redis clients keep their own `.del()` — the adapter implementation translates. Applied across `@classytic/repo-core/cache` (interface + `createMemoryCacheAdapter`) and `@classytic/mongokit` (its own `CacheAdapter` type + `createMemoryCache` reference impl + every test adapter). The rename arrived **before first publish**, so no migration cost for external consumers — it's simply the shipping name.
- **TTL unit stays seconds** (`ttlSeconds`) — matches Redis `SET EX seconds` and mongokit's existing `ttl` semantics. Arc's `ttlMs` was the outlier; the Arc team agreed to align on seconds.
- **Sync-or-async return types preserved** on `CacheAdapter` — memory-backed adapters return synchronously without a microtask hop; Redis adapters return Promises. Consumers `await` either way at no runtime cost.

**Test delta**: 153 → 177 tests (24 new covering HOOK_EVENTS exhaustiveness, pagination TExtra narrowing, and CacheAdapter + stableStringify round-trip).

### Unified `withTransaction` contract — mongokit caught up

The `StandardRepo.withTransaction` contract at `@classytic/repo-core/repository` has always specified `fn: (txRepo: this) => Promise<T>` — the bound-tx shape sqlitekit has implemented since 0.1. Mongokit 3.9 deviated from the contract and passed a raw `ClientSession` instead. Mongokit 3.10 fixes that: its `withTransaction` now hands over a session-threaded proxy repository matching the canonical signature. Cross-kit plugins and apps that depend on `StandardRepo.withTransaction` now work identically against mongokit and sqlitekit — one contract, no kit-specific branches.

The contract docstring in `src/repository/types.ts` was already accurate; this is the mongokit-side implementation catching up. See `@classytic/mongokit` 3.10 release notes for the migration diff — this is a **breaking change for mongokit 3.x users** but repo-core's shape is unchanged.

### Consumed by

- **`@classytic/mongokit`** — `Repository extends RepositoryBase`; hook engine, plugin-order validator, and `HOOK_PRIORITY` sourced from repo-core. Ships its own Mongo-optimized plugins (unchanged from 3.9).
- **`@classytic/sqlitekit`** — extends `RepositoryBase`; ships its own SQLite-optimized plugins at `@classytic/sqlitekit/plugins/{timestamp,soft-delete,multi-tenant,audit,cache}`. Imports `CacheAdapter` + `stableStringify` + `buildTenantScope` from repo-core.
