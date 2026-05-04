# CLAUDE.md — AI maintainer guidance for `@classytic/repo-core`

Read this when opening this repo. `repo-core` is the **contract source-of-truth** for every kit (mongokit, sqlitekit, future pgkit / prismakit). Every type here is load-bearing — kits and arc consume them by structural assignment.

**Position in the stack:**
```
arc (HTTP routing) ──► RepositoryLike ──► StandardRepo<TDoc> (this package)
                                              ▲
                                              │ structural conformance (typecheck:tests gate)
                                              │
                       mongokit ──┬─ sqlitekit ──┬─ future pgkit
                                  ▼              ▼
                              implements StandardRepo<TDoc>
```

## The one thing you must not do

**Do not narrow an existing type, rename an existing field, or remove an existing method from `StandardRepo<TDoc>` / `MinimalRepo<TDoc>` without coordinating across mongokit + sqlitekit and bumping the major version.**

Every kit's `npm run typecheck:tests` runs a structural-assignment gate against the current published types. Narrowing here breaks every consumer's build at once. Additive changes (new optional field, new union member, new opt-in capability) are safe.

## Versioning rules

| Change | Severity | Required dance |
|---|---|---|
| New optional field on a contract type | Patch — additive | Land in repo-core, rebuild, sync to kits, kits adopt at leisure |
| New required field | **Breaking** | Major bump + coordinated kit releases |
| New union member on `AggMeasure` / `Filter` | Patch (kits handle unknown ops via runtime throw) | Each kit adds a `case` arm or a single throw branch |
| Rename a public type/field | **Breaking** | Major bump + ecosystem migration |
| New asymmetric op (some kits unsupported) | Additive | Add to IR, add `AggregateOpsSupport` flag, kits declare false unless implemented |

When in doubt, search arc + every kit for type uses before you change a signature. Grep is your friend.

## Conformance harness — the cross-kit truth

`src/testing/conformance.ts` is the canonical contract test suite. **Every kit runs it** against its own backend. When both kits stay green for the same scenario set, "swap mongokit for sqlitekit" is provable.

### Adding a new scenario

1. Pick a `describe('feature')` block (or add a new one)
2. Use the `it.skipIf(skipNoX)` gate helpers at the top of `runStandardRepoConformance` — never hardcode `harness.features.X` inline (centralizes the gate logic, scannable at a glance)
3. Reference `harness.makeDoc({...})` for fixtures — never construct kit-specific doc shapes inline
4. Read ids via `harness.idField` (`'_id'` on mongokit, `'id'` on sqlitekit)
5. For asymmetric features, add a flag to `ConformanceFeatures.aggregateOps` (or a new sub-matrix) — see "Asymmetric ops" below

### Asymmetric ops — the `AggregateOpsSupport` pattern

When a kit can't implement an op (e.g. SQLite has no native percentile), **don't shoehorn an approximation**. The pattern:

