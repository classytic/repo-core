# repo-core — infrastructure & build plan

> Tracking doc for `@classytic/repo-core`. Authoritative source for layout, deps, packaging, and phase progress. Update as decisions land.

## 1. Purpose

`@classytic/repo-core` is the **driver-agnostic** half of mongokit — hooks, operation registry, Filter IR, pagination model, portable plugins — extracted so `mongokit`, `pgkit`, and `prismakit` can share a single plugin ecosystem and a single repository contract.

### Scope — what lives here

- Hook engine + priority constants
- `OP_REGISTRY` / `PolicyKey` / `OperationDescriptor`
- `Filter` IR (neutral filter AST + combinators + scope-injection helpers `buildTenantScope` / `mergeScope`)
- Pagination abstractions (offset, keyset, cursor codec)
- URL → `ParsedQuery<Filter>` parser (front-end only, no driver emit)
- Error envelope (`HttpError`, `createError`, `isDuplicateKeyError` contract)
- Abstract `RepositoryBase<TDoc>` class — ctor, hook wiring, `_buildContext`. No CRUD methods.
- Cache contract — `CacheAdapter` interface + `stableStringify` + `createMemoryCacheAdapter` reference. No plugin here; kits compose their own cachePlugin on top.

### Scope — what does NOT live here

