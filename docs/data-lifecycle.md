# Data lifecycle at scale — the classytic runbook

How the `@classytic/*` kit ecosystem handles data that grows toward billions of rows: what the repository layer gives you, what the DATABASE must own, and the industry-standard play per backend.

**The division of labor (read this first):**

| Concern | Owner | Why |
|---|---|---|
| Retention / TTL | Kit + DB-native | Mongo TTL indexes and sweeper plugins are declarative and cheap |
| Cleanup (tenant/GDPR) | Kit — `purgeByField` | Chunked, resumable, audit-composed |
| Archive to cold storage | Kit — `archiveByFilter` | Write-before-delete, portable across backends |
| Big scans / ETL | Kit — `cursor()` | Keyset batches, constant memory |
| Sharding / partitioning | **Database** | Routing + rebalancing + partition DDL belong to Mongo/Postgres, not an access layer |
| Shard/partition-key hygiene | Kit — `distribution` guard | The one access-layer slice of sharding that matters |
| Backup / PITR | **Ops** (except SQLite) | mongodump/Atlas snapshots, WAL archiving; SQLite is app-owned so sqlitekit ships `createBackup` |

The repository layer's job at scale is to **not get in the way** (keyset pagination, chunked writes, streaming reads, index-backed predicates) and to **keep tables from growing unboundedly** (TTL, purge, archive). It deliberately does NOT reimplement what databases do better.

---

## The portable primitives (every kit, one contract)

### `archiveByFilter(filter, sink, options)` — move cold rows out of the hot table

```ts
// Nightly job: archive orders older than 18 months to an archive collection/table
const cutoff = new Date(Date.now() - 18 * 30 * 24 * 3600 * 1000).toISOString();

const result = await orders.archiveByFilter(
  { createdAt: { $lt: cutoff } },
  {
    // Sink = anywhere writable. MUST tolerate duplicates (upsert by id):
    // the orchestrator is at-least-once — write-before-delete means a
    // crash re-archives a chunk rather than losing it.
    write: (docs) => archiveOrders.bulkUpsert(docs),
    flush: () => manifest.commit(),        // optional, fires once on success
  },
  { batchSize: 1000, onProgress: (p) => log.info(p), retry: { maxAttempts: 3 } },
);
// → { processed, ok, durationMs, error?: { phase: 'read'|'sink'|'delete' } }
// A 'sink' failure guarantees the rows are still in the hot table.
```

Rules that make it safe at scale:

- **Index the filter's leading field(s).** Same rule as purge — without it every chunk re-scans the table.
- **Sinks are duplicate-tolerant** (upsert by primary key, or dedup on load). Exactly-once across two stores would need a distributed transaction; nobody ships that for archival, and neither do we.
- **Don't archive what you can drop.** On partitioned Postgres/Timescale, detaching a partition archives a billion rows in O(1) — see the Postgres section.

### `cursor(filter, { batchSize, sort })` — scans that never load the table

```ts
for await (const doc of repo.cursor({ status: 'active' }, { batchSize: 1000 })) {
  await exportLine(doc);   // ETL, backfills, report generation
}
```

Keyset-progressed (PK tie-break) on SQL kits, native driver cursor on Mongo. Non-snapshot semantics: rows inserted behind the iteration point aren't revisited.

### `purgeByField(field, value, strategy)` — tenant/GDPR cleanup (existing)

Chunked hard/soft/anonymize/skip with retry, abort, progress. Pair `soft` with TTL for recoverable deletes inside audit windows.

### `distribution` — declare the shard/partition key, catch scatter-gather

```ts
const repo = createRepository({ db, table: events, distribution: { key: 'tenantId' } });
// dev: warns once per operation whose filter omits tenantId
// strict hosts: { onMissingKey: 'throw' }
// global dashboards: { exemptOperations: ['aggregate'] }
```

