# Writing a kit, plugin or conformance harness

## Repository base (`/repository`)

A kit extends `RepositoryBase` and implements `MinimalRepo` (`getAll`, `getById`, `create`, `update`, `delete`) plus as much of `StandardRepo` as the backend
supports. Every operation goes: `_buildContext` (runs `before:*` hooks and policy plugins) -> native call -> `_emitAfter`. Options on `RepositoryBaseOptions`:
`name`, `plugins`, `hooks` (`sync` or `async`), `pluginOrderChecks` (`warn`, `throw`, `off`), `schema`, `updateSchema` (any Standard Schema validator), `events`.
Validation runs at `HOOK_PRIORITY.VALIDATION`; event publishing never fails the operation (failures go to `error:events`).

Do not narrow an existing contract type: additive optional fields are safe, renames and new required fields are breaking. Method signatures use `unknown` for
sessions and `readonly string[]` for arrays so kits stay assignable.

`StandardRepo` extras (optional unless noted): `claim`, `claimVersion` (required CAS), `applyTransition`, `findOneAndUpdate`, `getOne`, `getByIds`, `findAll`, `count`, `exists`,
`distinct`, `getOrCreate`, `createMany`, `updateMany`, `deleteMany`, `bulkUpsert`, `purgeByField`, `purgeByFilter`, `archiveByFilter`, `aggregate`, `lookupPopulate`,
`isDuplicateKeyError`, `isTransientConflictError`. Declare what works in `capabilities` (`transactions`, `upsert`, `aggregate`, `aggregateOps`, `readOnly`, `arrayOperators`...).

## Plugins and hooks (`/hooks`)

```ts
import { HOOK_EVENTS, HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type { Plugin } from '@classytic/repo-core/repository';

export const stampOrg = (orgId: string): Plugin => ({
  name: 'stamp-org',
  apply(repo) {
    repo.on(HOOK_EVENTS.BEFORE_CREATE, (ctx) => { ctx.data = { ...ctx.data, organizationId: orgId }; }, { priority: HOOK_PRIORITY.POLICY });
  },
});
```

Priorities: `POLICY` 100, `VALIDATION` 150, `CACHE` 200, `OBSERVABILITY` 300, `DEFAULT` 500 (lower runs first). Events per op: `before:`, `after:`, `error:` for create, update, delete,
getById, getAll, createMany, updateMany, deleteMany, findOneAndUpdate, restore. Listening to an event a kit never emits is a silent no-op.
`PLUGIN_ORDER_CONSTRAINTS`: soft-delete before batch-operations; multi-tenant before cache and before soft-delete. `validatePluginOrder` enforces them.

Domain events: pass `events: { transport, source }` and every mutating op publishes `<resource>.<verb>`. Do not also enable arc's auto events for the same resource (double publish).

## Cache (`/cache`)

`CacheAdapter` is `{ get, set(key, value, ttlSeconds?), delete, clear?, addToSet?, increment? }`. `cachePlugin` options: `adapter`, `enabled`, `invalidating`, `defaults`
(`staleTime`, `gcTime`, `swr`, `tags`, `bypass`), `perOpDefaults`, `prefix`, `autoTagsFromScope`, `jitter`. `withTimeout(adapter, ...)` bounds a slow cache so it degrades to a miss.
`createMemoryCacheAdapter` and `createTtlMemo` are in-process helpers.

## Idempotency (`/idempotency`)

`IdempotencyClaimStore` is the persistence contract (kits ship one: mongokit `createIdempotencyStore`, `createMemoryIdempotencyStore` in repo-core). `runIdempotent` drives
claim, execute, complete with leases (`leaseMs`, default 30 s), checkpoints (`attempt.checkpoint(progress)`) and replay. A reused key with a different body fails
`FINGERPRINT_MISMATCH`. `classifyFailure` returns `terminal` (store the failure), `transient` (release for retry) or `ambiguous` (keep the lease). `IdempotencyError.code` is one of
`FINGERPRINT_MISMATCH`, `MISSING_REPLAY`, `LEASE_LOST`, `ALREADY_TERMINAL`, `INVALID_CLAIM`, `UNFINGERPRINTABLE`.

## Other subpaths

| Subpath | Content |
|---|---|
| `/lock` | `LockAdapter`, `createMemoryLockAdapter` |
| `/usage` | `UsageStore`, `usagePeriod`, `createMemoryUsageStore` |
| `/sync` | change-log and command-stream store contracts |
| `/loader` | `createBatchLoader({ batch, maxBatchSize, requireAllResolved })` |
| `/cleanup` | `definePurgeStep` (fail-closed scope, preview, chunked purge, proof of absence) |
| `/adapter` | `DataAdapter` contract, `asRepositoryLike`, `isRepository` for arc |
| `/schema` | `SchemaGenerator`, `validateStandardSchema`, field rule helpers |
| `/operations` | `CORE_OP_REGISTRY`, `describe`, `listOperations` |
| `/aggregate` | aggregation cursor and normalization helpers |
| `/lookup` | `LookupSpec`, `LookupPopulateResult` types |
| `/context` | `RepositoryContext` type |

## Conformance (`/testing`, needs the optional peer `fast-check` for property suites)

```ts
import { runStandardRepoConformance } from '@classytic/repo-core/testing';
runStandardRepoConformance({ name: 'my-kit', idField: 'id', features, setup, makeDoc });   // setup() returns { repo, cleanup }
```

Gated groups (aggregate ops, bulkUpsert, readModel, mergeKeyset) run only when the kit declares the capability. Other suites: `runLockAdapterConformance`, `runUsageStoreContract`,
`runPurgeConformance`, `runChangeLogStoreConformance`, `runQueryGrammarConformance`. Use `harness.makeDoc` for fixtures and `harness.idField` for ids; never inline a kit shape.
An unsupported op must throw a clear error naming the kit and the alternative, never approximate silently.
