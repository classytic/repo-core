# @classytic/repo-core

**Driver-agnostic repository primitives.** Hooks, Filter IR, operations registry, pagination, URL query parsing, cache contract — the shared foundation for `@classytic/mongokit`, `@classytic/sqlitekit`, and future `@classytic/pgkit` / `@classytic/prismakit`.

Repo-core is **infrastructure for kit authors.** End-users install a kit (mongokit / sqlitekit) and import their full API from that one namespace. Repo-core is what each kit's runtime is built on — you typically won't import it directly in application code.

## Design principles

- **ESM only.** `.mjs` + `.d.mts` output. Node 22+.
- **No root barrel.** Every public surface is its own subpath in `exports`. Import directly from where the symbol lives; unused modules never enter your dep graph.
- **Zero runtime dependencies.** No driver imports anywhere in `src/`.
- **Tree-shakeable by construction.** `unbundle: true` in tsdown — 1:1 src→dist, no shared chunks.
- **No plugins ship here.** Each kit owns its own plugin implementations so they can use driver-native features (mongoose's built-in timestamps, SQLite triggers, Postgres `now()`, Prisma `@default`). Repo-core provides the primitives kits compose: `CacheAdapter`, `stableStringify`, `buildTenantScope`, `HOOK_PRIORITY`, the hook engine, Filter IR.

## Subpaths

```ts
// Hook engine + priority constants + canonical event names. HOOK_EVENTS turns
// raw strings into compile-checked constants so typos fail at build time.
import { HOOK_EVENTS, HOOK_PRIORITY, HookEngine } from '@classytic/repo-core/hooks';

// Abstract repository base + MinimalRepo / StandardRepo contracts + plugin types.
import { RepositoryBase, type MinimalRepo, type Plugin } from '@classytic/repo-core/repository';

// Driver-agnostic filter AST — combinators (eq/and/or/in/like/between/...) + walk/match + scope helpers.
import { and, eq, gte, in_, like, buildTenantScope, matchFilter } from '@classytic/repo-core/filter';

// URL → ParsedQuery grammar. Backend frameworks (Express/Arc/Fastify) parse req.query here.
import { parseUrl } from '@classytic/repo-core/query-parser';

// Pagination primitives — cursor codec, keyset helpers, offset math, the canonical
// result types (`OffsetPaginationResult`, `KeysetPaginationResult`,
// `AggregatePaginationResult`, `PaginationResult`) and the wire helper
// `toCanonicalList()`. Single source of truth — primitives' duplicate dropped,
// mongokit/sqlitekit re-export from here.
import { encodeCursor, decodeCursor, validateKeysetSort, toCanonicalList } from '@classytic/repo-core/pagination';
import type { OffsetPaginationResult, KeysetPaginationResult, AggregatePaginationResult, PaginationResult } from '@classytic/repo-core/pagination';

// Tenant config — the canonical `TenantConfig`, `TenantStrategy`, `TenantFieldType`,
// `resolveTenantConfig`, `DEFAULT_TENANT_CONFIG`, `ResolvedTenantConfig`. Kits'
// `MultiTenantOptions extends Pick<TenantConfig, ...>`.
import { resolveTenantConfig, DEFAULT_TENANT_CONFIG } from '@classytic/repo-core/tenant';
import type { TenantConfig, ResolvedTenantConfig } from '@classytic/repo-core/tenant';

// Cache plumbing — the CacheAdapter interface every kit's cachePlugin writes against.
import { type CacheAdapter, stableStringify, createMemoryCacheAdapter } from '@classytic/repo-core/cache';

// Error contracts — `HttpError` throwable + `ErrorContract` wire shape +
// `ErrorDetail` + `ErrorCode` + `ERROR_CODES` + `toErrorContract()` +
// `statusToErrorCode()`. Single source of truth — primitives' errors module dropped,
// mongokit's local `HttpError` dropped, `ArcError implements HttpError`.
import { toErrorContract, statusToErrorCode, ERROR_CODES, createError, conservativeMongoIsDuplicateKey } from '@classytic/repo-core/errors';
import type { HttpError, ErrorContract, ErrorDetail, ErrorCode } from '@classytic/repo-core/errors';

// Schema generator interface — kits ship `SchemaGenerator<TModel>` + the
// compile-time conformance assertion; arc adapters are typed against it.
import type { SchemaGenerator, SchemaGeneratorContext } from '@classytic/repo-core/schema';
import { isSchemaGenerator } from '@classytic/repo-core/schema';

// Operation registry (for arc-level policy dispatch + doc generation).
import { CORE_OP_REGISTRY, describe } from '@classytic/repo-core/operations';

// Repository hook context type (for plugin authors).
import type { RepositoryContext } from '@classytic/repo-core/context';
```

**There is no `.` / root entry.** Import from the exact subpath — that's the contract that keeps tree-shaking honest.

## Example: a kit's repository extends `RepositoryBase`

```ts
import { RepositoryBase } from '@classytic/repo-core/repository';
import { compileFilter } from './my-kit-compiler.js';

export class MyKitRepository<T> extends RepositoryBase {
  // Kit-specific CRUD methods. Each routes through `_buildContext` → plugins
  // → native driver call → `_emitAfter` so every plugin (timestamp, cache,
  // multi-tenant, audit) composes identically across kits.
  async getAll(params: {...}) {
    const context = await this._buildContext('getAll', params);
    const cached = this._cachedValue(context);
    if (cached) return cached;
    const where = compileFilter(context.filters);
    const result = await this.driver.query(where);
    await this._emitAfter('getAll', context, result);
    return result;
  }
}
```

## Example: URL → ParsedQuery → any kit

The URL grammar is identical across every kit. Frontends emit one URL; swapping the backend DB doesn't change a single query string.

```ts
import { parseUrl } from '@classytic/repo-core/query-parser';

app.get('/users', async (req, res) => {
  const parsed = parseUrl(req.query, {
    allowedFilterFields: ['email', 'role', 'active', 'createdAt'],
    fieldTypes: { active: 'boolean', createdAt: 'date' },
    maxLimit: 200,
  });
  // Works identically against any kit's repository:
  //   const page = await sqliteUserRepo.getAll(parsed);
  //   const page = await mongoUserRepo.getAll(parsed);
  res.json(await userRepo.getAll(parsed));
});
```

URL grammar:

| URL                                   | Filter IR produced                             |
|---------------------------------------|-----------------------------------------------|
| `?status=active`                      | `eq('status', 'active')`                       |
| `?age[gte]=18&age[lt]=65`             | `and(gte('age', 18), lt('age', 65))`           |
| `?role[in]=admin,editor`              | `in_('role', ['admin', 'editor'])`             |
| `?name[contains]=john`                | `like('name', '%john%')`                       |
| `?price[between]=10,100`              | `and(gte(...), lte(...))`                      |
| `?deletedAt[exists]=false`            | `isNull('deletedAt')`                          |
| `?sort=-createdAt,name`               | `{ createdAt: -1, name: 1 }` (on `.sort`)      |
| `?select=name,email,-password`        | `{ name: 1, email: 1, password: 0 }`           |
| `?page=2&limit=50`                    | pagination fields on ParsedQuery               |
| `?after=eyJ2Ij...`                    | opaque keyset cursor                           |

## Plugin-friendly event names

```ts
import { HOOK_EVENTS, HOOK_PRIORITY } from '@classytic/repo-core/hooks';

// Cross-kit plugin — works identically on mongokit, sqlitekit, pgkit, prismakit.
export function stampOrgId(orgId: string): Plugin {
  return {
    name: 'stamp-org-id',
    apply(repo) {
      repo.on(HOOK_EVENTS.BEFORE_CREATE, (ctx) => {
        if (!ctx.data?.organizationId) ctx.data = { ...ctx.data, organizationId: orgId };
      }, { priority: HOOK_PRIORITY.POLICY });
    },
  };
}
```

Typos like `'before:craete'` become compile errors. Subscribing to an event a given kit doesn't emit is a silent no-op (that's how the hook engine works), so a plugin can safely wire listeners for the full standard set.

