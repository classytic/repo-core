/**
 * Stale-while-revalidate background-refresh scheduler.
 *
 * When `before:<op>` returns a STALE hit (with `swr: true`), the kit
 * serves the stale value to the caller and `after:<op>` schedules a
 * fresh fetch via this helper. The fresh fetch goes through the same
 * cache plugin (with `bypass: true`), so single-flight dedup works
 * naturally — N concurrent stale hits dedupe to ONE refresh.
 *
 * **Cross-runtime scheduling.** Uses `scheduleBackground` from
 * `../runtime.js`, which picks `setImmediate` (Node / Bun) or
 * `setTimeout(0)` (Workers / Deno / browser). Either way the callback
 * fires AFTER the current sync block + microtask queue, so the user's
 * HTTP response writes to the socket BEFORE the bg fetch's first await.
 *
 * **Op coverage.** Aggregate ops (`aggregate`, `aggregatePaginate`)
 * have a single-arg call signature (`req: AggRequest`) so we can
 * cleanly construct a refresh request. CRUD ops with multi-arg
 * signatures (`getById(id, options)`) would need per-op dispatch —
 * deferred until a real CRUD-SWR use case appears. Stale CRUD reads
 * fall back to "next call after gcTime expires refetches inline."
 */

import type { RepositoryBase } from '../../repository/base.js';
import type { CacheOptions } from '../options.js';
import { scheduleBackground } from '../runtime.js';
import { AGGREGATE_OPS, type AnyContext } from './context.js';

export function scheduleSwrRefresh(op: string, repo: RepositoryBase, context: AnyContext): void {
  if (!AGGREGATE_OPS.has(op)) return;
  const aggReq = context['aggRequest'] as
    | { cache?: CacheOptions; [k: string]: unknown }
    | undefined;
  if (!aggReq) return;
  const refreshReq = {
    ...aggReq,
    cache: { ...(aggReq.cache ?? {}), bypass: true },
  };
  scheduleBackground(() => {
    void (repo as unknown as Record<string, (r: unknown) => Promise<unknown>>)
      [op]?.(refreshReq)
      .catch(() => {
        // Background-refresh failures stay silent — the cache will
        // eventually expire and the next request will refetch inline.
      });
  });
}
