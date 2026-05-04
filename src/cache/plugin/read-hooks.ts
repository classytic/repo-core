/**
 * Read-side hook registration: `before:<op>` (cache check + single-
 * flight claim), `after:<op>` (cache write + resolve waiters), and
 * `error:<op>` (reject waiters fail-fast).
 *
 * All three hooks coordinate via typed slots on the shared context bag
 * (see `./context.ts`). The kit's read method short-circuits when
 * `_cacheHit === true` via `RepositoryBase._cachedValue<T>(context)`.
 */

import { HOOK_PRIORITY } from '../../hooks/priority.js';
import type { RepositoryBase } from '../../repository/base.js';
import type { CacheEngine } from '../engine.js';
import { buildCacheKey, extractScopeTags, mergeTags, scopeKeyFromTags } from '../keys.js';
import type { CacheOptions } from '../options.js';
import { resolveCacheOptions } from '../options.js';
import { ctx, extractCallCacheOptions, extractShapeFields } from './context.js';
import type { LogCallbacks } from './index.js';
import { scheduleSwrRefresh } from './swr.js';

export interface ReadHookContext {
  defaults: Partial<CacheOptions> | undefined;
  perOpDefaults: Partial<CacheOptions> | undefined;
  autoTagsFromScope: boolean;
  log: LogCallbacks;
  prefix: string;
  repo: RepositoryBase;
  shapeKeysByOp: Readonly<Record<string, readonly string[]>>;
}

export function registerReadHooks(
  repo: RepositoryBase,
  op: string,
  engine: CacheEngine,
  hookCtx: ReadHookContext,
): void {
  // before:<op> — cache check, then single-flight claim on miss
  repo.on(`before:${op}`, registerBefore(op, engine, hookCtx), {
    priority: HOOK_PRIORITY.CACHE,
  });

  // after:<op> — write fresh result + resolve waiters; or schedule SWR refresh
  repo.on(`after:${op}`, registerAfter(op, engine, hookCtx), {
    priority: HOOK_PRIORITY.CACHE,
  });

  // error:<op> — reject single-flight waiters fail-fast
  repo.on(`error:${op}`, registerError(engine), {
    priority: HOOK_PRIORITY.CACHE,
  });
}

// ──────────────────────────────────────────────────────────────────────
// before:<op>
// ──────────────────────────────────────────────────────────────────────

function registerBefore(op: string, engine: CacheEngine, hookCtx: ReadHookContext) {
  return async (rawContext: unknown): Promise<void> => {
    const context = ctx(rawContext);
    const callOpts = extractCallCacheOptions(context, op);
    const resolved = resolveCacheOptions(callOpts, hookCtx.perOpDefaults, hookCtx.defaults);
    if (!resolved.enabled) return;

    const scopeTags = hookCtx.autoTagsFromScope ? extractScopeTags(context) : [];
    const allTags = mergeTags(resolved.tags, scopeTags);
    const key = resolved.key ?? (await deriveKey(engine, op, context, scopeTags, hookCtx));

    // Stash for after:<op> so we don't re-derive the key / re-resolve options.
    context._cacheKey = key;
    context._cacheResolved = { ...resolved, tags: allTags };

    const result = await engine.get<unknown>(key, resolved);
    if (result.status === 'fresh' || result.status === 'stale') {
      context._cacheHit = true;
      context._cachedResult = result.data;
      context._cacheStatus = result.status;
      if (result.status === 'fresh') {
        hookCtx.log.onHit?.(key, op, result.age ?? 0);
      } else {
        hookCtx.log.onStale?.(key, op, result.age ?? 0);
      }
      return;
    }

    hookCtx.log.onMiss?.(key, op);
    if (resolved.bypass) return;

    // Single-flight: dedupe concurrent misses for the same key. The
    // first caller "claims" the slot; subsequent callers "wait" on
    // its promise and inherit the result.
    const claim = engine.claimPending(key);
    if (claim.status === 'wait') {
      try {
        const data = await claim.promise;
        context._cacheHit = true;
        context._cachedResult = data;
        context._cacheStatus = 'fresh';
        context._cacheCoalesced = true;
        hookCtx.log.onCoalesce?.(key, op);
      } catch {
        // First claimer failed — fall through and run the executor
        // inline. Caller decides whether to retry on a higher level.
      }
    }
    // status === 'claimed' → caller owns the fetch; after-hook resolves.
  };
}

// ──────────────────────────────────────────────────────────────────────
// after:<op>
// ──────────────────────────────────────────────────────────────────────

function registerAfter(op: string, engine: CacheEngine, hookCtx: ReadHookContext) {
  return async (rawPayload: unknown): Promise<void> => {
    const payload = rawPayload as { context: unknown; result: unknown };
    const context = ctx(payload.context);

    // Stale hit (SWR): kit served stale; schedule a background refresh.
    // No write here — the result IS the stale cached value.
    if (context._cacheHit === true && context._cacheStatus === 'stale') {
      scheduleSwrRefresh(op, hookCtx.repo, context);
      return;
    }
    // Fresh hit (real OR coalesced via single-flight): no write.
    if (context._cacheHit === true && context._cacheStatus === 'fresh') return;

    const key = context._cacheKey;
    const resolved = context._cacheResolved;
    if (!key || !resolved) return;

    // Write the fresh result + resolve any single-flight waiters.
    await engine.set(key, payload.result, resolved);
    engine.resolvePending(key, payload.result);
    hookCtx.log.onWrite?.(key, op, resolved.tags);
  };
}

// ──────────────────────────────────────────────────────────────────────
// error:<op>
// ──────────────────────────────────────────────────────────────────────

function registerError(engine: CacheEngine) {
  return async (rawPayload: unknown): Promise<void> => {
    const payload = rawPayload as { context: unknown; error: unknown };
    const context = ctx(payload.context);
    const key = context._cacheKey;
    if (!key) return;
    engine.rejectPending(key, payload.error);
  };
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

async function deriveKey(
  engine: CacheEngine,
  op: string,
  context: ReturnType<typeof ctx>,
  scopeTags: readonly string[],
  hookCtx: ReadHookContext,
): Promise<string> {
  const model = (context['model'] as string) ?? 'unknown';
  // Per-scope version — pairs with per-scope bump on writes so a write
  // in `org:abc` doesn't invalidate `org:xyz`'s cached reads.
  const scopeKey = scopeKeyFromTags(scopeTags);
  const version = await engine.getVersion(model, scopeKey);
  const params = extractShapeFields(context, op, hookCtx.shapeKeysByOp);
  return buildCacheKey({
    prefix: engine.keyPrefix,
    operation: op,
    model,
    version,
    params: params ?? {},
    scopeTags,
  });
}