## Typed result extras

```ts
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';

// Kit adds a typed surface-level extra without breaking cross-kit substitutability.
type MongokitPage<T> = OffsetPaginationResult<T, { warning?: string }>;

function render(page: MongokitPage<User>) {
  if (page.warning) showBanner(page.warning);
  return page.docs.map(userRow);
}
```

Default `TExtra` is `Record<string, never>` — `OffsetPaginationResult<User>` behaves identically before and after; the generic is free to ignore.

## Status

**v0.3.0 — canonical contracts release.** Pagination types + wire envelope, tenant config, error contracts, and the `SchemaGenerator<TModel>` interface relocated from primitives / mongokit / arc to single sources of truth here.

Consumed by:
- `@classytic/mongokit` ≥ 3.12 — `Repository extends RepositoryBase`; hook engine, plugin-order validator, `HOOK_PRIORITY` sourced from repo-core. Pagination + `HttpError` types now flow from repo-core (mongokit's local copies dropped). `MultiTenantOptions extends Pick<TenantConfig, ...>`. `buildCrudSchemasFromModel` ships a compile-time `SchemaGenerator<TModel>` conformance assertion. Mongokit's own `QueryParser` remains standalone.
- `@classytic/sqlitekit` ≥ 0.2 — `SqliteRepository extends RepositoryBase`; Filter IR compiled to Drizzle / raw SQL natively. `MultiTenantOptions extends Pick<TenantConfig, ...>`. `buildCrudSchemasFromTable` ships the same `SchemaGenerator` conformance assertion.
- `@classytic/arc` ≥ 2.12 — adapters typed against `SchemaGenerator<TModel>`; `ArcError implements HttpError`; pagination wire envelope (`method` discriminant) emitted via `toCanonicalList()` with `reply.sendList()`.

See [INFRA.md](./INFRA.md) for the architectural principles, subpath map, build/tooling decisions, and the roadmap for pgkit / prismakit.

## License

MIT — see [LICENSE](./LICENSE).