1. **Repo-core IR**: add the op to the union with JSDoc noting per-kit support
2. **`AggregateOpsSupport`** in `src/testing/types.ts`: add `<op>?: boolean` flag (optional, defaults to `false` — kits opt INTO support)
3. **Conformance gate helper** at top of `runStandardRepoConformance`: `const skipNoX = !aggGate || !ops?.X`
4. **Conformance scenarios**: `it.skipIf(skipNoX)('does X correctly', ...)` and `it.skipIf(skipNoX)('throws on bad input', ...)`
5. **Each kit's harness**: declare `aggregateOps: { X: true|false }` with a one-line rationale comment (cite the SQL/Mongo function, the version requirement, or the reason for not supporting)
6. **Kit that doesn't support it**: throw `'<kit>/<surface>: \'<op>\' op is not supported on <kit> — <where to go instead>'` — never silently ignore. Test the throw shape in the kit's unit test (not the conformance suite — gated, won't run there).

The current asymmetric op is `percentile`. Patterns to mimic when adding more.

## Build + dist sync (workspace dev)

This is a published package; consuming kits resolve `@classytic/repo-core` from npm at install time. **Local dev** uses workspace copies — when you change a type here, the kits' `node_modules/@classytic/repo-core/dist/` is stale until you rebuild AND sync:

```bash
npm run build
cp -r dist/* ../mongokit/node_modules/@classytic/repo-core/dist/
cp -r dist/* ../sqlitekit/node_modules/@classytic/repo-core/dist/
```

If a kit suddenly errors on a type that's clearly there, this is almost always why. Build + sync first, then debug.

## Releases

See `RELEASING.md` (in the workspace root or this package). Non-negotiable:
1. `npm run typecheck` (src + test config)
2. `npm run build` (declaration emit)
3. `npm test`
4. Bump `package.json` version
5. CHANGELOG entry
6. Stage ONLY relevant files — repo often has in-flight work
7. NO `Co-Authored-By: Claude` trailer
8. After publish: kits re-resolve via `npm install @classytic/repo-core@latest` (or workspace bump)

## Recipes

### Designing a new IR addition

Walk through this checklist when adding to `AggRequest` / `AggMeasure` / similar:

1. **Is this portable?** If not (mongo-only or SQL-only), it doesn't belong in the IR — kits expose it via their native escape hatch (`aggregatePipeline` / raw Drizzle).
2. **Cross-kit output shape?** Pick the shape both kits can emit identically. Pin it in the JSDoc. (Example: date-bucket labels are canonical ISO strings — `'2026-04'` not `Date(2026, 3, 1)`.)
3. **Composition with existing slots?** Filter, having, sort, limit, lookups, dateBuckets — every new slot must compose cleanly with the others. Document the order of evaluation.
4. **Validation?** Compile-time-checkable mistakes (unknown column refs, malformed limit, alias collisions) throw with the bad value named in the message. Never silently produce wrong output.
5. **Asymmetric?** Add `AggregateOpsSupport` flag. Document the kit-by-kit support matrix in the JSDoc.
6. **Conformance scenarios?** At least 2 — "does the right thing" + "throws on the obvious wiring bug".

### When to add a new measure op vs extend an existing one

- **New op** (`{ op: 'newName', field, ... }`): when the SQL/Mongo equivalent is a distinct function (e.g. `percentile`, `stddev`, `median`).
- **Extension** (new field on an existing op): when the op is the same primitive but with a knob (e.g. `where` on every measure adds filtered-aggregation behaviour, doesn't change the op identity).

Filtered measures (`where: FilterInput`) was the right extension. `percentile` is a new op. The line: if the kit-native function name changes, it's a new op.

### Aggregate cache layer (`aggregate-cache/`)

The per-request cache layer is a thin orchestrator over the generic `CacheAdapter` contract — split deliberately:

| Concern | Lives where | Why |
|---|---|---|
| KV transport (`get`/`set`/`delete`/`clear`) | `cache/types.ts` (CacheAdapter) | One adapter, every consumer |
| Stable key derivation (FNV-1a + `stableStringify`) | `aggregate-cache/key.ts` | Cache key MUST exclude `cache` slot itself + `executionHints` (don't change result) |
| Envelope (data + storedAt + tags) | `aggregate-cache/types.ts` | Schema-versioned via `v: 1` for forward-compat |
| SWR + bypass + tag-index logic | `aggregate-cache/engine.ts` | Pure orchestrator, no adapter introspection |
| Per-request opt-in (`AggCacheOptions`) | `repository/types.ts` (in `AggRequest.cache`) | Per-call ergonomics — different tiles want different TTLs |
| Constructor wiring + `invalidateAggregateCache()` | Each kit's `Repository` class | Adapter is repo-scoped, not request-scoped |

**Critical invariants** (don't break these without coordinating across kits):

1. **Cache key derives from POST-POLICY `finalReq`**, not the raw caller `req`. Multi-tenant scope + soft-delete predicates must be part of the hash, otherwise the same key serves data across tenants → cache poisoning. Both kits compute `finalReq` first then call `buildAggCacheKey(modelName, finalReq)`.
2. **Adapter TTL ≠ logical TTL** when SWR is enabled. The engine stores entries for `ttl + staleTime` at the adapter level so the adapter doesn't expire them before the engine can serve them stale. The envelope's `ttl` field is the logical TTL the engine compares against `Date.now() - storedAt`.
3. **Tag index is best-effort** (not transactional). Two concurrent writes can race on the index array; the loser's entry won't be tag-invalidated until natural TTL expiry. Adapters that need strict consistency (Redis with WATCH/MULTI) override the engine's helpers — out-of-scope for the default path.
4. **Bypass overwrites the cached entry** (not just skips the read). A "Refresh" button must populate the cache for the NEXT non-bypass reader; otherwise every user clicks Refresh and the cache never warms.

### Filter IR usage in new IR slots

Reuse `FilterInput = Filter | Record<string, unknown>`. Both kits' `recordToFilter` normalizes plain records, so callers can pass either. **Never invent a parallel filter shape** — that's how IRs fragment.

For predicates that compile to **expression form** (inside `$cond` / `$expr` on Mongo, inside `FILTER (WHERE ...)` on SQL), document the boundary clearly. Mongokit ships two compilers: `compileFilterToMongo` (query/$match form) and `compileFilterToMongoExpr` (expression form). They're not interchangeable.

## Do not

- Add runtime imports to the `testing/` subpath at the package level — vitest is a peer dep there, gated by JSDoc warning
- Mix kit-specific types into repo-core ports (e.g. don't import `mongoose.ClientSession` here; use opaque `RepositorySession = unknown`)
- Land "TODO: implement on sqlitekit later" stubs — design the asymmetric-op pattern (see above) and ship per-kit honest support
- Bake host-side concerns (caching, observability, audit) into IR types — those compose via plugins / hooks, not contract surface
- Add AI attribution (`Co-Authored-By: Claude ...`) to git commits in this workspace
