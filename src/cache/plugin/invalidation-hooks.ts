/**
 * Write-side hook registration: `after:<op>` for every mutating op
 * bumps the model's version (per-scope when possible) and invalidates
 * the model-tag.
 *
 * **Targeted invalidation (TanStack `exact: true` semantic).** Writes
 * inside `org:abc` bump only that scope's version key, leaving
 * `org:xyz`'s cached reads hot. Falls back to a global bump when no
 * scope is present (single-tenant apps, public reads).
 *
 * **Cross-cutting tag invalidation runs alongside.** Hosts who tag
 * aggregations with the model name (default behavior — `'<model>'` is
 * always included) get implicit invalidation when any write to the
 * model lands, including writes in OTHER resources that auto-invalidate
 * by tag.
 */

import { HOOK_PRIORITY } from '../../hooks/priority.js';
import type { RepositoryBase } from '../../repository/base.js';
import type { CacheEngine } from '../engine.js';
import { extractScopeTags, mergeTags, scopeKeyFromTags } from '../keys.js';
import { ctx } from './context.js';
import type { LogCallbacks } from './index.js';

export interface InvalidationHookContext {
  autoTagsFromScope: boolean;
  log: LogCallbacks;
}

export function registerInvalidationHooks(
  repo: RepositoryBase,
  op: string,
  engine: CacheEngine,
  hookCtx: InvalidationHookContext,
): void {
  repo.on(
    `after:${op}`,
    async (rawPayload: unknown): Promise<void> => {
      const payload = rawPayload as { context: unknown };
      const context = ctx(payload.context);
      const model = context['model'] as string;
      if (!model) return;

      const scopeTags = hookCtx.autoTagsFromScope ? extractScopeTags(context) : [];
      const scopeKey = scopeKeyFromTags(scopeTags);
      const version = await engine.bumpVersion(model, scopeKey);

      // Tag-side-index invalidation runs ALONGSIDE the version bump:
      //   - `<model>` tag — cross-model aggregations that referenced it
      //   - scope tags    — `org:abc`-scoped cross-cutting groups
      const tagsToInvalidate = mergeTags([model], scopeTags);
      const count = await engine.invalidateByTags(tagsToInvalidate);
      hookCtx.log.onInvalidate?.(model, version, count);
    },
    { priority: HOOK_PRIORITY.CACHE },
  );
}