When the tenant field IS the shard key (the common design), kits with tenant-scope injection already stamp it on every query — the guard then only fires on `bypassTenant` escape hatches, which is exactly where scrutiny belongs. Wired in pgkit + prismakit today; mongokit/sqlitekit hosts get the same via their multi-tenant plugins or `createDistributionGuard` directly.

---

## Per-backend playbook

### MongoDB (mongokit)

- **Shard at the cluster** (`sh.shardCollection`) once a collection heads past ~1–2 TB or write throughput saturates one primary. Pick the shard key ONCE and well: high-cardinality, present in nearly every query — for multi-tenant apps, `{ tenantId: 1, _id: 1 }` (or hashed tenant) so mongokit's tenant plugin automatically makes every query shard-targeted.
- **Retention**: TTL indexes are free — `softDeletePlugin({ ttlDays })`, `auditTrailPlugin({ ttlDays })`, or a plain `expireAfterSeconds` index on event tables. Mongo's TTL monitor deletes in the background; no job to run.
- **Archive**: `archiveByFilter` into an archive collection or object storage; on Atlas, Online Archive does the same declaratively for time-series data.
- **Never `deleteMany` a large tenant unchunked** — oplog blowup + replication lag. That's what `purgeByField` exists for.
- **Backup**: Atlas continuous backups / `mongodump` + oplog — ops-plane, not app code.

### PostgreSQL (pgkit)

- **Partition time-keyed big tables** (`PARTITION BY RANGE (created_at)`) and let **pg_partman** or **TimescaleDB** (see the `postgres` skill installed in pgkit) create/drop partitions on schedule. **Dropping a partition is the only sane way to delete a billion rows** — O(1), no vacuum debt, no bloat. Timescale adds compression (10–20×) and native retention policies.
- Use `archiveByFilter` for non-partitioned tables and portable code; use partition detach for partitioned ones — the method's docstring says the same.
- **Bloat hygiene**: chunked deletes (purge/archive) leave dead tuples; autovacuum handles steady-state, but after a huge purge consider `VACUUM (ANALYZE)` off-hours. Partition drops sidestep this entirely.
- **Backup**: WAL archiving + base backups (PITR) or managed-DB snapshots — ops-plane.

### SQLite (sqlitekit)

- SQLite scales by **splitting files, not sharding**: file-per-tenant is the industry pattern (and pairs perfectly with `distribution`-free design — each tenant IS a database).
- **Retention**: `ttlPlugin` (scheduled sweep / insert trigger / lazy filter) + `sweepExpired()` on a cron.
- **Space**: `vacuumPlugin` (incremental mode for online reclaim) after heavy TTL/purge/archive churn.
- **Backup**: `createBackup()` (better-sqlite3 online backup API) — the one backend where backup is legitimately app-layer, because the app owns the file. Litestream/Turso replication for continuous protection.

### Prisma (prismakit)

- Same rules as the underlying database (Postgres/MySQL rules on Prisma 7; Mongo rules on Prisma 6.19). `archiveByFilter` / `cursor` / `distribution` work identically — they compile to delegate calls.
- Partition management is still DDL — Prisma migrations can carry pg_partman setup SQL, but the retention schedule lives in the database/cron, not the client.

---

## Sizing quick reference

| Knob | Default | Raise when | Lower when |
|---|---|---|---|
| `batchSize` (purge/archive) | 1000 | narrow rows, quiet system | wide docs/blobs, rate-limited sink, hot OLTP table |
| `cursor` batchSize | ~100–1000 (kit) | pure ETL throughput | per-row work is slow (don't hold huge batches) |
| retry | off | transient-prone infra (serverless PG, busy SQLite) | never for validation errors — `shouldRetry` narrow |

**The one invariant to remember:** every lifecycle operation in this ecosystem is *chunked, resumable, and at-least-once*. Design sinks and handlers to tolerate a repeated chunk, and you can kill/retry any job at any point without data loss.
