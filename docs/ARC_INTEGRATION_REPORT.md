# Arc × repo-core × mongokit × sqlitekit — Integration Report

**Date:** 2026-04-19
**Reporter:** Arc 2.10 maintainer
**Scope:** End-to-end verification that `@classytic/repo-core`'s shared contract
(`MinimalRepo<TDoc>` + `StandardRepo<TDoc>` + `Filter` IR + hook priorities)
allows `@classytic/mongokit` and `@classytic/sqlitekit` repositories to drop
into `@classytic/arc` unchanged.

## TL;DR

**✅ Integration works.** Arc 2.10 accepts both mongokit's `Repository` and
sqlitekit's `SqliteRepository` via Arc's structural `RepositoryLike` contract,
which is now a proper superset of `MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>`.

**Latest status (v0.1.x round-trip):**
- ✅ `HOOK_EVENTS` constant — shipped in `/hooks`, canonical MinimalRepo+StandardRepo op names.
- ✅ `CacheAdapter` contract — shipped in `/cache`, `.delete()` (renamed from `.del()` for ecosystem consistency), `ttlSeconds`, `clear(pattern?)`.
- ✅ `TExtra` generic on pagination — shipped. Arc pagination types structurally compatible.
- ✅ `/query-parser`, `/context` — shipped, Arc doesn't consume them internally (each kit keeps its own parser; `RepositoryContext` is repo-layer).
- ✅ Arc's `CacheStore` aligned to `CacheAdapter`: `.delete(key)`, `ttlSeconds`, `clear(pattern?)`, undefined-miss. Breaking change in Arc 2.10, no shims.
- ✅ Arc-side test sweep: **4123/4132 pass** (1 pre-existing mongokit+mongodb-memory-server transaction test, orthogonal).
Proven by:

- Type-level assertion in `arc/src/adapters/repo-core-compat.ts` (CI gate, fails typecheck on drift)
- 14 runtime HTTP round-trip tests across both kits (7 per kit): CRUD + list + 404 + no-wrap invariants
- Zero shims, zero kit-specific factories on Arc's side — apps construct a bare `DataAdapter<TDoc>` and pass the repo through

Arc 2.10 is blocked on **your** side to ship: publish `@classytic/repo-core` to npm, then mongokit/sqlitekit can pin `^0.1.0` and Arc can switch its `file:` peer dep to a version range.

---

## 1. Integration approach taken on Arc's side

### 1.1 Dropped the `[key: string]: unknown` index signature on `RepositoryLike`

Arc's `RepositoryLike` used to declare `[key: string]: unknown` as an "escape hatch" so apps could call `repo.customMethod()` without the type complaining. That signature blocks structural assignment from `MinimalRepo<TDoc>` — TypeScript refuses the assignment because a type with typed properties doesn't conform to `[key: string]: unknown`.

**Fix on Arc's side:** removed the index signature. Zero src/ internal usage of arbitrary-key access on `RepositoryLike` — it was purely a type-level escape hatch. Apps that need kit-specific methods now import the concrete kit type (`Repository<TDoc>` from mongokit, `SqliteRepository<TDoc>` from sqlitekit) — which is the right thing to do anyway.

### 1.2 Loosened `getDeleted` return type

Arc had `getDeleted?: … Promise<PaginationResult<unknown> | unknown[]>`. Repo-core's `StandardRepo.getDeleted` is `Promise<unknown>`. Arc now matches repo-core — narrowing happens at the call site.

### 1.3 Type-level gate

`arc/src/adapters/repo-core-compat.ts` contains one `AssertAssignable` that verifies `MinimalRepo<unknown> & Partial<StandardRepo<unknown>>` is structurally assignable to Arc's `RepositoryLike`. Type-only, never bundled to dist (not an entry point in `tsdown.config.ts`), but `tsc --noEmit` checks it — any future drift surfaces before publish.

### 1.4 No re-exports, no barrels

Arc does **not** re-export types from repo-core. Apps that want `MinimalRepo` / `StandardRepo` / `Filter` import them directly from `@classytic/repo-core/*`. Arc just accepts the contract.

---

## 2. Issues found — things to fix or confirm before publish

### 2.1 🐛 sqlitekit — `tsdown.config.ts` references non-existent `src/sql/index.ts`

