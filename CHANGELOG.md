# Changelog

All notable changes to `@classytic/repo-core` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