- **Plugins — period.** `timestamp`, `soft-delete`, `multi-tenant`, `audit`, `cache`, `observability`, `validation-chain`, `field-filter`, `cascade` all live in each kit. Rationale below (§3, plugin rule). Repo-core ships the primitives kits compose; each kit ships the plugin that uses driver-native features (mongoose's native timestamps, SQLite triggers, Postgres `now()`, Prisma `@default`, etc.).
- Any `mongoose` / `mongodb` / `pg` / `@prisma/client` import
- `aggregate()`, `lookupPopulate()`, `AggregationBuilder`, `LookupBuilder` — Mongo-only, stay in mongokit
- `mongoOperationsPlugin`, `elasticPlugin`, `subdocumentPlugin`, `batch-operations` — driver-coupled, stay in mongokit
- HTTP framework adapters — those belong in arc
- App-facing value types (SortSpec, PaginationConfig shape, etc.) — already in `@classytic/datakit-types`, reused here

## 2. Dependency graph

```
  datakit-types        (pure types, zero runtime)
        ↑
    repo-core          (hooks, Filter IR, base class, portable plugins)
        ↑
  ┌─────┼─────┐
mongokit pgkit prismakit       (driver kits — extend RepositoryBase)
  ↑       ↑      ↑
  └───────┼──────┘
          │
         arc                    (framework — depends on repo-core for shared types)
          ↑
       catalog                  (app — depends on mongokit + repo-core directly)
```

**Invariant — never cross a layer both ways:** repo-core imports nothing from any kit. Kits import nothing from arc. Arc imports nothing from any kit. Catalog sits at the bottom and imports whichever kit it wires.

Runtime deps: **none except `@classytic/datakit-types`** (types only, declared as a regular dep because its types are part of repo-core's public surface).

## 3. Architectural principles

| Principle | Applied how |
|---|---|
| ESM only | `"type": "module"`, `.mjs` + `.d.mts` output, no CJS |
| No root barrel | No `src/index.ts`. Every public surface has its own subpath in `exports` |
| Tree-shakeable by construction | Each module compiles 1:1 to `dist/<module>/index.mjs` via `unbundle: true`. Consumers import from the exact subpath, so unused modules never enter the dep graph |
| Sideeffect-free | `"sideEffects": false`. No top-level mutation, no module-load IO |
| Zero runtime deps | Peer-dep free. No `mongoose`, no `mongodb`, no driver imports anywhere in src |
| Strict types | `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`. No `any` in public surface |
| Google TS style | See `biome.json`; enforced in CI |
| Errors fail fast at construction | Plugin-order violations, missing required hook priorities, invalid filter IR → throw at `new Repository(...)`, not at first request |
| **Repo-core is invisible infrastructure** | End-users install a kit (`@classytic/mongokit`, `@classytic/sqlitekit`, …) — never `@classytic/repo-core` directly. Repo-core exists for **kit authors**; its surface is the primitives kits compose. Corollary: no plugins ship from repo-core. Each kit owns its own plugins so users import everything from a single namespace (`import { Repository, cachePlugin, timestampPlugin } from '@classytic/sqlitekit'`). |

## 4. Package layout

```
d:/projects/packages/repo-core/
├── INFRA.md                          ← this file
├── README.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── tsconfig.json
├── tsdown.config.ts
├── biome.json
├── knip.config.ts
├── vitest.config.ts
├── src/
│   ├── context/
│   │   ├── index.ts                  ← RepositoryContext, buildContext helper
│   │   └── types.ts
│   ├── hooks/
│   │   ├── index.ts                  ← public: HookEngine, HOOK_PRIORITY, types
│   │   ├── priority.ts               ← POLICY/CACHE/OBSERVABILITY/DEFAULT constants
│   │   ├── engine.ts                 ← priority-sorted listener registry + emit/emitAsync
│   │   └── types.ts                  ← HookListener, HookMode, PrioritizedHook
│   ├── operations/
│   │   ├── index.ts                  ← public: OP_REGISTRY, helpers
│   │   ├── registry.ts               ← const map, classification
│   │   └── types.ts                  ← PolicyKey, OperationDescriptor, RepositoryOperation
│   ├── filter/
│   │   ├── index.ts                  ← public: builders + types
│   │   ├── types.ts                  ← Filter union, node discriminants
│   │   ├── builders.ts               ← eq/ne/gt/gte/lt/lte/in/nin/like/regex/exists/and/or/not
│   │   ├── walk.ts                   ← mapFilter, matchFilter — used by plugins to inject scope
│   │   └── guard.ts                  ← isFilter, narrowing predicates
│   ├── pagination/
│   │   ├── index.ts
│   │   ├── types.ts                  ← Offset/Keyset/Aggregate result types, PaginationConfig
│   │   ├── offset.ts                 ← page/skip/hasNext math
│   │   ├── keyset.ts                 ← keyset predicate builders (emits Filter IR, not $gt/$lt)
│   │   └── cursor.ts                 ← base64url JSON cursor codec (pure, browser-safe)
│   ├── query-parser/
│   │   ├── index.ts                  ← public: parseUrl(params, opts) → ParsedQuery<Filter>
│   │   ├── types.ts                  ← ParsedQuery, QueryParserOptions
│   │   ├── bracket.ts                ← URL bracket grammar (field[in]=a,b → in(field,[a,b]))
│   │   ├── coerce.ts                 ← scalar coercion (string/number/bool/date)
│   │   └── sanitize.ts               ← ReDoS guard, max depth, max limit
│   ├── errors/
│   │   ├── index.ts
│   │   ├── http-error.ts             ← HttpError class, createError(status, message)
│   │   └── duplicate-key.ts          ← isDuplicateKeyError interface (kits implement)
│   ├── repository/
│   │   ├── index.ts                  ← public: RepositoryBase, types
│   │   ├── base.ts                   ← abstract class: hooks, _buildContext, _emitHook
│   │   └── types.ts                  ← RepositoryOptions, RepositoryInstance
│   ├── transaction/
│   │   ├── index.ts
│   │   ├── types.ts                  ← RepositorySession abstract handle
│   │   └── with-transaction.ts       ← generic retry + fallback helper
│   ├── cache/
│   │   ├── index.ts                  ← CacheAdapter interface, stableStringify, memory-adapter
│   │   ├── types.ts                  ← CacheAdapter (get/set/del)
│   │   ├── stable-stringify.ts       ← deterministic JSON keying
│   │   └── memory-adapter.ts         ← reference in-memory adapter
│   ├── repository/
│   │   ├── index.ts                  ← RepositoryBase, MinimalRepo, StandardRepo, plugin types
│   │   ├── base.ts                   ← abstract class: hooks, _buildContext, plugin-order
│   │   ├── plugin-types.ts           ← Plugin, PluginType, PLUGIN_ORDER_CONSTRAINTS, validator
│   │   └── types.ts                  ← MinimalRepo, StandardRepo, option/result types
│   └── transaction/                  ← reserved for cross-kit tx primitives (not shipped yet)
└── tests/                            ← 4-tier layout per monorepo testing-infrastructure.md
    ├── helpers/                      ← canonical floor — see testing-infrastructure.md §3
    │   ├── env.ts                    ← requireEnv, hasKey, has<Provider>() (no throws at import)
    │   ├── fixtures.ts               ← makeFilter, makeContext, makePluginStack — all Partial<T>
    │   ├── mocks.ts                  ← (add when we need external-service mocks)
    │   ├── assertions.ts             ← expectHookOrder, expectFilterEqual — domain matchers
    │   └── lifecycle.ts              ← (only if integration tests grow shared setup)
    ├── unit/                         ← pure functions, in-memory only, 10s timeout
    │   ├── hooks/engine.test.ts
    │   ├── hooks/priority.test.ts
    │   ├── operations/registry.test.ts
    │   ├── filter/builders.test.ts
    │   ├── filter/walk.test.ts
    │   ├── filter/match.test.ts
    │   ├── pagination/cursor.test.ts
    │   ├── pagination/offset.test.ts
    │   ├── pagination/keyset.test.ts
    │   ├── query-parser/bracket.test.ts
    │   └── query-parser/coerce.test.ts
    ├── integration/                  ← reserved — repo-core is driver-free; plugin scenarios live in each kit's tests
    ├── e2e/                          ← reserved — repo-core has no provider boundary; keep empty
    └── smoke/                        ← reserved — shell checks of the dist output
```

### Public subpaths (explicit, no root)

```jsonc
// package.json → exports
{
  "./hooks":                     "./dist/hooks/index.{mjs,d.mts}",
  "./operations":                "./dist/operations/index.{mjs,d.mts}",
  "./errors":                    "./dist/errors/index.{mjs,d.mts}",
  "./pagination":                "./dist/pagination/index.{mjs,d.mts}",
  "./repository":                "./dist/repository/index.{mjs,d.mts}",
  "./filter":                    "./dist/filter/index.{mjs,d.mts}",
  "./query-parser":              "./dist/query-parser/index.{mjs,d.mts}",
  "./context":                   "./dist/context/index.{mjs,d.mts}",
  "./cache":                     "./dist/cache/index.{mjs,d.mts}",
  "./package.json":              "./package.json"
}
```

**No `"."` entry.** Consumers import from the exact subpath:

```ts
import { RepositoryBase } from '@classytic/repo-core/repository';
import { HOOK_PRIORITY }  from '@classytic/repo-core/hooks';
import { eq, and, in_ }   from '@classytic/repo-core/filter';
import { parseUrl }       from '@classytic/repo-core/query-parser';
import { OP_REGISTRY }    from '@classytic/repo-core/operations';
import type { CacheAdapter } from '@classytic/repo-core/cache';
```

**No plugins ship from repo-core.** Each kit (mongokit, sqlitekit, pgkit, prismakit) owns its own plugin implementations so they can use driver-native features (mongoose's built-in timestamps, SQLite triggers, Postgres `now()`, Prisma `@default`). Repo-core ships the primitives kits compose: `CacheAdapter`, `stableStringify`, `buildTenantScope`, `HOOK_PRIORITY`, the hook engine, Filter IR.

## 5. Build / tooling decisions

### tsdown (Rolldown, ESM-only)

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'hooks/index':                  'src/hooks/index.ts',
    'operations/index':             'src/operations/index.ts',
    'errors/index':                 'src/errors/index.ts',
    'pagination/index':             'src/pagination/index.ts',
    'repository/index':             'src/repository/index.ts',
    'filter/index':                 'src/filter/index.ts',
    'query-parser/index':           'src/query-parser/index.ts',
    'context/index':                'src/context/index.ts',
    'cache/index':                  'src/cache/index.ts',
  },
  format: 'esm',
  platform: 'neutral',        // runs in Node + browser (cursor codec, Filter IR)
  target: 'node22',
  fixedExtension: true,       // emit `.mjs` / `.d.mts` (matches house style)
  dts: true,
  clean: true,
  unbundle: true,             // 1:1 src → dist — no chunk splitting, no shared runtime
  sourcemap: true,
  outputOptions: {
    preserveModules: true,
    preserveModulesRoot: 'src',
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
```

**Improvements over mongokit's tsdown setup:**

| | mongokit 3.9 | repo-core |
|---|---|---|
| Entry style | Array of globs | Object map — dist path ↔ src path explicit |
| Bundle mode | Default (chunk splitting) | `unbundle: true` — every source file is its own output; no hidden shared chunks |
| Exports map | Hand-maintained in package.json | `exports: true` — tsdown writes it from entries; zero drift |
| Platform | Implicit Node | `platform: 'neutral'` — lets browser consumers use cursor/filter |
| Root barrel | `src/index.ts` re-exports ~80 symbols | No root barrel — subpath-only |
| Sourcemaps | Off | On (essential for stack traces in downstream apps) |

### tsconfig

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "allowImportingTsExtensions": false,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "tests", "node_modules"]
}
```

Strict flags chosen for a library at the bottom of the stack — downstream mistakes surface here first.

### biome.json — inherits Google TS style

- 2-space indent
- single quotes in TS
- trailing commas = all
- import sorting on
- noExplicitAny = error
- useNodejsImportProtocol = error (forces `node:crypto` etc.)
- noDefaultExport = error (all exports named — required by no-barrel contract and by `verbatimModuleSyntax`)

### vitest — 4-tier per monorepo testing-infrastructure.md

Single `vitest.config.ts` with `projects: [unit, integration, e2e]` + `tests/smoke/` for shell-only checks. Follows the canonical template in `d:/projects/packages/testing-infrastructure.md` §2.

| Tier | Include | Timeout | Runs |
|---|---|---|---|
| **unit** | `tests/unit/**/*.test.ts` | 10 s | every commit, watch mode — pure functions, hook engine, filter builders, cursor codec |
| **integration** | `tests/integration/**/*.test.ts` | 30 s | every commit, pre-push — in-memory driver exercises full plugin stacks + scripted scenarios |
| **e2e** | `tests/e2e/**/*.test.ts` | 120 s | nightly — reserved. repo-core has no provider/network boundary; most "end-to-end" proof lives downstream in mongokit/pgkit |
| **smoke** | `tests/smoke/*.{sh,mjs}` | n/a | manual — post-publish: `node -e "import('@classytic/repo-core/hooks')"` etc. to verify the published `exports` map resolves |

**No `mongodb-memory-server`** — repo-core is driver-free. Plugin / scenario tests live in each kit (sqlitekit uses `better-sqlite3 :memory:`; mongokit uses `mongodb-memory-server`). Repo-core keeps its own suite to pure-unit coverage of hooks, Filter IR, pagination, cursor codec, operations, and URL parsing.

**Scripts (verbatim per testing doc §2):**

```json
"test":             "vitest run --project unit --project integration",
"test:unit":        "vitest run --project unit",
"test:integration": "vitest run --project integration",
"test:e2e":         "vitest run --project e2e",
"test:all":         "vitest run",
"test:watch":       "vitest --project unit --project integration"
```

### `tests/helpers/` — canonical floor

Follows testing-infrastructure.md §3. Six-file floor; each helper takes `Partial<T>` overrides, never calls `describe`/`it`, and is hoist-safe:

- `env.ts` — `requireEnv`, `hasKey` (never throws at import)
- `fixtures.ts` — `makeFilter()`, `makeContext()`, `makePluginStack()`, `makeInMemoryRepo()`
- `mocks.ts` — (not needed until we wire external services — repo-core is driver-free)
- `assertions.ts` — `expectHookOrder`, `expectFilterEqual`, `expectPriorityRespected`
- `lifecycle.ts` — (skip until integration tests share setup)
- `request.ts` — (N/A — no HTTP surface)

### Dev-time quality gates

| Tool | Command | CI gate |
|---|---|---|
| Biome | `biome ci src tests --diagnostic-level=error` | ✅ |
| tsc | `tsc --noEmit` | ✅ |
| tsdown | `tsdown` builds with `publint: 'ci-only'` + `attw: 'ci-only'` | ✅ |
| vitest | `vitest run --project unit --project integration --coverage` | ✅ |
| knip | `knip` — no dead exports allowed given the no-barrel rule | ✅ |

### package.json outline

```jsonc
{
  "name": "@classytic/repo-core",
  "version": "0.1.0",
  "description": "Driver-agnostic repository primitives: hooks, Filter IR, operations, pagination, portable plugins",
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "exports": "<filled by tsdown exports: true>",
  "dependencies": {
    "@classytic/datakit-types": "^0.1.0"
  },
  "peerDependencies": {},
  "devDependencies": {
    "@arethetypeswrong/cli": "^0.18.2",
    "@biomejs/biome": "^2.4.10",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^3.2.4",
    "knip": "^6.3.0",
    "publint": "^0.3.18",
    "tsdown": "^0.21.8",
    "typescript": "^5.7.0",
    "vitest": "^3.2.4"
  }
}
```

## 6. Migration plan (mongokit → repo-core + mongokit v4)

### Phase 0 — scaffold (follows testing-infrastructure.md §10 checklist) — ☑ **2026-04-19**

- [☑] Create `d:/projects/packages/repo-core/` with tsconfig, tsdown, biome, vitest, package.json
- [☑] `tests/helpers/` floor: `env.ts`, `fixtures.ts`, `assertions.ts`
- [☑] `tests/unit/` smoke spec passing (4 tests, 3 ms runtime)
- [☑] Green `npm run build` — emits `dist/hooks/index.mjs` + `dist/hooks/priority.mjs` with matching `.d.mts`
- [☑] Green `npm test` (unit + integration projects discovered by vitest; integration empty, as designed)
- [☑] Green `npm run check` (biome) + `npm run typecheck` (src + tests)
- [☑] `npm pack --dry-run` — 10 files, 3.6 kB, subpath `./hooks` resolves to `.mjs`/`.d.mts`
- [☑] No `any` anywhere; no `.skip` anywhere
- [☑] Fast-suite budget: full `npm test` runs in 701 ms (well under the 30 s dev-laptop budget)

**Decisions settled during M0 that were not in the pre-plan:**

- `tsdown.exports: true` was rejected — it collapses a single-entry package to a `"."` root export, violating the no-root-barrel rule. Exports are hand-maintained in `package.json` instead.
- Added `fixedExtension: true` to emit `.mjs` / `.d.mts` (house style alignment with mongokit).
- Added `outputOptions.preserveModules: true` + `preserveModulesRoot: 'src'` so the `dist/` tree mirrors `src/` exactly (otherwise rolldown hoists adjacent files to dist root when a single entry's folder becomes the common root).
- Added `tsconfig.test.json` so test files + config files get typechecked with the same strictness as src without including them in the build's `rootDir`.

### Phase 1 — lift pure primitives (no semantic changes) — ☑ **2026-04-19**

- [☑] Port `OP_REGISTRY` + `PolicyKey` → `src/operations/` as `CORE_OP_REGISTRY` + `extendRegistry`
- [☑] Port `HOOK_PRIORITY` constants → `src/hooks/priority.ts` (landed in M0)
- [☑] Port `createError` / `HttpError` → `src/errors/`; Mongo-11000 predicate stays in mongokit
- [☑] Added `conservativeMongoIsDuplicateKey` + `IsDuplicateKeyErrorFn` contract + `toDuplicateKeyHttpError` (generic 409 envelope from pre-extracted meta)
- [☑] Port cursor codec → `src/pagination/cursor.ts`; URL-safe base64 (RFC 4648 §5), decodes legacy standard-base64 for mongokit ≤3.x cursor compat, driver-free `tagValue` extension point
- [☑] Port `normalizeSort` / `validateKeysetSort` / `invertSort` / `getPrimaryField` → `src/pagination/keyset.ts`
- [☑] Port `validateLimit` / `validatePage` / `shouldWarnDeepPagination` / `calculateSkip` / `calculateTotalPages` → `src/pagination/offset.ts`

**Decisions settled during M1:**

- **Core op registry narrower than mongokit's** — drops `aggregate`, `aggregatePaginate`, `lookupPopulate`, `bulkWrite`. Those are Mongo-specific and kits add them via `extendRegistry(CORE_OP_REGISTRY, { ... })`. Core has 17 ops.
- **`RepositoryOperation` is open** — `CoreRepositoryOperation | (string & {})` so kits can add ops without being listed in the core union.
- **Cursor codec is extensible via `tagValue` callback** — kits that need typed id rehydration (`'objectid'` → `ObjectId`) pass their own tagger on `encodeCursor` and post-process on decode. Unknown tags round-trip as strings rather than throwing, which preserves compat with mongokit ≤3.x cursors.
- **`biome.useLiteralKeys` disabled** — it conflicts with TS `noPropertyAccessFromIndexSignature`. TS strictness wins; biome rule turned off.
- **Value-type union trimmed** — repo-core knows only `date | boolean | number | string | null | unknown`. `objectid` / `uuid` tags are kit-owned.
- **Zero driver deps confirmed** — `TextEncoder`/`TextDecoder`/`btoa`/`atob` are used for base64url (Node 22+ and browsers). No `Buffer`, no `mongoose`, no `mongodb` anywhere in src.

### Phase 2 — Filter IR (the one big new thing)
- [ ] Design + implement `Filter` union types and combinator API (`eq`, `and`, `in_`, ...) with exhaustive tests
- [ ] Implement `walkFilter` / `mapFilter` used by policy plugins to inject scope nodes
- [ ] Implement `matchFilter(doc, filter)` for in-memory testing driver (and Arc's default `matchesFilter` replacement)
- [ ] Write compat shim spec: "raw `$`-objects roundtrip through walk unchanged" — proves kits can accept legacy filters

### Phase 3 — abstract base class
- [ ] Port hook registry + `_buildContext` from mongokit `Repository.ts` → `repo-core/src/repository/base.ts` as `abstract class RepositoryBase<TDoc>`
- [☑] Port `PLUGIN_ORDER_CONSTRAINTS` + `validatePluginOrder` → `src/repository/plugin-types.ts` (co-located with `Plugin` / `PluginType` — no separate `validate-order.ts`)
- [ ] No CRUD methods on base class — only hook plumbing

### Phase 4 — portable plugins
Port each, rewriting their filter-injection code to emit Filter IR instead of `$`-objects:
- [ ] `timestamp` (no filter work — already portable)
- [ ] `multi-tenant`
- [ ] `soft-delete`
- [ ] `validation-chain`
- [ ] `field-filter`
- [ ] `audit-log` + `audit-trail` (merged if semantics match)
- [ ] `observability`
- [ ] `cache` (abstract `CacheAdapter` — host wires Redis/in-mem)
- [ ] `cascade`

### Phase 5 — query-parser front-end
- [ ] Port URL bracket grammar + scalar coercion + sanitize rules
- [ ] Output is `ParsedQuery<Filter>` with Filter IR — not Mongo `$`-objects
- [ ] Sweep mongokit's advanced features (lookup parsing, aggregation parsing) — **do not port** (Mongo-only; stays in mongokit's subclass parser)

### Phase 6 — mongokit v4 refactor
- [ ] `Repository` → `class Repository<TDoc> extends RepositoryBase<TDoc>`
- [ ] Add `compileFilter(ir) → MongoFilter` with `$`-passthrough for legacy inputs
- [ ] Keep Mongo-only surfaces: `aggregate`, `aggregatePaginate`, `lookupPopulate`, `buildAggregation`, `buildLookup`, `mongoOperationsPlugin`, `batchOperationsPlugin`, `elasticPlugin`, `subdocumentPlugin`, `aggregateHelpersPlugin`
- [ ] **No re-exports of repo-core symbols from mongokit.** Consumers import `HOOK_PRIORITY` etc. directly from `@classytic/repo-core/hooks`
- [ ] Keep mongokit's public method signatures byte-stable (catalog's `extends Repository<ProductDocument>` must still compile)

### Phase 7 — arc refactor
- [ ] Arc depends on `@classytic/repo-core`
- [ ] `RepositoryContext`, `HOOK_PRIORITY`, `OP_REGISTRY`, `PaginationResult`, `Filter` imports move to repo-core
- [ ] Arc's built-in `QueryParser` emits `ParsedQuery<Filter>`
- [ ] Arc's default `matchesFilter` uses `repo-core/filter.matchFilter` — no more "MongoDB-style" caveat
- [ ] `RepositoryLike` stays structural in arc (escape hatch for non-kit repos)

### Phase 8 — catalog migration
- [ ] Update ~20 import sites (mapped in [catalog migration table](#catalog-migration-table) below)
- [ ] Run catalog test suite — green = done
- [ ] No mongokit API surface changes, only import paths

### Phase 9 — pgkit
- [ ] New package `@classytic/pgkit`
- [ ] Depends on `@classytic/repo-core` + `pg` (or `kysely`)
- [ ] Implements `RepositoryBase` with SQL `INSERT/UPDATE/DELETE ... RETURNING`
- [ ] Ships `compileFilter(ir) → SqlFragment`
- [ ] `isDuplicateKeyError` → checks `23505`

### Phase 10 — prismakit promotion
- [ ] Current `@classytic/prismakit` stub (`0.0.0-test`) refactors onto `repo-core`
- [ ] `compileFilter(ir) → Prisma.WhereInput`
- [ ] `findOneAndUpdate` → `$transaction([findFirst, update])`
- [ ] `isDuplicateKeyError` → checks `P2002`

## 7. Catalog migration table

Quick reference for catalog's 17 affected files once Phase 6 lands. **Only import paths change — symbol names stable.**

| From | To | Files affected |
|---|---|---|
| `import { HOOK_PRIORITY } from '@classytic/mongokit'` | `from '@classytic/repo-core/hooks'` | `search-projection.plugin.ts` |
| `import type { Plugin, RepositoryContext, RepositoryInstance, PluginType } from '@classytic/mongokit'` | `from '@classytic/repo-core/repository'` (or `/plugins`, `/context`) | `search-projection.plugin.ts`, all 4 repositories, 2 factories |
| `import { Repository, mongoOperationsPlugin } from '@classytic/mongokit'` | **unchanged** | 4 repositories, `create-catalog.ts` |
| `import type { CreateOptions, UpdateOptions, DeleteResult, SessionOptions } from '@classytic/mongokit'` | **unchanged** (Mongo-specific option shapes) | 4 repositories |

## 8. Decisions (formerly open questions — resolved)

- [☑] **`RepositoryBase` lives in repo-core** — tightly coupled to hook + context + plugin-order primitives. Ships from `@classytic/repo-core/repository`.
- [☑] **Filter IR is a tagged union** — `{ op: 'eq', field, value }`. Simple pattern matching, easy to walk, kit compilers dispatch on `.op`.
- [☑] **Cursor version pinning kept** — `cursorVersion` + `minCursorVersion` round-trip through the payload. Hosts treat cursors as opaque; each kit's tagger handles type rehydration.
- [☑] **`CacheAdapter` interface** — `get / set / del / delByPattern?`. Sync OR async return values both accepted. Ships from `@classytic/repo-core/cache` (type + `stableStringify` + `createMemoryCacheAdapter`). Each kit composes it into its own `cachePlugin`.
- [☑] **No testing harness in repo-core.** Each kit tests against its real driver (mongokit → mongodb-memory-server, sqlitekit → better-sqlite3 :memory:). A generic in-memory harness would be a third thing to maintain that nobody uses — kits already have integration tests that prove the full stack.

## 9. Non-goals

- Porting Mongo-specific builders (`AggregationBuilder`, `LookupBuilder`)
- Porting Mongo-specific plugins (`elastic`, `mongo-operations`, `batch-operations`, `subdocument`, `aggregate-helpers`)
- Shipping a universal ORM — this is a repository-contract layer, not a query builder
- Supporting CJS — ESM only; consumers on CJS can use a bundler
- Back-compat with mongokit ≤3.9 via re-exports from repo-core — clean cut, catalog updates imports

## 10. Milestones & status

| Milestone | Status | Target | Notes |
|---|---|---|---|
| M0 — scaffold | ☑ 2026-04-19 | — | build+test green; `hooks` subpath ships with `HOOK_PRIORITY` |
| M1 — primitives ported | ☑ 2026-04-19 | — | operations, errors, cursor, keyset, offset. 4 new subpaths, 70 new unit tests |
| M2 — Filter IR | ☑ 2026-04-19 | — | types + 16 combinators + walk + match + guard. 43 new tests. Boolean absorbing/identity elimination |
| M2.5 — MinimalRepo contract | ☑ 2026-04-19 | — | `@classytic/repo-core/repository` subpath; arc-aligned 5-method floor + StandardRepo extensions |
| sqlitekit — first driver kit | ☑ 2026-04-19 | — | `@classytic/sqlitekit` scaffold + driver + SQL compiler + repository. 38 tests against real in-memory SQLite |
| Package upgrades | ☑ 2026-04-19 | — | vitest 4.1, typescript 6.0, biome 2.4.12 (better-sqlite3 stays at 11 — v12 lacks Node 22 Win prebuilds) |
| Filter IR expansion | ☑ 2026-04-19 | — | sugar builders (between, startsWith, endsWith, contains, iEq, isNull, isNotNull) + `raw` escape hatch |
| M5 — QueryParser (partial) | ☑ 2026-04-19 | — | `@classytic/repo-core/query-parser` — URL → `ParsedQuery<Filter>`. Shared contract for mongokit / sqlitekit / pgkit + arc-next / fluid. Mongo-specific lookup/aggregation still in mongokit's parser |
| sqlitekit rich surface | ☑ 2026-04-19 | — | findOneAndUpdate, updateMany, deleteMany, upsert, increment, aggregate, distinct, withTransaction, isDuplicateKeyError, migrator (up/down/status/latest) |
| M3 — RepositoryBase | ☑ 2026-04-19 | — | abstract class + `HookEngine` + plugin-order validator + `_cachedValue` helper + `listeners()` snapshot (read-through for kits with legacy `_hooks` surface). `_buildContext` always awaits before-hooks regardless of `hooks` mode — policy plugins must mutate context synchronously before the driver call. SqliteRepository + mongokit 3.10 both extend it. |
| M4 — portable plugins | ☑ 2026-04-19 | — | **5 plugins shipped** — timestamp, multi-tenant, soft-delete, audit, cache. Filter-IR-native. Skipped observability / validation-chain / field-filter / cascade / custom-id. |
| M4.1 — plugins moved out of repo-core | ☑ 2026-04-19 | — | All 5 plugins relocated into each kit (sqlitekit owns its copies; mongokit already had Mongo-optimized versions). Repo-core now ships plugin **primitives** only: `CacheAdapter` + `stableStringify` + `createMemoryCacheAdapter` at `/cache`, `buildTenantScope` + `mergeScope` at `/filter`. Rationale: users install one kit, not repo-core directly — plugins belong in the namespace users actually import. Each kit's plugin can use driver-native features (mongoose native timestamps, SQLite triggers, Postgres `now()`, Prisma `@default`) that a generic plugin can't. |
| Bound-tx fix | ☑ 2026-04-19 | — | `withTransaction(fn)` hands back a tx-bound repo (was leaking mongoose-style session threading). `bindToDriver` primitive for cross-repo atomic composition. |
| M5 — query-parser | ☑ (partial) 2026-04-19 | — | Driver-agnostic URL → `ParsedQuery<Filter>` in repo-core. Mongo-specific lookup/aggregation parsing stays in mongokit. |
| M5.1 — QueryParser class + sqlitekit wiring | ☑ 2026-04-19 | — | Class-form `QueryParser` in repo-core (options held once, `.parse()` per request — mongokit shape). `@classytic/sqlitekit/query-parser` ships `SqliteQueryParser extends QueryParser` with Drizzle-table introspection → auto `fieldTypes`. **URL grammar identical across kits** — frontend emits one URL, mongokit / sqlitekit / (future) pgkit / prismakit each translate to native filter syntax. Mongokit keeps its existing 1789-line parser (lookup + aggregation + Mongoose schema); future v4 refactor delegates the common path to repo-core's class. 28 new sqlitekit unit tests cover grammar parity + Drizzle coercion. |
| M6 — mongokit 3.10 | ☑ 2026-04-19 | — | `Repository extends RepositoryBase`. Hook engine + plugin-order validator + `HOOK_PRIORITY` re-sourced from repo-core. `_buildContext` inherits (always-await before-hooks fix applied in base). Public API byte-stable with 3.9; 1838/1842 integration tests green, 104/104 unit tests. Cursor codec + error helpers deliberately left in mongokit — migration deferred since `compileFilter` isn't required for this minor bump. |
| M6.5 — mongokit v4 (compileFilter) | ☐ not started | | Full Filter-IR passthrough, cursor codec via repo-core, drop Mongo-specific `$`-input from hot path |
| M7 — arc refactor | ☐ not started | | depends on repo-core |
| M8 — catalog migration | ☐ not started | | import-path sweep |
| M9 — pgkit | ☐ not started | | new package |
| M10 — prismakit promotion | ☐ not started | | refactor off stub |

## 11. Operating notes (how to update this doc)

- When a milestone flips to in-progress, change `☐` → `◐` and add date.
- When done, `☐` → `☑` + date + PR link.
- If a decision in §8 lands, move its resolution under the relevant section and cross-reference here.
- If a phase reveals scope creep, update §1 scope before writing any new code.
- Keep this file under 500 lines. If it grows, split per-phase logs into `docs/phase-N-log.md` and link from here.
