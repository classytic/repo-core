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
// Hook engine + priority constants — the plugin lifecycle substrate every kit's repository uses.
import { HOOK_PRIORITY, HookEngine } from '@classytic/repo-core/hooks';

// Abstract repository base + MinimalRepo / StandardRepo contracts + plugin types.
import { RepositoryBase, type MinimalRepo, type Plugin } from '@classytic/repo-core/repository';

// Driver-agnostic filter AST — combinators (eq/and/or/in/like/between/...) + walk/match + scope helpers.
import { and, eq, gte, in_, like, buildTenantScope, matchFilter } from '@classytic/repo-core/filter';

// URL → ParsedQuery grammar. Backend frameworks (Express/Arc/Fastify) parse req.query here.
import { parseUrl } from '@classytic/repo-core/query-parser';

// Pagination primitives — cursor codec, keyset helpers, offset math.
import { encodeCursor, decodeCursor, validateKeysetSort } from '@classytic/repo-core/pagination';

// Cache plumbing — the CacheAdapter interface every kit's cachePlugin writes against.
import { type CacheAdapter, stableStringify, createMemoryCacheAdapter } from '@classytic/repo-core/cache';

// HTTP error envelope + duplicate-key contract.
import { createError, conservativeMongoIsDuplicateKey } from '@classytic/repo-core/errors';

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

## Status

**v0.1.0 — initial release.**

Consumed by:
- `@classytic/mongokit` ≥ 3.10 — `Repository extends RepositoryBase`; hook engine, plugin-order validator, `HOOK_PRIORITY` sourced from repo-core. Mongokit's own `QueryParser` remains standalone (emits Mongo `$`-objects) but implements the same URL grammar by convention.
- `@classytic/sqlitekit` (in development) — `SqliteRepository extends RepositoryBase`; Filter IR compiled to Drizzle / raw SQL natively. Uses `parseUrl` directly for URL parsing.

See [INFRA.md](./INFRA.md) for the architectural principles, subpath map, build/tooling decisions, and the roadmap for pgkit / prismakit.

## License

MIT — see [LICENSE](./LICENSE).
