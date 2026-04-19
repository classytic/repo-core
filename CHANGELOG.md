# Changelog

All notable changes to `@classytic/repo-core` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **`QueryParser` class** at `@classytic/repo-core/query-parser` — class-form wrapper around `parseUrl` matching mongokit's reusable-parser shape. Instantiate once per resource, hold options (allowlists, fieldTypes, maxLimit, etc.), call `.parse(req.query)` on every request. Kits subclass for backend-native extensions (sqlitekit adds Drizzle introspection; mongokit's existing parser could in future delegate to this for the common path). The URL grammar is canonical: every kit accepts the same bracket syntax so frontend URLs round-trip regardless of the DB.

### Consumed by

- **`@classytic/mongokit`** — `Repository extends RepositoryBase`; hook engine, plugin-order validator, and `HOOK_PRIORITY` sourced from repo-core. Ships its own Mongo-optimized plugins (unchanged from 3.9).
- **`@classytic/sqlitekit`** — extends `RepositoryBase`; ships its own SQLite-optimized plugins at `@classytic/sqlitekit/plugins/{timestamp,soft-delete,multi-tenant,audit,cache}`. Imports `CacheAdapter` + `stableStringify` + `buildTenantScope` from repo-core.
