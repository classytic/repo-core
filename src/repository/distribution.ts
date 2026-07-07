/**
 * Distribution-key awareness — the lean, industry-standard slice of
 * "sharding support" that belongs in an access layer.
 *
 * Sharding and partitioning themselves are DATABASE features (Mongo
 * `sh.shardCollection`, Postgres declarative partitioning / pg_partman /
 * TimescaleDB hypertables) — repo-core deliberately does NOT reimplement
 * routing, rebalancing, or partition DDL. What the access layer CAN do is
 * catch the classic production regression: a query that omits the
 * shard/partition key and silently degrades to a scatter-gather (Mongo)
 * or full-partition scan (Postgres) at 100× the cost.
 *
 * A kit (or host) declares the repo's distribution key once; the guard
 * inspects each filter and reports whether the key is present. Kits wire
 * it as a dev-time warning (default) or a hard throw for strict hosts.
 *
 * Multi-tenant note: when the tenant field IS the shard key (the common
 * design — tenant-prefixed shard keys / tenant-hash partitions), kits with
 * tenant-scope injection already guarantee the key on every query; the
 * guard then only fires on `bypassTenant` escape hatches — exactly the
 * calls that deserve scrutiny.
 */

import { isFilter } from '../filter/guard.js';
import { collectFields } from '../filter/walk.js';
import type { FilterInput } from './types.js';

/** Per-repo declaration of how the underlying table/collection is distributed. */
export interface DistributionConfig {
  /**
   * The shard key (Mongo) / partition key (Postgres, Timescale) / primary
   * access dimension. Filters that omit this field fan out across every
   * shard/partition.
   */
  key: string;
  /**
   * What to do when a filter misses the key:
   *   - `'warn'`  (default) — invoke `onMiss` (kits default it to a
   *     once-per-operation console warning outside production).
   *   - `'throw'` — reject the operation; for hosts where scatter-gather
   *     is never acceptable.
   *   - `'off'`   — declaration only (still surfaced via metadata).
   */
  onMissingKey?: 'warn' | 'throw' | 'off';
  /**
   * Operations exempt from the check. `getById` and other primary-key
   * lookups never carry the filter, so kits only guard the filter-taking
   * verbs; list verbs a host legitimately runs cross-shard here
   * (e.g. `'aggregate'` for global dashboards).
   */
  exemptOperations?: readonly string[];
}

/**
 * Returns true when `filter` references the distribution key anywhere in
 * the tree (Filter IR or raw record, including `$and`/`$or`/`AND`/`OR`
 * branches). A key inside an `$or` still bounds the fan-out on Mongo and
 * prunes partitions on Postgres, so it counts.
 */
export function filterReferencesKey(filter: FilterInput | undefined, key: string): boolean {
  if (!filter) return false;
  if (isFilter(filter)) return collectFields(filter).includes(key);
  return recordReferencesKey(filter as Record<string, unknown>, key);
}

function recordReferencesKey(record: Record<string, unknown>, key: string): boolean {
  for (const [field, value] of Object.entries(record)) {
    if (field === key) return true;
    // Logical branches — Mongo ($and/$or/$nor/$not) and Prisma (AND/OR/NOT).
    if (/^(\$and|\$or|\$nor|AND|OR)$/.test(field) && Array.isArray(value)) {
      if (value.some((child) => recordReferencesKey(child as Record<string, unknown>, key))) {
        return true;
      }
      continue;
    }
    if (/^(\$not|NOT)$/.test(field) && value && typeof value === 'object') {
      if (recordReferencesKey(value as Record<string, unknown>, key)) return true;
    }
  }
  return false;
}

/** Callback invoked when a guarded operation misses the distribution key. */
export type DistributionMissHandler = (info: { operation: string; key: string }) => void;

/**
 * Build a checker kits call at the top of each filter-taking verb.
 * Stateless and allocation-free on the hit path; `onMiss` fires at most
 * once per operation name per guard instance to keep logs readable.
 */
export function createDistributionGuard(
  config: DistributionConfig,
  onMiss?: DistributionMissHandler,
): (operation: string, filter: FilterInput | undefined) => void {
  const mode = config.onMissingKey ?? 'warn';
  const exempt = new Set(config.exemptOperations ?? []);
  const warned = new Set<string>();

  return (operation, filter) => {
    if (mode === 'off' || exempt.has(operation)) return;
    if (filterReferencesKey(filter, config.key)) return;

    if (mode === 'throw') {
      throw new Error(
        `Distribution guard: ${operation} filter omits the distribution key ` +
          `"${config.key}" — this fans out across every shard/partition. ` +
          `Include the key, exempt the operation, or set onMissingKey: 'off'.`,
      );
    }

    if (!warned.has(operation)) {
      warned.add(operation);
      onMiss?.({ operation, key: config.key });
    }
  };
}