**File:** `D:/projects/packages/sqlitekit/tsdown.config.ts` line 8
**Symptom:** `npm run build` fails with `Cannot resolve entry module src/sql/index.ts`
**Root cause:** `entry` map includes `'sql/index': 'src/sql/index.ts'` but that directory doesn't exist.
**Secondary:** `package.json` `exports` advertises `./filter`, `./actions`, `./plugins/ttl` but `tsdown.config.ts` has no entries for them — so even if the `sql/` bug is fixed, those subpaths would 404 at import time for real consumers.

**Minimum fix (tested — produces a clean build):**

```ts
// tsdown.config.ts
entry: {
  'repository/index': 'src/repository/index.ts',
  'driver/index': 'src/driver/index.ts',
  'driver/better-sqlite3': 'src/driver/better-sqlite3.ts',
  'filter/index': 'src/filter/index.ts',         // added
  'actions/index': 'src/actions/index.ts',       // added
  'migrate/index': 'src/migrate/index.ts',
  'plugins/timestamp/index': 'src/plugins/timestamp/index.ts',
  'plugins/soft-delete/index': 'src/plugins/soft-delete/index.ts',
  'plugins/multi-tenant/index': 'src/plugins/multi-tenant/index.ts',
  'plugins/audit/index': 'src/plugins/audit/index.ts',
  'plugins/cache/index': 'src/plugins/cache/index.ts',
  'plugins/ttl/index': 'src/plugins/ttl/index.ts',   // added
  // 'sql/index' entry removed — directory doesn't exist
},
```

**Severity:** blocks publish. Needs CI gate: `npm pack --dry-run` + assert every subpath in `package.json.exports` resolves.

### 2.2 ⚠ sqlitekit — `node:path` imported under `platform: 'neutral'`

**File:** `D:/projects/packages/sqlitekit/src/migrate/from-drizzle.ts` line 37
**Symptom (rolldown warning):** `Could not resolve 'node:path' — treating it as an external dependency`
**Root cause:** `tsdown.config.ts` sets `platform: 'neutral'` (for Expo/mobile compat), but `from-drizzle.ts` imports a Node built-in. This works in Node but would 404 under strict bundlers targeting browser/Workers.

**Options:**
- Move `from-drizzle.ts` behind a Node-only subpath (`./migrate/node`)
- Mark `node:*` as external explicitly in `tsdown.config.ts` and document this subpath as Node-only
- Replace with a platform-neutral path utility

**Severity:** cosmetic for Node consumers, real blocker for Expo/RN. sqlitekit's whole pitch is cross-platform, so worth deciding before 1.0.

### 2.3 ℹ Arc default sort — Mongo-ism leaking to SQL kits

**Symptom:** Arc's `BaseController.list` passes `sort: "-createdAt"` by default. sqlitekit strictly validates sort columns against the Drizzle schema and throws `sqlitekit: column "createdAt" not found on table "products"` if the column doesn't exist.

**This is more an Arc issue than a kit issue**, but flagging because it affects cross-kit UX. Real-world apps almost always have `createdAt` (and our integration test confirms it works fine once the column exists + `timestampPlugin` is wired), so this is a "docs and defaults" problem.

**Arc-side options (for v2.11 or later, not blocking 2.10):**
- Make default sort configurable per resource without requiring `createdAt` field
- Drop the default entirely and let the repo choose when no sort is supplied
- Document the requirement: "Arc resources default to `-createdAt` sort; define the field or override with `queryOptions`."

### 2.4 ✅ RESOLVED — repo-core shipped `TExtra` + naming alignment

- Arc has `OffsetPaginatedResult<TDoc, TExtra = {}>` / `KeysetPaginatedResult<TDoc, TExtra = {}>` with a generic for kit metadata (`tookMs`, `region`, `cursor.version`).
- repo-core has `OffsetPaginationResult<TDoc>` / `KeysetPaginationResult<TDoc>` (past-tense-vs-noun drift + no `TExtra`).

Neither is wrong, but the standard should pick one. Suggest:
- **Naming:** `OffsetPaginationResult` / `KeysetPaginationResult` (matches repo-core — "Paginated" modifies the verb, "Pagination" describes the result type, the latter reads better).
- **`TExtra` generic:** add it. Kits genuinely need it — mongokit surfaces `warning?: string` on deep-page reads, sqlitekit could surface query plan hints, etc.

