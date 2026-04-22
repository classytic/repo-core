# Changelog

All notable changes to `@classytic/repo-core` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
