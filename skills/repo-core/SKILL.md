---
name: repo-core
description: Driver-agnostic repository contracts shared by mongokit, sqlitekit and arc - list envelopes, ErrorContract and error codes, Filter IR, URL query grammar, keyset cursors, idempotency claims, hooks, cache adapter. Use when typing a list response, mapping errors, parsing query strings, or writing a kit or plugin. Triggers - repo-core, ErrorContract, toCanonicalList, parseUrl, Filter IR.
metadata:
  minVersion: "0.31.1"
  package: "@classytic/repo-core"
  note: "No root entry. Import from the exact subpath."
---

# @classytic/repo-core

The contract layer under every kit. Zero runtime dependencies, tree-shakeable, subpath imports only (`@classytic/repo-core/<subpath>`; there is no root import). App code uses it for envelopes, errors, filters and query parsing; kit authors also use `repository`, `hooks`, `testing`.

## Do not hand-roll

| Need | Use |
|---|---|
| Wire list shape (`{ method, data, ... }` or `{ data }`) | `toCanonicalList`, `isPaginatedResult` (`/pagination`) |
| Page result types | `OffsetPaginationResult`, `KeysetPaginationResult`, `PaginatedResult` |
| Error JSON body | `toErrorContract` -> `ErrorContract` (`/errors`) |
| Throwable HTTP error | `createError`, `isHttpError` |
| Status to code | `statusToErrorCode`, `ERROR_CODES` |
| Duplicate key to 409 | `toDuplicateKeyHttpError`, `DUPLICATE_KEY_DETAIL_CODE` |
| Version conflict | `VersionConflictError`, `isVersionConflictError` |
| Query string to filter, sort, page, select | `parseUrl` (`/query-parser`) |
| Filters and sort to URL params (inverse of `parseUrl`) | `formatQuery`, `stringifyQuery` (`/query-parser`) |
| Escape or vet user regex | `escapeRegex`, `assessRegex` |
| Portable filters | `and`, `or`, `eq`, `in_`, `between`, `contains` (`/filter`) |
| Evaluate a filter in memory | `matchFilter`, `asPredicate` |
| Tenant filter merge | `buildTenantScope`, `mergeScope` |
| Portable updates | `update`, `incFields`, `setFields` (`/update`) |
| Cursor encode, decode, sort checks | `encodeCursor`, `decodeCursor`, `validateKeysetSort` |
| One keyset page over several sources | `mergeKeysetPages` |
| Run once per idempotency key | `runIdempotent`, `fingerprintRequest` (`/idempotency`) |
| Retry transient failures | `withRetry`, `retryingTransaction` (`/repository`) |
| Batch N+1 lookups | `createBatchLoader` (`/loader`) |
| Seal a repo you do not own the writes of | `asReadOnlyRepo` |
| Cache adapter and test double | `CacheAdapter`, `createMemoryCacheAdapter` (`/cache`) |
| Hook order and event names | `HOOK_PRIORITY`, `HOOK_EVENTS` (`/hooks`) |
| Publish repo domain events | `registerRepositoryEvents` (`/events`) |
| Tenant purge as a cleanup step | `definePurgeStep` (`/cleanup`) |
| Stable content hash | `contentHash`, `stableStringify` (`/hash`) |
| Tenant config | `resolveTenantConfig` (`/tenant`) |
| Standard Schema (zod, valibot) check | `validateStandardSchema` (`/schema`) |
| Lock or usage test doubles | `createMemoryLockAdapter`, `createMemoryUsageStore` |
| Prove a kit conforms | `runStandardRepoConformance` (`/testing`) |

## Golden path

List route (kit result to wire):

```ts
import { toCanonicalList } from '@classytic/repo-core/pagination';
import { parseUrl } from '@classytic/repo-core/query-parser';

const q = parseUrl(req.query, { allowedFilterFields: ['status', 'createdAt'], fieldTypes: { createdAt: 'date' }, maxLimit: 200 });
const { filter, ...rest } = q;
reply.send(toCanonicalList(await repo.getAll({ ...rest, filters: filter })));   // paged results keep `method`; a bare array becomes { data }
```

Errors (throw `HttpError`, serialize once at the edge):

```ts
import { createError, toErrorContract } from '@classytic/repo-core/errors';
const err = createError(409, 'Already paid');
err.code = 'order.already_paid';
reply.code(409).send(toErrorContract(err));   // { code, message, status, details?, meta? }
```

Filter IR (same on every kit; native filters also work):

```ts
import { and, eq, in_, between } from '@classytic/repo-core/filter';
await repo.findAll!(and(eq('status', 'open'), in_('kind', ['a', 'b']), between('total', 10, 100)));
```

Idempotent side effect:

```ts
import { fingerprintRequest, runIdempotent } from '@classytic/repo-core/idempotency';
const run = await runIdempotent({ store, identity: { operation: 'charge', key, scope: { orgId } },
  requestFingerprint: fingerprintRequest(body), execute: async () => charge(body) });
// run.outcome: 'executed' | 'replayed' | 'in_flight' (retryAfterMs) | 'exhausted'
```

## Gotchas

- Envelope rows are in `data` (never `docs`). Narrow with `result.method`.
- `parseUrl` returns `filter` (Filter IR) but `getAll` reads `filters`: rename the key. mongokit's `QueryParser` already returns `filters`.
- `ErrorContract.code` has three families: `ERROR_CODES` (`conflict`), `ARC_ERROR_CODES` (`arc.conflict`), domain strings (`order.already_paid`). Switch on code, not message.
- `createError(status, message)` takes two arguments; set `code`, `meta`, `validationErrors` on the result.
- `CURSOR_ERROR_CODES`: `repo.cursor.invalid` and `repo.cursor.scope_mismatch` (400); restart paging on both.
- `before` and `mode` are reserved query params (not filters).
- `update({})` with no mutation throws; `undefined` values in `set` are dropped (use `unset` to clear).
- Duplicate-key values are PII: `exposeValues` is opt-in.
- A kit declares what it supports in `capabilities`; feature-detect instead of try and catch.

## Never

- Re-declare `HttpError`, `ErrorContract` or the page types in an app or kit.
- Import a root `@classytic/repo-core` (does not exist) or `dist/` paths.
- Parse `req.query` by hand for list routes.

## References

- `references/contracts.md`: read for envelope shapes, error codes, query grammar operators, cursor behavior.
- `references/kit-authoring.md`: read when writing a kit, plugin, conformance harness, hooks, cache or purge step.
- Kit behavior: skill `mongokit`. HTTP wiring: skill `arc`.
