/**
 * Hook system types.
 *
 * The hook engine sits on every `RepositoryBase` instance. Plugins register
 * `before:op` / `after:op` / `error:op` listeners with a priority; the
 * engine runs them in sorted order. Priorities are the coordination
 * mechanism that lets multi-tenant scope inject before cache lookup (so
 * tenant ID makes it into the cache key) — see `HOOK_PRIORITY`.
 */

/**
 * Hook listener signature. The data argument's shape depends on the event
 * phase:
 *   - `before:*` → `RepositoryContext` (mutate to inject filters, data, etc.)
 *   - `after:*`  → `{ context, result }`
 *   - `error:*`  → `{ context, error }`
 *
 * Listeners may be sync or async. The engine awaits async listeners in
 * priority order.
 */
export type HookListener<TData = unknown> = (data: TData) => void | Promise<void>;

/**
 * Execution mode for event emission. `async` awaits every listener before
 * returning (default — plugins rely on this to mutate context synchronously
 * from the caller's perspective). `sync` runs listeners but doesn't await;
 * fire-and-forget telemetry can use it.
 */
export type HookMode = 'async' | 'sync';

/** A hook entry in the priority-sorted registry. */
export interface PrioritizedHook {
  readonly listener: HookListener;
  readonly priority: number;
}

/** Event phase discriminator for hook names. */
export type EventPhase = 'before' | 'after' | 'error';
