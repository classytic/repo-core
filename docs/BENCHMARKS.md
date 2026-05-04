# `@classytic/repo-core` cache-layer benchmarks

Hot-path latency measurements for the unified cache layer at
`src/cache/`. Numbers are illustrative — they describe the engine's
own overhead on top of the in-memory adapter, not Redis-backed
production throughput. Use them for relative comparison and to spot
regressions, not absolute capacity planning.

Run locally with:

```bash
npm run bench
```

Bench files live under `tests/bench/` and are isolated in their own
vitest project so `npm test` skips them.

## Hardware / environment

- **Node:** v22.19.0
- **OS:** Windows 11 Pro (10.0.26200)
- **Vitest:** 4.1.4 (bench mode is experimental)
- **Adapter:** `createMemoryCacheAdapter()` (in-process `Map`)

Vitest bench reports `hz` (operations per second), `mean`, and
`p99`/`p999` per scenario over many samples. The `rme` column is the
relative margin of error — values above ~5% suggest noisy runs (GC
pause, OS scheduling) and the absolute numbers should be taken with a
grain of salt.

## Results

### Engine read path (`tests/bench/cache-engine.bench.ts`)

| Scenario                          |   ops/sec |  mean (ms) |   p99 (ms) |
| :-------------------------------- | --------: | ---------: | ---------: |
| `engine.get` HIT (fresh)          | 1,994,846 |     0.0005 |     0.0009 |
| `engine.get` MISS (empty cache)   | 2,062,524 |     0.0005 |     0.0009 |

Read overhead is ~2M ops/sec — fresh-hit and miss are essentially
indistinguishable on the in-memory adapter (the difference is the
single envelope inspection branch). Production Redis numbers will be
floor-bounded by RTT, not by this code.

### Engine write path

| Scenario                          |   ops/sec |  mean (ms) |   p99 (ms) |
| :-------------------------------- | --------: | ---------: | ---------: |
| `engine.set` (no tags)            |   594,603 |     0.0017 |     0.0038 |
| `engine.set` with 5 tags          |     3,333 |     0.3000 |     6.3888 |

The 5-tag write path is **~178x slower** than the no-tag path — see
"Bottlenecks" below.

### Single-flight + version bump

| Scenario                                  |   ops/sec |  mean (ms) |   p99 (ms) |
| :---------------------------------------- | --------: | ---------: | ---------: |
| `claimPending` + `resolvePending`         | 2,544,991 |     0.0004 |     0.0011 |
| `bumpModelVersion` (atomic `increment`)   |   890,470 |     0.0011 |     0.0018 |

Single-flight overhead is negligible (~400ns) — the dedup map +
`Deferred` allocation cost is well below adapter call cost. Version
bump is bound by the adapter's `increment` cost.

### Invalidation fan-out

| Scenario                                                |   ops/sec |  mean (ms) |   p99 (ms) |
| :------------------------------------------------------ | --------: | ---------: | ---------: |
| `invalidateByTags` (10 tags × 100 entries, with setup)  |       497 |     2.0104 |    11.5140 |

This bench includes the setup phase (write 100 entries with 10 tags
each) inside the loop body — the invalidate-only number would be
considerably higher. The ~2ms mean is dominated by the `set` fan-out
(~1.05M tag-index appends across the iteration). Useful as a relative
ceiling for combined "hot write storm + cleanup" latency on the
in-memory adapter.

### Key derivation (`tests/bench/cache-keys.bench.ts`)

| Scenario                                              |   ops/sec |  mean (ms) |   p99 (ms) |
| :---------------------------------------------------- | --------: | ---------: | ---------: |
| `buildCacheKey` typical params                        |   150,755 |     0.0066 |     0.0128 |
| `buildCacheKey` large filter (10-key nested)          |    32,229 |     0.0310 |     0.0849 |
| `stableStringify` typical AggRequest                  |   195,878 |     0.0051 |     0.0084 |
| `stableStringify` typical params                      |   677,847 |     0.0015 |     0.0020 |
| `stableStringify` large filter                        |   154,512 |     0.0065 |     0.0105 |
| `fnv1a64` via `buildCacheKey` (tiny params)           |   766,177 |     0.0013 |     0.0024 |
| `stableStringify` of ~200-char string                 | 5,269,737 |     0.0002 |     0.0002 |
| `extractScopeTags` filter-injected (org + user)       | 9,571,120 |     0.0001 |     0.0002 |
| `extractScopeTags` empty context                      |20,823,668 |     0.0000 |     0.0001 |
| `extractScopeTags` top-level fields fallback          |10,088,012 |     0.0001 |     0.0002 |

Key derivation runs at 150k–700k ops/sec on typical inputs. The large
filter case drops to 32k ops/sec — `stableStringify` recursion +
fnv1a64 BigInt arithmetic dominate. Scope extraction is essentially
free (10–20M ops/sec).

## Bottlenecks identified

Three observations worth noting; **none have been fixed** in this
branch — the brief was measure-only.

### 1. `engine.set` with tags is O(N²) in the per-tag index size

The `engine.set with 5 tags` bench runs ~178x slower than the no-tag
path. Two factors compound:

- **Tag-index list grows with each distinct cache key.** Every `set`
  appends the new key to each tag's list — and the list is read in
  full, copied, and rewritten on every append (`tag-index.ts`
  `appendKeyToTags`).
- **Bench writes monotonically distinct keys.** Each iteration adds
  one more entry under the same 5 tags, so the index lists grow
  linearly. By the end of the bench window each `set` is doing 5×
  reads + 5× writes of an O(N)-sized array, hence O(N²) overall.

Production hot-write workloads under a small set of tags will see
similar amplification. Mitigations to consider for a future
optimization pass: (a) cap list length and rotate, (b) use a Set on
the read side then write back, (c) Redis-backed adapters can use
`SADD` for native O(1) append, (d) accept duplicates and dedupe at
invalidate time. Out of scope here.

### 2. `buildCacheKey` is ~5x slower on large filters

A 10-key nested filter takes 31µs/op vs 6.6µs/op for a typical 3-key
filter. `stableStringify` allocates intermediate arrays per recursion
level + `Object.entries` + `.sort()` per object level. For most apps
the typical-params path (~150k ops/sec) is plenty; high-fan-out
analytics workloads on deeply nested filters may want a memoized
key-derivation layer or a flat-shape canonicalizer. Not urgent.

### 3. `fnv1a64` BigInt arithmetic costs ~1µs per ~30-char string

The hash uses 64-bit BigInt to avoid djb2's 32-bit collision birthday
problem. On a tiny input the entire `buildCacheKey` clocks at 1.3µs
(measurable bench: 766k ops/sec). About half of that is the BigInt
multiply loop. An alternative implementation using two 32-bit Number
lanes (à la xxhash32) would be faster — but the savings would be
~500ns per cache key, and at 150k ops/sec on typical params the hash
isn't the bottleneck. Not worth changing without a host workload that
actually pegs key derivation.

## Notes on running these benches

- The bench files use top-level `await` at module scope to seed
  engines because vitest 4's bench mode does **not** execute
  `beforeAll` / `beforeEach` hooks. Don't add hooks back without
  verifying they fire in your vitest version.
- The invalidation bench re-primes its adapter inside the bench body.
  That overstates the per-op cost; subtract the `engine.set with 5
  tags` mean × 100 to estimate the invalidate-only cost.
- Numbers are noisier than `vitest run` tests — RME above 5% is
  expected for small bench bodies on Windows. Run the suite a few
  times before comparing; trends matter more than single-run
  absolutes.