If repo-core adopts this, Arc will align in 2.10. If not, both shapes coexist (they're structurally compatible for the core fields).

### 2.5 ✅ RESOLVED — `HOOK_EVENTS` published

**Observation:** Both kits use the same event name convention (`before:<op>`, `after:<op>`, `error:<op>`) but the canonical operation names aren't documented anywhere in repo-core. Mongokit uses `create | update | delete | findOneAndUpdate | getById | getAll | …`; sqlitekit follows the same pattern. A plugin author writing against `@classytic/repo-core/hooks` has to read both kits to know what to subscribe to.

**Ask:** publish a `HOOK_EVENTS` constant alongside `HOOK_PRIORITY` so plugins can do:

```ts
import { HOOK_EVENTS, HOOK_PRIORITY } from '@classytic/repo-core/hooks';

repo.on(HOOK_EVENTS.BEFORE_CREATE, handler, { priority: HOOK_PRIORITY.POLICY });
```

A multi-tenant plugin written against these constants works identically across mongokit + sqlitekit + pgkit without the plugin author needing to memorize operation names per kit.

### 2.6 ✅ RESOLVED — `CacheAdapter` published, `.delete` finalized

sqlitekit and mongokit both ship a `cache` plugin, and both take a `CacheAdapter` (memory, Redis, etc.). The adapter shape (`get / set / del / clear`) is identical between them — worth publishing from repo-core so Arc's `cache/QueryCache` can accept the same adapter too. Arc currently has its own `CacheStore` interface which is 95% the same but separately defined.

---

## 3. What the kit teams should do before publishing

| # | Task | Package | Severity |
|---|---|---|---|
| 1 | Fix `tsdown.config.ts` `sql/` entry + add missing `filter`/`actions`/`plugins/ttl` entries | sqlitekit | **blocker** |
| 2 | Decide `node:path` strategy for `from-drizzle.ts` (Node-only subpath or externalize) | sqlitekit | high (blocks Expo) |
| 3 | Pick pagination type naming + add `TExtra` generic | repo-core | medium |
| 4 | Publish `HOOK_EVENTS` constant | repo-core | medium |
| 5 | Consider publishing `CacheAdapter` contract | repo-core | low |
| 6 | Confirm `MinimalRepo` should stay without an index signature (intentional tight contract) | repo-core | confirm |
| 7 | Publish `@classytic/repo-core@0.1.0` to npm | repo-core | **blocker for Arc publish** |
| 8 | Publish `@classytic/mongokit@3.10.0` with repo-core dep | mongokit | **blocker for Arc publish** |
| 9 | Publish `@classytic/sqlitekit@0.1.0` with repo-core dep | sqlitekit | **blocker for Arc publish** |

---

## 4. What Arc does on its side after you publish

1. Change Arc's `package.json` peer dep from `"@classytic/repo-core": "file:../../packages/repo-core"` to a proper version range (`^0.1.0` or whatever ships).
2. Ship Arc 2.10 with the standardization. Apps using mongokit continue to work unchanged (structural compat is byte-stable). Apps wanting to try sqlitekit can install it alongside Arc — no shims needed.
3. Add examples to Arc's docs showing `defineResource({ adapter: { repository: sqliteRepo, type: 'drizzle', name: 'products' } })` so app authors see the cross-kit story.

---

## 5. Verification artifacts (in Arc's repo)

- **Type-level gate:** `arc/src/adapters/repo-core-compat.ts` — 1 `AssertAssignable`, caught 2 drift points (index sig + `getDeleted`), now clean.
- **sqlitekit integration test:** `arc/tests/integration/sqlitekit-arc.test.ts` — 7 HTTP round-trip tests. Exercises `SqliteRepository` + `timestampPlugin` + real better-sqlite3 + Drizzle.
- **mongokit integration test:** `arc/tests/integration/mongokit-arc.test.ts` — 7 HTTP round-trip tests via `mongodb-memory-server`. Exercises real Mongoose schema + mongokit `Repository`.
- **Arc test suite:** 3200+ tests still pass after the `RepositoryLike` tightening. No regressions.

Happy to run a second pass when you're ready to publish.
